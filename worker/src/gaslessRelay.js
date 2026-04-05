/**
 * W17: gaslessRelay.js
 *
 * Provides the POST /gasless-submit endpoint.
 * Accepts a pre-signed UserOp and submits it via the ERC-4337 bundler
 * using @aastar/enduser UserClient.
 *
 * If the SDK import fails or the bundler rejects the UserOp, the endpoint
 * returns a graceful 503 — the worker never crashes due to this module.
 *
 * Env vars:
 *   BUNDLER_URL   — ERC-4337 bundler RPC (Alchemy / Pimlico / etc.)
 *   PAYMASTER_URL — paymaster service URL
 *   CHAIN_ID      — already read by index.js; passed in via options
 */

// Lazy-loaded SDK reference. Resolved on first request, not at module load time,
// so a missing SDK path never prevents the worker from starting.
let _endUserClientResult = undefined; // undefined = not yet tried; null = failed; Class = ok

async function _loadEndUserClient() {
  if (_endUserClientResult !== undefined) return _endUserClientResult;
  try {
    const mod = await import(
      "/Users/jason/Dev/mycelium/my-exploration/projects/aastar-sdk/packages/enduser/dist/UserClient.js"
    );
    const cls = mod.UserClient ?? null;
    _endUserClientResult = cls;
    return cls;
  } catch {
    _endUserClientResult = null;
    return null;
  }
}

/**
 * Handle POST /gasless-submit
 *
 * Request body (JSON):
 *   itemId          string | number   — the item being purchased
 *   buyerAddress    string            — AA wallet address (sender of UserOp)
 *   quantity        string | number
 *   userOpSignature string            — hex signature from buyer's AA wallet
 *   calldata        string            — ABI-encoded buyGasless() calldata
 *
 * Response:
 *   200 { ok: true, userOpHash, status: "submitted" }
 *   503 { ok: false, error: "gasless relay unavailable", details }
 *   400 { ok: false, error: "...", errorCode: "..." }
 */
export async function handleGaslessSubmit(req, res, { chainId, bundlerUrl, paymasterUrl }) {
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
    return jsonResp(400, { ok: false, error: "Invalid JSON body", errorCode: "invalid_body" });
  }

  const { itemId, buyerAddress, quantity, userOpSignature, calldata } = body ?? {};

  // Validate required fields
  if (!itemId) return jsonResp(400, { ok: false, error: "Missing: itemId", errorCode: "missing_param" });
  if (!buyerAddress) return jsonResp(400, { ok: false, error: "Missing: buyerAddress", errorCode: "missing_param" });
  if (!quantity) return jsonResp(400, { ok: false, error: "Missing: quantity", errorCode: "missing_param" });
  if (!userOpSignature) return jsonResp(400, { ok: false, error: "Missing: userOpSignature", errorCode: "missing_param" });
  if (!calldata) return jsonResp(400, { ok: false, error: "Missing: calldata", errorCode: "missing_param" });

  if (!bundlerUrl) {
    return jsonResp(503, {
      ok: false,
      error: "gasless relay unavailable",
      details: "BUNDLER_URL not configured"
    });
  }

  // Attempt to load SDK
  const UserClient = await _loadEndUserClient();
  if (!UserClient) {
    return jsonResp(503, {
      ok: false,
      error: "gasless relay unavailable",
      details: "EndUserClient SDK not available"
    });
  }

  // Submit via bundler
  try {
    const { createPublicClient, http: httpTransport } = await import("viem");

    const chain = {
      id: chainId,
      name: "custom",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [bundlerUrl] } }
    };

    const publicClient = createPublicClient({
      chain,
      transport: httpTransport(bundlerUrl)
    });

    // Build a minimal UserOp for submission via eth_sendUserOperation.
    // The calldata comes from /gasless-permit; userOpSignature is provided by the buyer's AA wallet.
    // Gas limits are set to 0 so the bundler can fill them via eth_estimateUserOperationGas.
    const userOp = {
      sender: buyerAddress,
      nonce: "0x0",
      callData: calldata,
      signature: userOpSignature,
      callGasLimit: "0x0",
      verificationGasLimit: "0x0",
      preVerificationGas: "0x0",
      maxFeePerGas: "0x0",
      maxPriorityFeePerGas: "0x0",
      ...(paymasterUrl ? { paymasterAndData: paymasterUrl } : {})
    };

    // ERC-4337 EntryPoint v0.7
    const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
    const userOpHash = await publicClient.request({
      method: "eth_sendUserOperation",
      params: [userOp, ENTRY_POINT]
    });

    return jsonResp(200, {
      ok: true,
      userOpHash,
      status: "submitted",
      itemId: String(itemId),
      buyerAddress,
      quantity: String(quantity)
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Treat any submission error as a relay-level failure; never crash the server
    return jsonResp(503, {
      ok: false,
      error: "gasless relay unavailable",
      details: msg
    });
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
