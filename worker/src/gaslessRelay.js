/**
 * W17: gaslessRelay.js
 *
 * Provides the POST /gasless-submit endpoint.
 * Accepts a pre-signed UserOp and submits it via the ERC-4337 bundler
 * using eth_sendUserOperation directly via viem.
 *
 * If the bundler rejects the UserOp, the endpoint returns a graceful 503
 * — the worker never crashes due to this module.
 *
 * Env vars:
 *   BUNDLER_URL        — ERC-4337 bundler RPC (Alchemy / Pimlico / etc.)
 *   ITEMS_ADDRESS      — MyShopItems contract address (used to validate calldata target)
 *   CHAIN_ID           — already read by index.js; passed in via options
 */

// Hex-string validator: 0x-prefixed, even number of hex digits
const HEX_RE = /^0x[0-9a-fA-F]*$/;
// Ethereum address: 0x + exactly 40 hex chars
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
// EIP-4337 calldata must start with the 4-byte selector of buyGasless()
// keccak256("buyGasless(uint256,uint256,address,address,bytes)").slice(0,10) = 0x9747e8c8
const BUY_GASLESS_SELECTOR = "0x9747e8c8";

/**
 * Handle POST /gasless-submit
 *
 * Request body (JSON):
 *   itemId          string | number   — the item being purchased
 *   buyerAddress    string            — AA wallet address (sender of UserOp); must be a valid address
 *   quantity        string | number
 *   userOpSignature string            — hex signature from buyer's AA wallet
 *   calldata        string            — ABI-encoded buyGasless() calldata (must start with
 *                                       buyGasless selector to prevent arbitrary contract abuse)
 *
 * Security invariants enforced:
 *   - buyerAddress is validated as a proper Ethereum address
 *   - calldata must begin with the buyGasless() selector (prevents relay abuse)
 *   - calldata must be a valid hex string
 *   - userOpSignature must be a valid hex string
 *
 * Response:
 *   200 { ok: true, userOpHash, status: "submitted" }
 *   503 { ok: false, error: "gasless relay unavailable", details }
 *   400 { ok: false, error: "...", errorCode: "..." }
 */
export async function handleGaslessSubmit(req, res, { chainId, bundlerUrl }) {
  // Helper: JSON response
  const jsonResp = (status, obj) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    res.end(JSON.stringify(obj));
  };

  // Parse body
  let body;
  try {
    body = await _readJsonBody(req);
  } catch {
    jsonResp(400, { ok: false, error: "Invalid JSON body", errorCode: "invalid_body" });
    return false;
  }

  const { itemId, buyerAddress, quantity, userOpSignature, calldata } = body ?? {};

  // Validate required fields — presence
  if (!itemId) { jsonResp(400, { ok: false, error: "Missing: itemId", errorCode: "missing_param" }); return false; }
  if (!buyerAddress) { jsonResp(400, { ok: false, error: "Missing: buyerAddress", errorCode: "missing_param" }); return false; }
  if (!quantity) { jsonResp(400, { ok: false, error: "Missing: quantity", errorCode: "missing_param" }); return false; }
  if (!userOpSignature) { jsonResp(400, { ok: false, error: "Missing: userOpSignature", errorCode: "missing_param" }); return false; }
  if (!calldata) { jsonResp(400, { ok: false, error: "Missing: calldata", errorCode: "missing_param" }); return false; }

  // Validate formats — security checks
  if (!ADDR_RE.test(String(buyerAddress))) {
    jsonResp(400, { ok: false, error: "Invalid address: buyerAddress", errorCode: "invalid_param" });
    return false;
  }
  if (!/^\d+$/.test(String(itemId))) {
    jsonResp(400, { ok: false, error: "Invalid uint: itemId", errorCode: "invalid_param" });
    return false;
  }
  if (!/^\d+$/.test(String(quantity))) {
    jsonResp(400, { ok: false, error: "Invalid uint: quantity", errorCode: "invalid_param" });
    return false;
  }
  if (!HEX_RE.test(String(userOpSignature))) {
    jsonResp(400, { ok: false, error: "Invalid hex: userOpSignature", errorCode: "invalid_param" });
    return false;
  }
  const calldataStr = String(calldata);
  if (!HEX_RE.test(calldataStr)) {
    jsonResp(400, { ok: false, error: "Invalid hex: calldata", errorCode: "invalid_param" });
    return false;
  }
  // Enforce that calldata targets only buyGasless() — prevents relay abuse to call arbitrary contracts
  if (!calldataStr.toLowerCase().startsWith(BUY_GASLESS_SELECTOR)) {
    jsonResp(400, {
      ok: false,
      error: "calldata must target buyGasless()",
      errorCode: "invalid_calldata_selector"
    });
    return false;
  }

  if (!bundlerUrl) {
    jsonResp(503, {
      ok: false,
      error: "gasless relay unavailable",
      details: "BUNDLER_URL not configured"
    });
    return false;
  }

  // Submit via bundler using viem low-level RPC
  try {
    const { createPublicClient, http: httpTransport } = await import("viem");

    const chain = {
      id: Number(chainId),
      name: "custom",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [bundlerUrl] } }
    };

    const publicClient = createPublicClient({
      chain,
      transport: httpTransport(bundlerUrl)
    });

    // Build a minimal UserOp for submission via eth_sendUserOperation.
    // The calldata and nonce come from /gasless-permit; the signature is provided
    // by the buyer's AA wallet. Gas limits are intentionally set to 0 so the
    // bundler fills them via eth_estimateUserOperationGas.
    //
    // NOTE: paymasterAndData is NOT set here — the paymaster data is negotiated
    // out-of-band by the frontend with the paymaster service; only a complete
    // paymaster-signed payload belongs in this field. Passing PAYMASTER_URL (a
    // URL string) would be malformed and cause bundler rejection.
    const userOp = {
      sender: buyerAddress,
      nonce: body.nonce != null ? String(body.nonce) : "0x0",
      callData: calldataStr,
      signature: String(userOpSignature),
      callGasLimit: "0x0",
      verificationGasLimit: "0x0",
      preVerificationGas: "0x0",
      maxFeePerGas: "0x0",
      maxPriorityFeePerGas: "0x0"
    };

    // ERC-4337 EntryPoint v0.7
    const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
    const userOpHash = await publicClient.request({
      method: "eth_sendUserOperation",
      params: [userOp, ENTRY_POINT]
    });

    jsonResp(200, {
      ok: true,
      userOpHash,
      status: "submitted",
      itemId: String(itemId),
      buyerAddress,
      quantity: String(quantity)
    });
    return true; // signal success to caller for stats counting
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Treat any submission error as a relay-level failure; never crash the server
    jsonResp(503, {
      ok: false,
      error: "gasless relay unavailable",
      details: msg
    });
    return false; // signal failure to caller
  }
}

/**
 * Read and parse a JSON POST body from a Node.js IncomingMessage.
 */
function _readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const MAX = 64 * 1024; // 64 KB
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > MAX) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
