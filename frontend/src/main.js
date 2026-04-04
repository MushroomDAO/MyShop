import { createPublicClient, createWalletClient, custom, decodeEventLog, getAddress, http, isAddress, parseAbiItem, parseEther, encodeAbiParameters } from "viem";

import { loadConfig } from "./config.js";
import {
  createMyShopReadClient,
  decodeShopRolesMask,
  getDefaultShopRoleConfig,
  erc20Abi,
  myShopItemsAbi,
  myShopsAbi
} from "./contracts.js";

// F7: mobile-responsive base styles
(function injectMobileStyles() {
  const style = document.createElement("style");
  style.textContent = `
    /* F7: responsive layout */
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; padding: 8px; font-family: system-ui, sans-serif; font-size: 15px; }
    #app { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 1.3em; margin: 4px 0; }
    h2 { font-size: 1.1em; margin: 8px 0; }
    h3 { font-size: 1em; margin: 6px 0; }
    /* nav wraps on small screens */
    #app > div:first-child > div:last-child { display: flex; flex-wrap: wrap; gap: 4px; }
    a { color: #0070f3; }
    button { touch-action: manipulation; min-height: 36px; padding: 0 12px; cursor: pointer; }
    input, select, textarea { width: 100%; max-width: 480px; min-height: 36px; padding: 4px 8px; }
    .card { border: 1px solid #ddd; border-radius: 6px; padding: 12px; background: #fff; }
    .section-header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    pre#txOut { white-space: pre-wrap; word-break: break-all; font-size: 0.8em; }
    /* grids auto-collapse on mobile */
    @media (max-width: 600px) {
      body { padding: 4px; font-size: 14px; }
      button { width: 100%; margin-bottom: 4px; }
      input, select { max-width: 100%; }
    }
  `;
  document.head.appendChild(style);
})();

const envCfg = loadConfig();
const storageKey = "myshop_frontend_config_v1";

function loadStoredConfig() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveStoredConfig(nextCfg) {
  localStorage.setItem(storageKey, JSON.stringify(nextCfg));
}

function buildChain(nextCfg) {
  const rpcUrl = nextCfg.rpcUrl || "http://127.0.0.1:8545";
  return {
    id: nextCfg.chainId || 31337,
    name: "custom",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  };
}

function getRuntimeConfig() {
  const stored = loadStoredConfig();
  return {
    rpcUrl: stored.rpcUrl || envCfg.rpcUrl || "",
    chainId: stored.chainId || envCfg.chainId || 31337,
    shopsAddress: stored.shopsAddress || envCfg.shopsAddress || "",
    itemsAddress: stored.itemsAddress || envCfg.itemsAddress || "",
    itemsActionAddress: stored.itemsActionAddress || envCfg.itemsActionAddress || "",
    erc721ActionAddress: stored.erc721ActionAddress || envCfg.erc721ActionAddress || "",
    defaultTemplateId: stored.defaultTemplateId || envCfg.defaultTemplateId || "",
    workerUrl: stored.workerUrl || envCfg.workerUrl || "",
    workerApiUrl: stored.workerApiUrl || envCfg.workerApiUrl || "",
    apntsSaleUrl: stored.apntsSaleUrl || envCfg.apntsSaleUrl || "",
    gtokenSaleUrl: stored.gtokenSaleUrl || envCfg.gtokenSaleUrl || "",
    ipfsGateway: stored.ipfsGateway || envCfg.ipfsGateway || ""
  };
}

let runtimeCfg = getRuntimeConfig();
let chain = buildChain(runtimeCfg);
let publicClient = createPublicClient({
  chain,
  transport: http(runtimeCfg.rpcUrl || "http://127.0.0.1:8545")
});

let walletClient = null;
let connectedAddress = null;
let connectedChainId = null;
let walletEventsBound = false;
let activeTxLabel = null;
let lastTx = {
  label: null,
  hash: null,
  status: null,
  blockNumber: null,
  startedAtMs: null,
  submittedAtMs: null,
  confirmedAtMs: null,
  error: null
};
let buyFlow = {
  approve: { status: null, hash: null, updatedAtMs: null, error: null },
  buy: { status: null, hash: null, updatedAtMs: null, error: null },
  active: null
};
let roleConfigState = getDefaultShopRoleConfig();

function setDisabledById(id, disabled) {
  const node = document.getElementById(id);
  if (!node) return;
  node.disabled = !!disabled;
}

function setDisabledMany(ids, disabled) {
  for (const id of ids || []) setDisabledById(id, disabled);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
  return node;
}

function inputRow(label, id, placeholder = "") {
  const input = el("input", { id, placeholder });
  return el("div", {}, [el("label", { for: id, text: label }), input]);
}

function val(id) {
  const node = document.getElementById(id);
  if (!node) return "";
  return node.value.trim();
}

function setText(id, text) {
  document.getElementById(id).textContent = text;
}

function setInputValue(id, value) {
  const node = document.getElementById(id);
  if (node) node.value = String(value);
}

async function testGateways() {
  const raw = val("ipfsGateway") || runtimeCfg.ipfsGateway || "";
  const gateways = String(raw)
    .split(",")
    .map((x) => String(x).trim())
    .filter((x) => !!x);
  if (!gateways.length) {
    setText("gatewayTestOut", "未配置 IPFS_GATEWAY");
    return;
  }
  const results = [];
  for (const g of gateways) {
    const base = String(g).replace(/\/+$/, "");
    const url = `${base}/ipfs/`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(url, { mode: "no-cors", cache: "no-store", signal: controller.signal });
      clearTimeout(timeout);
      results.push({ gateway: g, status: res ? "reachable" : "unknown" });
    } catch {
      clearTimeout(timeout);
      results.push({ gateway: g, status: "unreachable" });
    }
  }
  setText("gatewayTestOut", JSON.stringify(results, null, 2));
}

function ipfsGatewayUrls(u) {
  if (!u) return [];
  const s = String(u);
  if (!s.startsWith("ipfs://")) return [s];
  const p = s.slice(7);
  const raw = String(runtimeCfg.ipfsGateway || "https://ipfs.io");
  const gateways = raw.split(",").map((x) => String(x).trim()).filter((x) => !!x);
  const unique = [];
  for (const g of gateways.length ? gateways : ["https://ipfs.io"]) {
    const base = String(g).replace(/\/+$/, "");
    const url = `${base}/ipfs/${p}`;
    if (!unique.includes(url)) unique.push(url);
  }
  return unique;
}
function formatAge(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r}s`;
}

function txStatusLabel(s) {
  if (!s) return "";
  if (s === "waiting_wallet") return "waiting wallet confirmation";
  if (s === "pending") return "pending on-chain";
  if (s === "success") return "confirmed";
  if (s === "reverted") return "reverted";
  if (s === "error") return "error";
  return String(s);
}

function updateBuyFlowPanel() {
  const panel = document.getElementById("buyFlowOut");
  if (!panel) return;
  const rows = [];
  const pushRow = (label, data) => {
    if (!data?.status && !data?.hash && !data?.error) return;
    const status = txStatusLabel(data.status);
    const age = formatAge(data.updatedAtMs);
    const hash = data.hash ? shortHex(data.hash) : "";
    const parts = [label];
    if (status) parts.push(status);
    if (hash) parts.push(`hash=${hash}`);
    if (age) parts.push(`age=${age}`);
    rows.push(parts.join(" "));
    if (data.error) rows.push(String(data.error));
  };
  pushRow("approve", buyFlow.approve);
  pushRow("buy", buyFlow.buy);
  panel.textContent = rows.join("\n");
}

function setBuyFlowStep(step, status, { hash = null, error = null } = {}) {
  if (!buyFlow[step]) return;
  buyFlow = {
    ...buyFlow,
    active: step,
    [step]: {
      status,
      hash: hash ?? buyFlow[step].hash,
      updatedAtMs: Date.now(),
      error
    }
  };
  updateBuyFlowPanel();
}

function safeJson(value) {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      return v;
    },
    2
  );
}

function updateTxPanel() {
  const panel = document.getElementById("txPanel");
  if (!panel) return;
  panel.innerHTML = "";
  if (!activeTxLabel && !lastTx?.label) return;

  const rows = [];
  if (activeTxLabel) rows.push(el("div", { text: `activeTx=${activeTxLabel}` }));
  if (lastTx?.label) rows.push(el("div", { text: `lastTxLabel=${lastTx.label}` }));
  if (lastTx?.status) {
    const age = formatAge(lastTx.startedAtMs);
    rows.push(
      el("div", {
        text: `status=${txStatusLabel(lastTx.status)}${lastTx.blockNumber ? ` block=${lastTx.blockNumber}` : ""}${
          age ? ` age=${age}` : ""
        }`
      })
    );
  }
  if (lastTx?.submittedAtMs) rows.push(el("div", { text: `submittedAge=${formatAge(lastTx.submittedAtMs)}` }));
  if (lastTx?.confirmedAtMs) rows.push(el("div", { text: `confirmedAge=${formatAge(lastTx.confirmedAtMs)}` }));
  if (lastTx?.hash) {
    const btnCopy = el("button", {
      text: "Copy Hash",
      style: "margin-left: 8px;",
      onclick: async () => {
        const text = String(lastTx.hash || "");
        try {
          if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            setText("txOut", "tx hash copied");
            return;
          }
        } catch {
        }
        setText("txOut", "copy not available; please select tx hash manually");
      }
    });
    rows.push(el("div", {}, [el("span", { text: "tx=" }), txLinkNode(lastTx.hash), btnCopy]));
  }
  if (lastTx?.error) rows.push(el("div", { style: "color: #b91c1c;", text: String(lastTx.error) }));

  const btnClear = el("button", {
    text: "Clear",
    onclick: () => {
      lastTx = {
        label: null,
        hash: null,
        status: null,
        blockNumber: null,
        startedAtMs: null,
        submittedAtMs: null,
        confirmedAtMs: null,
        error: null
      };
      updateTxPanel();
    }
  });

  const btnRefresh = el("button", {
    text: "Refresh",
    style: "margin-left: 8px;",
    onclick: () => refreshLastTxStatus().catch(showTxError)
  });

  panel.appendChild(el("div", {}, [el("h3", { text: "Tx" }), btnClear, btnRefresh, ...rows]));
}

async function refreshLastTxStatus() {
  const hash = lastTx?.hash;
  if (!hash) return;
  setText("txOut", `checking tx receipt: ${hash}`);
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const blockNumber = receipt.blockNumber != null ? String(receipt.blockNumber) : "";
    lastTx = {
      ...lastTx,
      status: receipt.status,
      blockNumber: blockNumber || null,
      confirmedAtMs: receipt.status ? Date.now() : lastTx.confirmedAtMs,
      error: null
    };
    updateTxPanel();
    setText("txOut", `tx receipt: ${hash}\nstatus=${receipt.status}${blockNumber ? ` block=${blockNumber}` : ""}`);
  } catch (e) {
    const msg = getErrorText(e);
    if (msg.toLowerCase().includes("transactionreceiptnotfound")) {
      lastTx = { ...lastTx, status: "pending" };
      updateTxPanel();
      setText("txOut", `tx still pending: ${hash}`);
      return;
    }
    throw e;
  }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isZeroAddress(addr) {
  if (!addr) return false;
  try {
    return getAddress(addr) === ZERO_ADDRESS;
  } catch {
    return String(addr).toLowerCase() === ZERO_ADDRESS;
  }
}

function shortHex(value, { head = 6, tail = 4 } = {}) {
  const s = String(value || "");
  if (!s.startsWith("0x")) return s;
  if (s.length <= 2 + head + tail) return s;
  return `${s.slice(0, 2 + head)}…${s.slice(-tail)}`;
}

function formatPayToken(payToken) {
  if (!payToken || isZeroAddress(payToken)) return "ETH";
  return shortHex(payToken);
}

function shortText(s, maxLen = 48) {
  const str = String(s || "");
  if (str.length <= maxLen) return str;
  const head = Math.max(0, Math.floor((maxLen - 3) / 2));
  const tail = Math.max(0, maxLen - 3 - head);
  return `${str.slice(0, head)}...${str.slice(str.length - tail)}`;
}

function formatItemSummary(item, { includeShopId } = {}) {
  const actionLabel = item.action && !isZeroAddress(item.action) ? shortHex(item.action) : "none";
  const nftLabel = item.nftContract && !isZeroAddress(item.nftContract) ? shortHex(item.nftContract) : "none";
  const tokenUriLabel = item.tokenURI ? shortText(item.tokenURI, 36) : "";
  const shopPart = includeShopId ? ` shopId=${item.shopId}` : "";
  const tokenUriPart = tokenUriLabel ? ` tokenURI=${tokenUriLabel}` : "";
  return ` src=${item.__source || ""}${shopPart} active=${item.active} payToken=${formatPayToken(item.payToken)} unitPrice=${item.unitPrice} requiresSerial=${item.requiresSerial} soulbound=${item.soulbound} action=${actionLabel} nft=${nftLabel}${tokenUriPart}`;
}

function sourceCountsLabel(list, getSource) {
  const counts = new Map();
  for (const it of list || []) {
    const s = String(getSource(it) || "unknown");
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  const keys = Array.from(counts.keys()).sort();
  return keys.map((k) => `${k}=${counts.get(k)}`).join(" ");
}

function explorerBaseUrl(chainId) {
  const id = Number(chainId);
  if (id === 1) return "https://etherscan.io";
  if (id === 11155111) return "https://sepolia.etherscan.io";
  if (id === 137) return "https://polygonscan.com";
  if (id === 80001) return "https://mumbai.polygonscan.com";
  if (id === 10) return "https://optimistic.etherscan.io";
  if (id === 42161) return "https://arbiscan.io";
  if (id === 8453) return "https://basescan.org";
  return null;
}

function txLinkNode(txHash) {
  const base = explorerBaseUrl(chain?.id);
  if (!base || !txHash) return el("span", { text: String(txHash || "") });
  return el("a", { href: `${base}/tx/${txHash}`, target: "_blank", rel: "noreferrer", text: shortHex(txHash) });
}

function addressNode(addr) {
  if (!addr) return el("span", { text: "" });
  const base = explorerBaseUrl(chain?.id);
  if (!base || !String(addr).startsWith("0x")) return el("span", { text: String(addr) });
  return el("a", { href: `${base}/address/${addr}`, target: "_blank", rel: "noreferrer", text: shortHex(addr) });
}

function kv(label, valueNodeOrText) {
  const valueNode =
    valueNodeOrText && typeof valueNodeOrText === "object" && valueNodeOrText.nodeType
      ? valueNodeOrText
      : el("span", { text: String(valueNodeOrText ?? "") });
  return el("div", {}, [el("span", { text: `${label}: ` }), valueNode]);
}

class ApiError extends Error {
  constructor(message, { status, errorCode, errorDetails, url, retryAfterMs } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status ?? null;
    this.errorCode = errorCode ?? null;
    this.errorDetails = errorDetails ?? null;
    this.url = url ?? null;
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

function getErrorText(e) {
  const parts = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (!s) return;
    if (parts.includes(s)) return;
    parts.push(s);
  };

  if (e && typeof e === "object") {
    if ("shortMessage" in e) push(e.shortMessage);
    if ("details" in e) push(e.details);
  }
  if (e instanceof Error) push(e.message);
  if (e && typeof e === "object" && "cause" in e) {
    const c = e.cause;
    if (c instanceof Error) push(c.message);
    if (c && typeof c === "object") {
      if ("shortMessage" in c) push(c.shortMessage);
      if ("details" in c) push(c.details);
    }
  }
  if (parts.length === 0) push(e);
  return parts.join(" | ");
}

function formatError(e) {
  const msg = getErrorText(e);

  if (e instanceof ApiError) {
    const code = e.errorCode || "api_error";
    if (code === "deadline_expired") return `[${code}] permit deadline must be in the future\nFix: set deadline(ts) to a future time, then refetch permit`;
    if (code === "missing_param") return `[${code}] missing param: ${e.errorDetails?.param || "unknown"}\nFix: fill the missing field and retry`;
    if (code === "invalid_param") return `[${code}] invalid param: ${e.errorDetails?.param || "unknown"}\nFix: correct the value format and retry`;
    if (code === "rate_limited")
      return `[${code}] too many requests\nFix: wait ${Math.max(1, Math.ceil(Number(e.retryAfterMs || 0) / 1000))}s and retry; reduce polling; consider switching data source to chain`;
    if (code === "signer_not_configured") return `[${code}] permit signer not configured on server\nFix: configure WORKER_URL signer env and redeploy worker`;
    if (code === "serial_issuer_error") return `[${code}] serial issuer error\nFix: retry; if persists, check worker logs and signer health`;
    if (code === "method_not_allowed") return `[${code}] method not allowed`;
    if (code === "invalid_response") return `[${code}] invalid JSON response from server\nFix: check WORKER_API_URL points to query server`;
    if (code === "http_error" && e.status === 404) return `[${code}] endpoint not found\nFix: check WORKER_URL/WORKER_API_URL and path`;
    if (code === "http_error" && e.status === 429)
      return `[${code}] too many requests\nFix: wait ${Math.max(1, Math.ceil(Number(e.retryAfterMs || 0) / 1000))}s and retry`;
    const meta = [];
    if (e.status) meta.push(`status=${e.status}`);
    if (e.url) meta.push(`url=${e.url}`);
    const suffix = meta.length ? ` (${meta.join(" ")})` : "";
    return `[${code}]${suffix} ${msg}`;
  }

  if (e && typeof e === "object" && "code" in e) {
    const rawCode = e.code;
    const code = typeof rawCode === "string" ? Number(rawCode) : rawCode;
    if (code === 4001) return "[UserRejected] request rejected in wallet\nFix: confirm in wallet, or retry";
    if (code === 4100) return "[WalletUnauthorized] wallet not authorized\nFix: connect wallet and approve the request";
    if (code === 4200) return "[WalletUnsupported] wallet does not support this request\nFix: switch wallet/network, or update wallet";
    if (code === 4900) return "[WalletDisconnected] wallet disconnected\nFix: open wallet and reconnect";
    if (code === 4901) return "[ChainDisconnected] wallet chain disconnected\nFix: switch network in wallet, then retry";
    if (code === -32002) return "[WalletPending] wallet request already pending\nFix: open wallet popup and complete/reject the pending request";
  }

  if (msg.includes("Missing window.ethereum")) return "[WalletMissing] missing wallet provider\nFix: install/enable a wallet (e.g. MetaMask) and reload";
  if (msg.startsWith("Invalid address:")) return `[BadConfig] ${msg}\nFix: open Config and paste a valid address`;
  if (msg.toLowerCase().includes("failed to fetch")) return "[NetworkError] network request failed\nFix: check RPC_URL / WORKER_URL / WORKER_API_URL, then retry";
  if (msg.toLowerCase().includes("err_connection_refused") || msg.toLowerCase().includes("econnrefused"))
    return "[NetworkError] connection refused\nFix: start RPC/worker servers and confirm URLs/ports, then retry";
  if (msg.toLowerCase().includes("networkerror") && msg.toLowerCase().includes("fetch"))
    return "[NetworkError] network request failed\nFix: check RPC_URL / WORKER_URL / WORKER_API_URL, then retry";
  if (msg.toLowerCase().includes("load failed"))
    return "[NetworkError] network request failed\nFix: check RPC_URL / WORKER_URL / WORKER_API_URL, then retry";
  if (msg.includes("NotOwner")) return "[NoPermission] protocol owner required\nFix: connect the protocol owner wallet";
  if (msg.includes("NotShopOwner")) return "[NoPermission] shop owner/operator required\nFix: connect shop owner wallet or grant role in Shop Console (S-04)";
  if (msg.includes("InvalidRole")) return "[NoPermission] missing role\nFix: grant shop role in Shop Console (S-04) and retry";
  if (msg.includes("SignatureExpired")) return "[SignatureExpired] permit signature expired\nFix: refetch permit (extraData) with a new future deadline";
  if (msg.includes("InvalidSignature")) return "[InvalidSignature] permit signature invalid\nFix: refetch permit; ensure buyer/itemId/serial/deadline match";
  if (msg.includes("NonceUsed")) return "[NonceUsed] nonce already used\nFix: refetch permit (extraData) to get a new nonce";
  if (msg.includes("SerialRequired")) return "[SerialRequired] this item requires SerialPermit\nFix: click Fetch Serial Permit to generate extraData, then buy";
  if (msg.includes("ActionNotAllowed")) return "[ActionNotAllowed] action not allowed\nFix: allow the action in Protocol Console (G-05), then retry";
  if (msg.includes("ShopPaused")) return "[ShopPaused] shop is paused\nFix: unpause the shop (S-05 / governance), then retry";
  if (msg.includes("ItemInactive")) return "[ItemInactive] item is inactive\nFix: activate the item (I-04), then retry";
  if (msg.includes("ItemNotFound")) return "[ItemNotFound] itemId not found\nFix: check itemId in plaza/item detail";
  if (msg.includes("ShopNotFound")) return "[ShopNotFound] shopId not found\nFix: check shopId in plaza/shop detail";
  if (msg.includes("MaxItemsReached")) return "[SoldOut] max items reached\nFix: increase maxItems via new item or update policy";
  if (msg.includes("InvalidAddress")) return "[InvalidAddress] invalid address\nFix: check address inputs and contract config";
  if (msg.toLowerCase().includes("invalid address")) return "[InvalidAddress] invalid address\nFix: check address inputs and contract config";
  if (msg.includes("InvalidPayment")) return "[InvalidPayment] invalid payment\nFix: check payToken, unitPrice, quantity, and ETH value/approval";
  if (msg.includes("TransferFailed")) return "[TransferFailed] token transfer failed\nFix: ensure ERC20 balance + allowance are sufficient, then retry";
  if (msg.toLowerCase().includes("insufficient allowance")) return "[InsufficientAllowance] ERC20 allowance too low\nFix: approve a larger amount, then buy again";
  if (msg.toLowerCase().includes("exceeds balance") || msg.toLowerCase().includes("insufficient balance"))
    return "[InsufficientBalance] insufficient token balance\nFix: top up token balance (or adjust quantity/price), then retry";
  if (msg.toLowerCase().includes("user rejected")) return "[UserRejected] transaction rejected in wallet\nFix: confirm in wallet, or retry";
  if (msg.toLowerCase().includes("insufficient funds")) return "[InsufficientFunds] insufficient ETH for gas\nFix: top up ETH for gas, then retry";

  return msg;
}

// F4: Revert reason translation
const REVERT_MESSAGES = {
  ExceedsMaxSupply: "This item is sold out.",
  ExceedsPerWallet: "You've reached the per-wallet limit for this item.",
  NotYetAvailable: "This item is not available yet.",
  SaleEnded: "The sale period for this item has ended.",
  ItemPaused: "This item is temporarily unavailable.",
  ShopPaused: "This exchange counter is temporarily closed.",
  InvalidSerialPermit: "Serial verification failed. Please try again.",
  NonceAlreadyUsed: "This purchase session has expired. Please start over.",
  InsufficientBalance: "Insufficient token balance.",
  MaxItemsReached: "This item is sold out.",
  ItemInactive: "This item is not currently available.",
  ActionNotAllowed: "This item action is not allowed.",
  ShopNotFound: "Shop not found.",
  ItemNotFound: "Item not found.",
  InvalidPayment: "Invalid payment amount or token.",
  TransferFailed: "Token transfer failed. Check your balance and allowance."
};

function translateRevertReason(error) {
  const msg = (error && typeof error === "object")
    ? (error.message || error.reason || String(error))
    : String(error);
  for (const [key, human] of Object.entries(REVERT_MESSAGES)) {
    if (msg.includes(key)) return human;
  }
  if (msg.toLowerCase().includes("user rejected")) return "Transaction cancelled.";
  if (msg.toLowerCase().includes("insufficient allowance")) return "Insufficient token allowance. Please approve first.";
  if (msg.toLowerCase().includes("insufficient balance") || msg.toLowerCase().includes("exceeds balance"))
    return "Insufficient token balance.";
  return "Transaction failed. Please try again.";
}

function showTxError(e) {
  const base = formatError(e);
  const parts = [base];
  if (!base.includes("Fix:")) {
    parts.push("\nFix: open 诊断（Diagnostics）检查 RPC/Worker，再检查 配置（Config）地址与 URL，然后重试。");
  }
  if (e && typeof e === "object" && "txHash" in e && e.txHash) {
    parts.push(`\nTx: ${String(e.txHash)}`);
  }
  const mismatch = getChainMismatch();
  if (mismatch) {
    parts.push(`\n[ChainMismatch] walletChainId=${mismatch.walletChainId} expectedChainId=${mismatch.expectedChainId}`);
    parts.push("Fix: switch your wallet network to expectedChainId, or update Config -> CHAIN_ID/RPC URL.");
  }
  setText("txOut", parts.join("\n"));
  updateTxPanel();
}

async function runWriteTx({ label, buttonIds = [], write, onStatus }) {
  if (activeTxLabel) throw new Error(`transaction in progress: ${activeTxLabel}`);
  activeTxLabel = label;
  lastTx = {
    label,
    hash: null,
    status: "waiting_wallet",
    blockNumber: null,
    startedAtMs: Date.now(),
    submittedAtMs: null,
    confirmedAtMs: null,
    error: null
  };
  updateTxPanel();
  setDisabledMany(buttonIds, true);
  try {
    if (onStatus) onStatus("waiting_wallet", {});
    setText("txOut", `[${label}] waiting for wallet confirmation...`);
    const hash = await write();
    if (onStatus) onStatus("pending", { hash });
    lastTx = { ...lastTx, hash, status: "pending", submittedAtMs: Date.now(), error: null };
    updateTxPanel();
    setText("txOut", `[${label}] submitted: ${hash}\nstatus=pending`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    const blockNumber = receipt.blockNumber != null ? String(receipt.blockNumber) : "";
    lastTx = { ...lastTx, hash, status: receipt.status, blockNumber: blockNumber || null, confirmedAtMs: Date.now() };
    updateTxPanel();
    setText("txOut", `[${label}] confirmed: ${hash}\nstatus=${receipt.status}${blockNumber ? ` block=${blockNumber}` : ""}`);
    if (receipt.status !== "success") {
      if (onStatus) onStatus("reverted", { hash });
      const err = new Error("[TxReverted] transaction reverted");
      err.txHash = hash;
      err.receipt = receipt;
      try {
        const tx = await publicClient.getTransaction({ hash });
        await publicClient.call({
          to: tx.to,
          data: tx.input,
          from: tx.from,
          value: tx.value,
          blockNumber: receipt.blockNumber
        });
      } catch (revertErr) {
        err.revertDetails = getErrorText(revertErr);
        err.message = `[TxReverted] transaction reverted | ${err.revertDetails}`;
      }
      throw err;
    }
    if (onStatus) onStatus("success", { hash });
    return { hash, receipt };
  } catch (e) {
    const msg = formatError(e);
    lastTx = { ...lastTx, status: lastTx?.hash ? lastTx.status : "error", error: msg };
    if (onStatus) onStatus("error", { error: msg, hash: lastTx?.hash || null });
    updateTxPanel();
    throw e;
  } finally {
    setDisabledMany(buttonIds, false);
    activeTxLabel = null;
    updateTxPanel();
  }
}

function getExpectedChainId() {
  const node = document.getElementById("chainId");
  const raw = node ? String(node.value || "").trim() : "";
  if (raw) return Number(raw);
  return runtimeCfg.chainId ? Number(runtimeCfg.chainId) : 0;
}

function getChainMismatch() {
  const expectedChainId = getExpectedChainId();
  if (!expectedChainId || connectedChainId == null) return null;
  if (Number(expectedChainId) === Number(connectedChainId)) return null;
  return { expectedChainId, walletChainId: connectedChainId };
}

function requireAddress(value, field) {
  if (!isAddress(value)) throw new Error(`Invalid address: ${field}`);
  return getAddress(value);
}

function requireHexBytes(value, field) {
  if (!value) return "0x";
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`Invalid hex: ${field}`);
  return value;
}

function pick(obj, key, index) {
  const value = obj?.[key] ?? obj?.[index];
  if (value === undefined) throw new Error(`Unable to read ${key}`);
  return value;
}

function toHttpUri(uri) {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice("ipfs://".length)}`;
  return uri;
}

function normalizeBaseUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

function getPermitBaseUrl() {
  return normalizeBaseUrl(val("workerUrl") || runtimeCfg.workerUrl);
}

function getApiBaseUrl() {
  return normalizeBaseUrl(val("workerApiUrl") || runtimeCfg.workerApiUrl || getPermitBaseUrl());
}

async function fetchJson(url, { signal } = {}) {
  const res = await fetch(url, { signal });
  const retryAfterHeader = res.headers?.get ? res.headers.get("Retry-After") : null;
  const body = await res.text();
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const message = parsed?.error ? String(parsed.error) : `HTTP ${res.status}`;
    const retryAfterMs =
      typeof parsed?.retryAfterMs === "number" && Number.isFinite(parsed.retryAfterMs)
        ? parsed.retryAfterMs
        : retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : null;
    throw new ApiError(message, {
      status: res.status,
      errorCode: parsed?.errorCode ?? "http_error",
      errorDetails: parsed?.errorDetails ?? null,
      url,
      retryAfterMs
    });
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ApiError("invalid JSON response", { status: res.status, errorCode: "invalid_response", url });
  }

  if (parsed?.ok === false || parsed?.error) {
    const message = parsed?.error ? String(parsed.error) : "request failed";
    throw new ApiError(message, {
      status: res.status,
      errorCode: parsed?.errorCode ?? "api_error",
      errorDetails: parsed?.errorDetails ?? null,
      url
    });
  }

  return parsed;
}

async function workerApiGet(path, params = {}) {
  const base = getApiBaseUrl();
  if (!base) throw new Error("workerApiUrl is required");
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return fetchJson(url.toString());
}

async function workerPermitGet(path, params = {}) {
  const base = getPermitBaseUrl();
  if (!base) throw new Error("workerUrl is required");
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return fetchJson(url.toString());
}

async function resolveShopsAddress() {
  const shopsAddressVal = val("shopsAddress") || runtimeCfg.shopsAddress;
  if (isAddress(shopsAddressVal)) return getAddress(shopsAddressVal);

  const itemsAddressVal = val("itemsAddress") || runtimeCfg.itemsAddress;
  if (!isAddress(itemsAddressVal)) throw new Error("shopsAddress is required (or provide valid itemsAddress)");
  const itemsAddress = getAddress(itemsAddressVal);
  const shopsAddress = await publicClient.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "shops",
    args: []
  });
  return getAddress(shopsAddress);
}

async function fetchShop(shopId, { source } = {}) {
  const id = BigInt(shopId);
  if (source !== "chain") {
    try {
      const json = await workerApiGet("/shop", { shopId: id.toString() });
      if (json?.shop) return { ...json.shop, __source: "worker" };
      throw new Error("invalid worker response");
    } catch (e) {
      if (source === "worker") throw e;
    }
  }

  const shopsAddress = await resolveShopsAddress();
  const raw = await publicClient.readContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "shops",
    args: [id]
  });
  return {
    owner: pick(raw, "owner", 0),
    treasury: pick(raw, "treasury", 1),
    metadataHash: pick(raw, "metadataHash", 2),
    paused: pick(raw, "paused", 3),
    __source: "chain"
  };
}

async function fetchItem(itemId, { source } = {}) {
  const id = BigInt(itemId);
  if (source !== "chain") {
    try {
      const json = await workerApiGet("/item", { itemId: id.toString() });
      if (json?.item) return { ...json.item, __source: "worker" };
      throw new Error("invalid worker response");
    } catch (e) {
      if (source === "worker") throw e;
    }
  }

  const itemsAddressVal = val("itemsAddress") || runtimeCfg.itemsAddress;
  const itemsAddress = requireAddress(itemsAddressVal, "itemsAddress");
  const raw = await publicClient.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "items",
    args: [id]
  });
  return {
    shopId: pick(raw, "shopId", 0).toString(),
    payToken: pick(raw, "payToken", 1),
    unitPrice: pick(raw, "unitPrice", 2).toString(),
    nftContract: pick(raw, "nftContract", 3),
    soulbound: pick(raw, "soulbound", 4),
    tokenURI: pick(raw, "tokenURI", 5),
    action: pick(raw, "action", 6),
    actionData: pick(raw, "actionData", 7),
    requiresSerial: pick(raw, "requiresSerial", 8),
    active: pick(raw, "active", 9),
    __source: "chain"
  };
}

async function fetchShopList({ cursor = 1n, limit = 20, source } = {}) {
  if (source !== "chain") {
    try {
      const json = await workerApiGet("/shops", { cursor: cursor.toString(), limit: String(limit) });
      if (Array.isArray(json?.shops)) {
        const shops = json.shops.map((s) => {
          if (!s || typeof s !== "object") return s;
          if (s.shop && typeof s.shop === "object") return { ...s, shop: { ...s.shop, __source: "worker" } };
          if (s.owner || s.treasury) return { ...s, __source: "worker" };
          return s;
        });
        return { shops, nextCursor: json.nextCursor };
      }
      throw new Error("invalid worker response");
    } catch (e) {
      if (source === "worker") throw e;
    }
  }

  const shopsAddress = await resolveShopsAddress();
  const count = await publicClient.readContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "shopCount",
    args: []
  });
  const max = BigInt(count);
  const list = [];
  for (let id = cursor; id <= max && list.length < limit; id++) {
    const shop = await fetchShop(id, { source: "chain" });
    list.push({ shopId: id.toString(), shop });
  }
  const next = cursor + BigInt(list.length);
  return { shops: list, nextCursor: next <= max ? next.toString() : null };
}

async function fetchItemList({ cursor = 1n, limit = 20, source } = {}) {
  if (source !== "chain") {
    try {
      const json = await workerApiGet("/items", { cursor: cursor.toString(), limit: String(limit) });
      if (Array.isArray(json?.items)) {
        const items = json.items.map((it) => {
          if (!it || typeof it !== "object") return it;
          if (it.item && typeof it.item === "object") return { ...it, item: { ...it.item, __source: "worker" } };
          if (it.shopId || it.payToken) return { ...it, __source: "worker" };
          return it;
        });
        return { items, nextCursor: json.nextCursor };
      }
      throw new Error("invalid worker response");
    } catch (e) {
      if (source === "worker") throw e;
    }
  }

  const itemsAddressVal = val("itemsAddress") || runtimeCfg.itemsAddress;
  const itemsAddress = requireAddress(itemsAddressVal, "itemsAddress");
  const count = await publicClient.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "itemCount",
    args: []
  });
  const max = BigInt(count);
  const list = [];
  for (let id = cursor; id <= max && list.length < limit; id++) {
    const item = await fetchItem(id, { source: "chain" });
    list.push({ itemId: id.toString(), item });
  }
  const next = cursor + BigInt(list.length);
  return { items: list, nextCursor: next <= max ? next.toString() : null };
}

const purchasedEvent = parseAbiItem(
  "event Purchased(uint256 indexed itemId,uint256 indexed shopId,address indexed buyer,address recipient,uint256 quantity,address payToken,uint256 payAmount,uint256 platformFeeAmount,bytes32 serialHash,uint256 firstTokenId)"
);

async function fetchPurchases({ buyer, shopId, itemId, limit, source, fromBlock, toBlock } = {}) {
  if (source === "auto") source = undefined;

  const params = {
    buyer,
    shopId,
    itemId,
    limit: limit != null ? String(limit) : undefined,
    source,
    fromBlock,
    toBlock,
    include: "enrich"
  };
  if (source !== "chain") {
    try {
      const json = await workerApiGet("/purchases", params);
      if (Array.isArray(json?.purchases)) return json;
      throw new Error("invalid worker response");
    } catch (e) {
      if (source === "index") throw e;
    }
  }

  const itemsAddressVal = val("itemsAddress") || runtimeCfg.itemsAddress;
  const itemsAddress = requireAddress(itemsAddressVal, "itemsAddress");
  const latest = await publicClient.getBlockNumber();
  const to = toBlock ? BigInt(toBlock) : latest;
  const from = fromBlock ? BigInt(fromBlock) : latest > 5000n ? latest - 5000n : 0n;

  const args = {};
  if (buyer) args.buyer = requireAddress(buyer, "buyer");
  if (shopId) args.shopId = BigInt(shopId);
  if (itemId) args.itemId = BigInt(itemId);

  const logs = await publicClient.getLogs({
    address: itemsAddress,
    event: purchasedEvent,
    args: Object.keys(args).length ? args : undefined,
    fromBlock: from,
    toBlock: to
  });

  const max = Math.min(logs.length, limit != null ? Math.max(1, Number(limit)) : 200);
  const sliced = logs.slice(0, max);
  const purchases = [];

  for (const log of sliced) {
    const decoded = decodeEventLog({
      abi: myShopItemsAbi,
      data: log.data,
      topics: log.topics
    });
    const base = {
      chainId: chain.id,
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      blockNumber: Number(log.blockNumber),
      itemId: decoded.args.itemId?.toString(),
      shopId: decoded.args.shopId?.toString(),
      buyer: decoded.args.buyer,
      recipient: decoded.args.recipient,
      quantity: decoded.args.quantity?.toString(),
      payToken: decoded.args.payToken,
      payAmount: decoded.args.payAmount?.toString(),
      platformFeeAmount: decoded.args.platformFeeAmount?.toString(),
      serialHash: decoded.args.serialHash,
      firstTokenId: decoded.args.firstTokenId?.toString()
    };

    const item = await fetchItem(base.itemId);
    const shop = await fetchShop(base.shopId);
    purchases.push({ ...base, item, shop });
  }

  return {
    ok: true,
    source: "chain",
    fromBlock: from.toString(),
    toBlock: to.toString(),
    latest: latest.toString(),
    indexedToBlock: null,
    count: purchases.length,
    purchases
  };
}

async function fetchRiskSummary({ buyer, shopId, itemId, source } = {}) {
  if (source === "auto") source = undefined;
  const params = { buyer, shopId, itemId, source };
  try {
    const json = await workerApiGet("/risk-summary", params);
    if (json?.ok) return json;
    throw new Error("invalid worker response");
  } catch (e) {
    if (source === "index") throw e;
  }
  const res = await fetchPurchases({ buyer, shopId, itemId, limit: 500, source: "chain" });
  const summary = buildRiskSummaryFromPurchases(res.purchases || []);
  return { ok: true, source: "chain", ...summary };
}

function buildRiskSummaryFromPurchases(list) {
  const buyerMap = new Map();
  const itemMap = new Map();
  const shopSet = new Set();
  const itemSet = new Set();
  let totalQuantity = 0n;
  let totalPayAmount = 0n;
  let totalPlatformFeeAmount = 0n;
  let lastBlock = null;

  const toBigInt = (value) => {
    try {
      if (value == null) return 0n;
      return BigInt(value);
    } catch {
      return 0n;
    }
  };

  for (const p of list) {
    if (p.shopId != null) shopSet.add(String(p.shopId));
    if (p.itemId != null) itemSet.add(String(p.itemId));
    if (p.blockNumber != null) {
      const b = Number(p.blockNumber);
      if (lastBlock == null || b > lastBlock) lastBlock = b;
    }

    const quantity = toBigInt(p.quantity);
    const payAmount = toBigInt(p.payAmount);
    const feeAmount = toBigInt(p.platformFeeAmount);

    totalQuantity += quantity;
    totalPayAmount += payAmount;
    totalPlatformFeeAmount += feeAmount;

    if (p.buyer) {
      const key = String(p.buyer).toLowerCase();
      const prev = buyerMap.get(key) ?? { payAmount: 0n, purchases: 0 };
      prev.payAmount += payAmount;
      prev.purchases += 1;
      buyerMap.set(key, prev);
    }

    if (p.itemId != null) {
      const key = String(p.itemId);
      const prev = itemMap.get(key) ?? { quantity: 0n, payAmount: 0n, purchases: 0 };
      prev.quantity += quantity;
      prev.payAmount += payAmount;
      prev.purchases += 1;
      itemMap.set(key, prev);
    }
  }

  const topByValue = (map, field, limit) => {
    const arr = [];
    for (const [key, value] of map.entries()) {
      arr.push({ key, ...value });
    }
    arr.sort((a, b) => {
      if (a[field] === b[field]) return 0;
      return a[field] > b[field] ? -1 : 1;
    });
    return arr.slice(0, limit);
  };

  const topBuyers = topByValue(buyerMap, "payAmount", 5).map((entry) => ({
    buyer: entry.key,
    payAmount: entry.payAmount.toString(),
    purchases: entry.purchases
  }));
  const topItems = topByValue(itemMap, "payAmount", 5).map((entry) => ({
    itemId: entry.key,
    quantity: entry.quantity.toString(),
    payAmount: entry.payAmount.toString(),
    purchases: entry.purchases
  }));

  return {
    totalPurchases: list.length,
    totalQuantity: totalQuantity.toString(),
    totalPayAmount: totalPayAmount.toString(),
    totalPlatformFeeAmount: totalPlatformFeeAmount.toString(),
    uniqueBuyers: buyerMap.size,
    uniqueShops: shopSet.size,
    uniqueItems: itemSet.size,
    topBuyers,
    topItems,
    lastPurchaseBlock: lastBlock != null ? String(lastBlock) : null,
    lastPurchaseAt: null,
    updatedAt: new Date().toISOString()
  };
}

async function fetchMetadataFromTokenUri(tokenURI) {
  const url = toHttpUri(tokenURI);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || typeof json !== "object") return null;
    return json;
  } catch {
    return null;
  }
}

async function connect() {
  if (!window.ethereum) throw new Error("Missing window.ethereum");
  walletClient = createWalletClient({
    chain,
    transport: custom(window.ethereum)
  });
  const [addr] = await walletClient.requestAddresses();
  connectedAddress = getAddress(addr);
  walletClient = createWalletClient({
    chain,
    transport: custom(window.ethereum),
    account: connectedAddress
  });
  connectedChainId = await getConnectedChainId();
  setText("conn", `connected: ${connectedAddress}`);
  const buyRecipient = document.getElementById("buyRecipient");
  if (buyRecipient && !String(buyRecipient.value || "").trim()) buyRecipient.value = connectedAddress;
  const buyBuyer = document.getElementById("buyBuyer");
  if (buyBuyer && !String(buyBuyer.value || "").trim()) buyBuyer.value = connectedAddress;

  if (!walletEventsBound && window.ethereum?.on) {
    walletEventsBound = true;
    window.ethereum.on("chainChanged", () => {
      getConnectedChainId()
        .then((id) => {
          connectedChainId = id;
          render();
        })
        .catch(() => {});
    });
    window.ethereum.on("accountsChanged", (accounts) => {
      try {
        const a = Array.isArray(accounts) ? accounts[0] : null;
        connectedAddress = a ? getAddress(a) : null;
        setText("conn", connectedAddress ? `connected: ${connectedAddress}` : "not connected");
        render();
      } catch {
        connectedAddress = null;
        setText("conn", "not connected");
        render();
      }
    });
  }
}

async function getConnectedChainId() {
  if (!window.ethereum?.request) return null;
  try {
    const hex = await window.ethereum.request({ method: "eth_chainId" });
    if (!hex) return null;
    return Number.parseInt(String(hex), 16);
  } catch {
    return null;
  }
}

async function readItem() {
  const itemId = BigInt(val("itemIdRead"));
  const itemsAddress = requireAddress(getCurrentCfgValue("itemsAddress"), "itemsAddress");
  const item = await publicClient.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "items",
    args: [itemId]
  });
  setText("itemOut", safeJson(item));

  try {
    const payToken = pick(item, "payToken", 1);
    const buyPayToken = document.getElementById("buyPayToken");
    if (buyPayToken && !String(buyPayToken.value || "").trim()) buyPayToken.value = payToken;
  } catch {
  }

  const tokenURI = pick(item, "tokenURI", 5);
  const metaUrl = toHttpUri(tokenURI);
  let metadata = null;
  if (metaUrl) {
    try {
      const res = await fetch(metaUrl);
      metadata = await res.json();
    } catch {
      metadata = null;
    }
  }

  let page = null;
  try {
    const defaultVersion = await publicClient.readContract({
      address: itemsAddress,
      abi: myShopItemsAbi,
      functionName: "itemDefaultPageVersion",
      args: [itemId]
    });
    const v = BigInt(defaultVersion);
    if (v > 0n) {
      const raw = await publicClient.readContract({
        address: itemsAddress,
        abi: myShopItemsAbi,
        functionName: "getItemPage",
        args: [itemId, v]
      });
      page = {
        version: v.toString(),
        contentHash: pick(raw, "contentHash", 0),
        uri: pick(raw, "uri", 1)
      };
    }
  } catch {
    page = null;
  }

  const metaBox = document.getElementById("itemMetaOut");
  metaBox.innerHTML = "";

  if (metadata) {
    metaBox.appendChild(el("div", {}, [el("div", { text: `metadata.name: ${metadata.name ?? ""}` })]));
    metaBox.appendChild(el("div", {}, [el("div", { text: `metadata.description: ${metadata.description ?? ""}` })]));

    const image = toHttpUri(metadata.image || metadata.image_url || "");
    if (image) {
      metaBox.appendChild(el("img", { src: image, style: "max-width: 240px; display: block; margin: 8px 0;" }));
      metaBox.appendChild(el("a", { href: image, target: "_blank", rel: "noreferrer", text: "open image" }));
    }
    if (metadata.external_url) {
      metaBox.appendChild(
        el("div", {}, [el("a", { href: metadata.external_url, target: "_blank", rel: "noreferrer", text: "external_url" })])
      );
    }
  } else if (metaUrl) {
    metaBox.appendChild(el("div", { text: `metadata fetch failed: ${metaUrl}` }));
  }

  if (page) {
    metaBox.appendChild(el("hr"));
    metaBox.appendChild(el("div", { text: `default page version: ${page.version}` }));
    metaBox.appendChild(el("div", { text: `contentHash: ${page.contentHash}` }));
    metaBox.appendChild(el("a", { href: page.uri, target: "_blank", rel: "noreferrer", text: page.uri }));
  }
}

async function registerShop() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const treasury = requireAddress(val("shopTreasury"), "treasury");
  const metadataHash = val("shopMetadataHash") || "0x" + "0".repeat(64);

  const hash = await walletClient.writeContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "registerShop",
    args: [treasury, metadataHash],
    account: connectedAddress
  });
  setText("txOut", `registerShop tx: ${hash}`);
}

async function updateShopTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const shopId = BigInt(val("shopIdUpdateShop"));
  const treasury = requireAddress(val("shopTreasuryUpdateShop"), "treasury");
  const metadataHash = val("shopMetadataHashUpdateShop") || "0x" + "0".repeat(64);
  const hash = await walletClient.writeContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "updateShop",
    args: [shopId, treasury, metadataHash],
    account: connectedAddress
  });
  setText("txOut", `updateShop tx: ${hash}`);
}

async function setShopPausedTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const shopId = BigInt(val("shopIdPause"));
  const paused = val("shopPaused") === "true";
  const hash = await walletClient.writeContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "setShopPaused",
    args: [shopId, paused],
    account: connectedAddress
  });
  setText("txOut", `setShopPaused tx: ${hash}`);
}

async function readProtocolConfig() {
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const owner = await publicClient.readContract({ address: shopsAddress, abi: myShopsAbi, functionName: "owner", args: [] });
  const registry = await publicClient.readContract({ address: shopsAddress, abi: myShopsAbi, functionName: "registry", args: [] });
  const protocolTreasury = await publicClient.readContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "platformTreasury",
    args: []
  });
  const listingFeeToken = await publicClient.readContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "listingFeeToken",
    args: []
  });
  const listingFeeAmount = await publicClient.readContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "listingFeeAmount",
    args: []
  });
  const protocolFeeBps = await publicClient.readContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "platformFeeBps",
    args: []
  });
  setText(
    "platformOut",
    JSON.stringify(
      {
        shopsAddress,
        owner,
        registry,
        protocolTreasury,
        listingFeeToken,
        listingFeeAmount: listingFeeAmount.toString(),
        protocolFeeBps: protocolFeeBps.toString()
      },
      null,
      2
    )
  );
}

async function setRegistryTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const registry = requireAddress(val("platformRegistry"), "registry");
  const hash = await walletClient.writeContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "setRegistry",
    args: [registry],
    account: connectedAddress
  });
  setText("txOut", `setRegistry tx: ${hash}`);
}

async function setProtocolTreasuryTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const treasury = requireAddress(val("platformTreasury"), "treasury");
  const hash = await walletClient.writeContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "setPlatformTreasury",
    args: [treasury],
    account: connectedAddress
  });
  setText("txOut", `setProtocolTreasury tx: ${hash}`);
}

async function setListingFeeTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const token = requireAddress(val("platformListingFeeToken"), "token");
  const amount = BigInt(val("platformListingFeeAmount"));
  const hash = await walletClient.writeContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "setListingFee",
    args: [token, amount],
    account: connectedAddress
  });
  setText("txOut", `setListingFee tx: ${hash}`);
}

async function setProtocolFeeTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const feeBps = Number(val("platformFeeBps"));
  const hash = await walletClient.writeContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "setPlatformFee",
    args: [feeBps],
    account: connectedAddress
  });
  setText("txOut", `setProtocolFee tx: ${hash}`);
}

async function transferShopsOwnershipTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const newOwner = requireAddress(val("shopsNewOwner"), "newOwner");
  const hash = await walletClient.writeContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "transferOwnership",
    args: [newOwner],
    account: connectedAddress
  });
  setText("txOut", `transferOwnership(MyShops) tx: ${hash}`);
}

async function readItemsConfig() {
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const owner = await publicClient.readContract({ address: itemsAddress, abi: myShopItemsAbi, functionName: "owner", args: [] });
  const shops = await publicClient.readContract({ address: itemsAddress, abi: myShopItemsAbi, functionName: "shops", args: [] });
  const riskSigner = await publicClient.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "riskSigner",
    args: []
  });
  const serialSigner = await publicClient.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "serialSigner",
    args: []
  });
  setText(
    "itemsOut",
    JSON.stringify({ itemsAddress, owner, shops, riskSigner, serialSigner }, null, 2)
  );
}

async function setRiskSignerTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const signer = requireAddress(val("itemsRiskSigner"), "signer");
  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "setRiskSigner",
    args: [signer],
    account: connectedAddress
  });
  setText("txOut", `setRiskSigner tx: ${hash}`);
}

async function setSerialSignerTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const signer = requireAddress(val("itemsSerialSigner"), "signer");
  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "setSerialSigner",
    args: [signer],
    account: connectedAddress
  });
  setText("txOut", `setSerialSigner tx: ${hash}`);
}

async function setActionAllowedTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const action = requireAddress(val("itemsActionAddress"), "action");
  const allowed = val("itemsActionAllowed") === "true";
  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "setActionAllowed",
    args: [action, allowed],
    account: connectedAddress
  });
  setText("txOut", `setActionAllowed tx: ${hash}`);
}

async function transferItemsOwnershipTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const newOwner = requireAddress(val("itemsNewOwner"), "newOwner");
  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "transferOwnership",
    args: [newOwner],
    account: connectedAddress
  });
  setText("txOut", `transferOwnership(MyShopItems) tx: ${hash}`);
}

async function addItem() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");

  const p = {
    shopId: BigInt(val("shopIdAdd")),
    payToken: requireAddress(val("payToken"), "payToken"),
    unitPrice: BigInt(val("unitPrice")),
    nftContract: requireAddress(val("nftContract"), "nftContract"),
    soulbound: val("soulbound") === "true",
    tokenURI: val("tokenURI"),
    action: val("action") ? requireAddress(val("action"), "action") : "0x0000000000000000000000000000000000000000",
    actionData: requireHexBytes(val("actionData"), "actionData"),
    requiresSerial: val("requiresSerial") === "true",
    maxItems: BigInt(val("maxItems") || "0"),
    deadline: BigInt(val("riskDeadline") || "0"),
    nonce: BigInt(val("riskNonce") || "0"),
    signature: requireHexBytes(val("riskSig"), "riskSig")
  };

  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "addItem",
    args: [p],
    account: connectedAddress
  });
  setText("txOut", `addItem tx: ${hash}`);
}

async function fetchRiskSig() {
  const shopOwner = requireAddress(val("riskShopOwner"), "riskShopOwner");
  const maxItems = val("maxItems");
  const deadline = val("riskDeadline");
  const json = await workerPermitGet("/risk-allowance", { shopOwner, maxItems, deadline });
  document.getElementById("riskNonce").value = json.nonce;
  document.getElementById("riskSig").value = json.signature;
  setText("txOut", "risk signature fetched");
}

async function fetchSerialExtraData() {
  const itemId = val("buyItemId");
  const buyer = connectedAddress ? getAddress(connectedAddress) : requireAddress(val("buyBuyer"), "buyer");
  const buyerInput = document.getElementById("buyBuyer");
  if (buyerInput) buyerInput.value = buyer;
  const serial = val("serial");
  const deadline = val("serialDeadline");
  const json = await workerPermitGet("/serial-permit", { itemId, buyer, serial, deadline });
  document.getElementById("buyExtraData").value = json.extraData;
  setText("txOut", "serial extraData fetched");
}

async function approvePayToken() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(getCurrentCfgValue("itemsAddress"), "itemsAddress");
  const payToken = requireAddress(val("buyPayToken"), "buyPayToken");
  const amount = BigInt(val("buyApproveAmount") || "0");
  await runWriteTx({
    label: "approve",
    buttonIds: ["btnApprove", "btnBuy"],
    onStatus: (status, meta) => setBuyFlowStep("approve", status, meta),
    write: () =>
      walletClient.writeContract({
        address: payToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [itemsAddress, amount],
        account: connectedAddress
      })
  });
}

async function buy() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(getCurrentCfgValue("itemsAddress"), "itemsAddress");
  const itemId = BigInt(val("buyItemId"));
  const quantity = BigInt(val("buyQty"));
  const recipient = requireAddress(val("buyRecipient"), "recipient");
  const extraData = requireHexBytes(val("buyExtraData"), "extraData");
  const ethValue = val("buyEthValue");

  await runWriteTx({
    label: `buy itemId=${itemId.toString()} qty=${quantity.toString()}`,
    buttonIds: ["btnApprove", "btnBuy"],
    onStatus: (status, meta) => setBuyFlowStep("buy", status, meta),
    write: () =>
      walletClient.writeContract({
        address: itemsAddress,
        abi: myShopItemsAbi,
        functionName: "buy",
        args: [itemId, quantity, recipient, extraData],
        account: connectedAddress,
        value: ethValue ? parseEther(ethValue) : undefined
      })
  });

  window.location.hash = `#/purchases?buyer=${encodeURIComponent(connectedAddress)}&itemId=${encodeURIComponent(
    itemId.toString()
  )}&source=auto`;
}

async function setShopRolesTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const shopsAddress = requireAddress(val("shopsAddress"), "shopsAddress");
  const shopId = BigInt(val("shopIdRole"));
  const operator = requireAddress(val("roleOperator"), "operator");

  const roleConfig = normalizeRoleConfig(roleConfigState);
  const shopAdmin = document.getElementById("roleShopAdmin").checked ? roleConfig.shopAdmin : 0;
  const maintainer = document.getElementById("roleItemMaintainer").checked ? roleConfig.itemMaintainer : 0;
  const editor = document.getElementById("roleItemEditor").checked ? roleConfig.itemEditor : 0;
  const actionEditor = document.getElementById("roleItemActionEditor").checked ? roleConfig.itemActionEditor : 0;
  const roles = shopAdmin | maintainer | editor | actionEditor;

  const hash = await walletClient.writeContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "setShopRoles",
    args: [shopId, operator, roles],
    account: connectedAddress
  });
  setText("txOut", `setShopRoles tx: ${hash}`);
}

async function updateItemTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const itemId = BigInt(val("itemIdUpdate"));
  const p = {
    payToken: requireAddress(val("payTokenUpdate"), "payToken"),
    unitPrice: BigInt(val("unitPriceUpdate")),
    nftContract: requireAddress(val("nftContractUpdate"), "nftContract"),
    soulbound: val("soulboundUpdate") === "true",
    tokenURI: val("tokenURIUpdate"),
    requiresSerial: val("requiresSerialUpdate") === "true"
  };

  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "updateItem",
    args: [itemId, p],
    account: connectedAddress
  });
  setText("txOut", `updateItem tx: ${hash}`);
}

async function updateItemActionTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const itemId = BigInt(val("itemIdUpdateAction"));
  const action = val("actionUpdate") ? requireAddress(val("actionUpdate"), "action") : "0x0000000000000000000000000000000000000000";
  const actionData = requireHexBytes(val("actionDataUpdate"), "actionData");

  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "updateItemAction",
    args: [itemId, action, actionData],
    account: connectedAddress
  });
  setText("txOut", `updateItemAction tx: ${hash}`);
}

async function setItemActiveTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const itemId = BigInt(val("itemIdActive"));
  const active = val("itemActive") === "true";
  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "setItemActive",
    args: [itemId, active],
    account: connectedAddress
  });
  setText("txOut", `setItemActive tx: ${hash}`);
}

async function addItemPageTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const itemId = BigInt(val("itemIdPage"));
  const uri = val("pageUri");
  const contentHash = val("pageHash") || "0x" + "0".repeat(64);

  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "addItemPageVersion",
    args: [itemId, uri, contentHash],
    account: connectedAddress
  });
  setText("txOut", `addItemPageVersion tx: ${hash}`);
}

async function setDefaultItemPageTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const itemId = BigInt(val("itemIdDefaultPage"));
  const version = BigInt(val("defaultPageVersion"));

  const hash = await walletClient.writeContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "setItemDefaultPageVersion",
    args: [itemId, version],
    account: connectedAddress
  });
  setText("txOut", `setItemDefaultPageVersion tx: ${hash}`);
}

async function exportShopItemsTx() {
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const shopId = BigInt(val("shopIdExport"));

  const count = await publicClient.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "itemCount",
    args: []
  });

  const total = Number(BigInt(count));
  const list = [];

  for (let i = 1; i <= total; i++) {
    const itemId = BigInt(i);
    const raw = await publicClient.readContract({
      address: itemsAddress,
      abi: myShopItemsAbi,
      functionName: "items",
      args: [itemId]
    });
    const itemShopId = BigInt(pick(raw, "shopId", 0));
    if (itemShopId !== shopId) continue;

    const pageCount = await publicClient.readContract({
      address: itemsAddress,
      abi: myShopItemsAbi,
      functionName: "itemPageCount",
      args: [itemId]
    });
    const pageTotal = Number(BigInt(pageCount));
    const pages = [];
    for (let v = 1; v <= pageTotal; v++) {
      const pageRaw = await publicClient.readContract({
        address: itemsAddress,
        abi: myShopItemsAbi,
        functionName: "getItemPage",
        args: [itemId, BigInt(v)]
      });
      pages.push({
        version: String(v),
        contentHash: pick(pageRaw, "contentHash", 0),
        uri: pick(pageRaw, "uri", 1)
      });
    }

    const defaultVersion = await publicClient.readContract({
      address: itemsAddress,
      abi: myShopItemsAbi,
      functionName: "itemDefaultPageVersion",
      args: [itemId]
    });

    list.push({
      itemId: itemId.toString(),
      item: {
        shopId: pick(raw, "shopId", 0).toString(),
        payToken: pick(raw, "payToken", 1),
        unitPrice: pick(raw, "unitPrice", 2).toString(),
        nftContract: pick(raw, "nftContract", 3),
        soulbound: pick(raw, "soulbound", 4),
        tokenURI: pick(raw, "tokenURI", 5),
        action: pick(raw, "action", 6),
        actionData: pick(raw, "actionData", 7),
        requiresSerial: pick(raw, "requiresSerial", 8),
        active: pick(raw, "active", 9)
      },
      pages,
      defaultPageVersion: BigInt(defaultVersion).toString()
    });
  }

  const payload = {
    version: 1,
    chainId: chain.id,
    itemsAddress,
    shopId: shopId.toString(),
    exportedAt: new Date().toISOString(),
    items: list
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `myshop_shop_${shopId.toString()}_items.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setText("txOut", `exported ${list.length} items`);
}

async function importShopItemsTx() {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(val("itemsAddress"), "itemsAddress");
  const text = val("importJson");
  if (!text) throw new Error("import json required");
  const data = JSON.parse(text);
  if (!Array.isArray(data.items)) throw new Error("invalid import json: items");

  for (const entry of data.items) {
    const it = entry.item;
    const p = {
      shopId: BigInt(it.shopId),
      payToken: requireAddress(it.payToken, "payToken"),
      unitPrice: BigInt(it.unitPrice),
      nftContract: requireAddress(it.nftContract, "nftContract"),
      soulbound: Boolean(it.soulbound),
      tokenURI: String(it.tokenURI || ""),
      action: it.action && it.action !== "0x0000000000000000000000000000000000000000" ? requireAddress(it.action, "action") : "0x0000000000000000000000000000000000000000",
      actionData: requireHexBytes(it.actionData || "0x", "actionData"),
      requiresSerial: Boolean(it.requiresSerial),
      maxItems: 0n,
      deadline: 0n,
      nonce: 0n,
      signature: "0x"
    };

    const hash = await walletClient.writeContract({
      address: itemsAddress,
      abi: myShopItemsAbi,
      functionName: "addItem",
      args: [p],
      account: connectedAddress
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const newCount = await publicClient.readContract({
      address: itemsAddress,
      abi: myShopItemsAbi,
      functionName: "itemCount",
      args: []
    });
    const newItemId = BigInt(newCount);

    if (Array.isArray(entry.pages)) {
      for (const pg of entry.pages) {
        const pageHash = pg.contentHash || "0x" + "0".repeat(64);
        const pageUri = String(pg.uri || "");
        if (!pageUri) continue;
        const h2 = await walletClient.writeContract({
          address: itemsAddress,
          abi: myShopItemsAbi,
          functionName: "addItemPageVersion",
          args: [newItemId, pageUri, pageHash],
          account: connectedAddress
        });
        await publicClient.waitForTransactionReceipt({ hash: h2 });
      }
    }

    const defV = BigInt(entry.defaultPageVersion || "0");
    if (defV > 0n) {
      const h3 = await walletClient.writeContract({
        address: itemsAddress,
        abi: myShopItemsAbi,
        functionName: "setItemDefaultPageVersion",
        args: [newItemId, defV],
        account: connectedAddress
      });
      await publicClient.waitForTransactionReceipt({ hash: h3 });
    }
  }

  setText("txOut", "import done");
}

let routeState = { buyerItemId: null };
let lastServiceCheckAtMs = 0;
let lastServiceStatusText = "";

function getRoute() {
  const raw = window.location.hash || "#/plaza";
  const hash = raw.startsWith("#") ? raw.slice(1) : raw;
  const [path, queryStr] = hash.split("?");
  const parts = path.split("/").filter(Boolean);
  const query = {};
  if (queryStr) {
    const qs = new URLSearchParams(queryStr);
    for (const [k, v] of qs.entries()) query[k] = v;
  }
  return { raw, path, parts, query };
}

function navLink(label, href) {
  return el("a", { href, text: label, style: "margin-right: 12px;" });
}

function navLinkWithId(id, label, href) {
  return el("a", { id, href, text: label, style: "margin-right: 12px;" });
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchJson(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeShopRoles(rolesMask) {
  return decodeShopRolesMask(rolesMask, roleConfigState).labels;
}

function normalizeRoleConfig(roleConfig) {
  const defaults = getDefaultShopRoleConfig();
  return {
    shopAdmin: Number(roleConfig?.shopAdmin ?? defaults.shopAdmin),
    itemMaintainer: Number(roleConfig?.itemMaintainer ?? defaults.itemMaintainer),
    itemEditor: Number(roleConfig?.itemEditor ?? defaults.itemEditor),
    itemActionEditor: Number(roleConfig?.itemActionEditor ?? defaults.itemActionEditor)
  };
}

function buildRoleMask(roleConfig, keys) {
  const cfg = normalizeRoleConfig(roleConfig);
  let mask = 0;
  for (const key of keys) {
    mask |= Number(cfg[key] ?? 0);
  }
  return mask;
}

function applyConfigFromInputs() {
  const next = {
    rpcUrl: val("rpcUrl") || "",
    chainId: val("chainId") ? Number(val("chainId")) : 31337,
    shopsAddress: val("shopsAddress") || "",
    itemsAddress: val("itemsAddress") || "",
    itemsActionAddress: val("itemsActionAddress") || "",
    erc721ActionAddress: val("erc721ActionAddress") || "",
    defaultTemplateId: val("defaultTemplateId") || "",
    workerUrl: val("workerUrl") || "",
    workerApiUrl: val("workerApiUrl") || "",
    ipfsGateway: val("ipfsGateway") || "",
    apntsSaleUrl: val("apntsSaleUrl") || "",
    gtokenSaleUrl: val("gtokenSaleUrl") || ""
  };
  runtimeCfg = next;
  saveStoredConfig(next);
  chain = buildChain(next);
  publicClient = createPublicClient({
    chain,
    transport: http(next.rpcUrl || "http://127.0.0.1:8545")
  });
  walletClient = null;
  setText("txOut", "config applied (reconnect wallet if needed)");
}

async function loadConfigFromWorker() {
  const json = await workerApiGet("/config");
  if (!json?.ok) throw new Error("invalid worker /config response");
  document.getElementById("chainId").value = String(json.chainId ?? "");
  document.getElementById("rpcUrl").value = String(json.rpcUrl ?? "");
  document.getElementById("itemsAddress").value = String(json.itemsAddress ?? "");
  document.getElementById("shopsAddress").value = String(json.shopsAddress ?? "");
  setText("txOut", "loaded from worker /config");
}

async function renderPlaza(container) {
  container.appendChild(el("h2", { text: "广场（All Shops）" }));

  container.appendChild(el("div", { text: "多入口购买：aPNTs/GToken/Shop/Item。数据源默认 auto（优先 Worker Query API，失败则回退链上读取）。" }));

  const apntsSaleUrl = String(runtimeCfg.apntsSaleUrl || "").trim();
  const gtokenSaleUrl = String(runtimeCfg.gtokenSaleUrl || "").trim();

  const buildSaleCard = ({ title, supports, url, internalHref }) => {
    const externalRow = url
      ? el("div", {}, [el("span", { text: "外部入口：" }), el("a", { href: url, target: "_blank", rel: "noreferrer", text: url })])
      : el("div", { text: "外部入口：未配置" });
    const btnPrimary = el("button", {
      text: "打开内置购买页",
      onclick: () => {
        window.location.hash = internalHref;
      }
    });
    const btnSecondary = el("button", {
      text: url ? "打开外部入口" : "去配置外部入口",
      style: "margin-left: 8px;",
      onclick: () => {
        if (url) {
          window.open(url, "_blank", "noopener,noreferrer");
          return;
        }
        window.location.hash = "#/config";
      }
    });
    return el("div", {}, [
      el("h3", { text: title }),
      el("div", { text: `支持：${supports}` }),
      el("div", {}, [el("span", { text: "内置页：" }), el("a", { href: internalHref, text: internalHref })]),
      externalRow,
      el("div", {}, [btnPrimary, btnSecondary])
    ]);
  };

  container.appendChild(
    el("div", {}, [
      buildSaleCard({ title: "aPNTs 购买入口", supports: "USDT / USDC / ETH / WBTC", url: apntsSaleUrl, internalHref: "#/sale-apnts" }),
      buildSaleCard({ title: "GToken 购买入口", supports: "ETH / WBTC / aPNTs", url: gtokenSaleUrl, internalHref: "#/sale-gtoken" })
    ])
  );

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "快速购买" }),
      inputRow("itemId", "plazaQuickItemId", "1"),
      el("button", {
        text: "去买家入口",
        onclick: () => {
          const itemId = val("plazaQuickItemId");
          if (itemId) routeState.buyerItemId = String(itemId);
          window.location.hash = "#/buyer";
        }
      })
    ])
  );

  const sourceSelect = el("select", { id: "plazaSource" }, [
    el("option", { value: "auto", text: "auto" }),
    el("option", { value: "worker", text: "worker" }),
    el("option", { value: "chain", text: "chain" })
  ]);

  container.appendChild(
    el("div", {}, [
      inputRow("shopId filter(optional)", "plazaShopIdFilter", ""),
      inputRow("itemId filter(optional)", "plazaItemIdFilter", ""),
        inputRow("community owner(optional)", "plazaCommunityOwnerFilter", ""),
      inputRow("shops limit", "plazaShopLimit", "20"),
      inputRow("items limit", "plazaItemLimit", "50"),
      el("div", {}, [el("label", { for: "plazaSource", text: "source" }), sourceSelect])
    ])
  );

  const listBox = el("div", { id: "plazaList" });
  container.appendChild(el("button", { text: "Reload", onclick: () => load().catch(showTxError) }));
  container.appendChild(listBox);

  async function load() {
    setText("txOut", "loading plaza...");
    listBox.innerHTML = "";
    const shopLimit = Number(val("plazaShopLimit") || "20");
    const itemLimit = Number(val("plazaItemLimit") || "50");
    const source = val("plazaSource") || "auto";
    const fetchSource = source === "auto" ? undefined : source;

    const shopIdFilterRaw = val("plazaShopIdFilter");
    const itemIdFilterRaw = val("plazaItemIdFilter");
    const communityOwnerRaw = val("plazaCommunityOwnerFilter");
    const shopIdFilter = shopIdFilterRaw ? String(Number(shopIdFilterRaw)) : "";
    const itemIdFilter = itemIdFilterRaw ? String(Number(itemIdFilterRaw)) : "";
    const communityOwner = communityOwnerRaw ? communityOwnerRaw.trim().toLowerCase() : "";

    const { shops } = await fetchShopList({ cursor: 1n, limit: shopLimit, source: fetchSource });
    const { items } = await fetchItemList({ cursor: 1n, limit: itemLimit, source: fetchSource });

    const shopsById = new Map();
    for (const s of shops) shopsById.set(String(s.shopId), s.shop);

    const filteredShops = shopIdFilter ? shops.filter((s) => String(s.shopId) === shopIdFilter) : shops;
    let filteredItems = items;
    if (shopIdFilter) filteredItems = filteredItems.filter((it) => String(it.item.shopId) === shopIdFilter);
    if (itemIdFilter) filteredItems = filteredItems.filter((it) => String(it.itemId) === itemIdFilter);
    if (communityOwner) {
      filteredItems = filteredItems.filter((it) => {
        const shop = shopsById.get(String(it.item.shopId));
        return shop?.owner && String(shop.owner).toLowerCase() === communityOwner;
      });
      for (let i = filteredShops.length - 1; i >= 0; i -= 1) {
        const shopOwner = filteredShops[i]?.shop?.owner;
        if (!shopOwner || String(shopOwner).toLowerCase() !== communityOwner) filteredShops.splice(i, 1);
      }
    }

    listBox.appendChild(
      el("div", {
        text: `loaded: shops(${filteredShops.length}) ${sourceCountsLabel(filteredShops, (s) => s?.shop?.__source)} items(${filteredItems.length}) ${sourceCountsLabel(
          filteredItems,
          (it) => it?.item?.__source
        )}`
      })
    );

    const shopsEl = el("div", {}, [el("h3", { text: `Shops (${filteredShops.length})` })]);
    for (const s of filteredShops) {
      const shop = s.shop;
      shopsEl.appendChild(
        el("div", {}, [
          el("a", { href: `#/shop/${s.shopId}`, text: `Shop #${s.shopId}` }),
          el("span", { text: ` src=${shop.__source || ""}` }),
          el("span", { text: " owner=" }),
          addressNode(shop.owner),
          el("span", { text: " treasury=" }),
          addressNode(shop.treasury),
          el("span", { text: ` paused=${shop.paused}` }),
          el("button", {
            text: "查看店铺",
            style: "margin-left: 8px;",
            onclick: () => {
              window.location.hash = `#/shop/${s.shopId}`;
            }
          })
        ])
      );
    }
    listBox.appendChild(shopsEl);

    const itemsEl = el("div", {}, [el("h3", { text: `Items (${filteredItems.length})` })]);
    for (const it of filteredItems) {
      const item = it.item;
      const shop = shopsById.get(String(item.shopId));
      const actionLabel = item.action && !isZeroAddress(item.action) ? shortHex(item.action) : "none";
      const nftLabel = item.nftContract && !isZeroAddress(item.nftContract) ? shortHex(item.nftContract) : "none";
      const actionBytes = parseBytesLen(item.actionData);
      const tokenUriLabel = item.tokenURI ? shortText(item.tokenURI, 36) : "";
      itemsEl.appendChild(
        el("div", {}, [
          el("a", { href: `#/item/${it.itemId}`, text: `Item #${it.itemId}` }),
          el("span", {
            text: formatItemSummary(item, { includeShopId: true })
          }),
          el("span", { text: ` mint=${nftLabel} action=${actionLabel}${actionBytes != null ? ` actionBytes=${actionBytes}` : ""}` }),
          tokenUriLabel ? el("span", { text: ` tokenURI=${tokenUriLabel}` }) : null,
          shop ? el("span", {}, [el("span", { text: " shopOwner=" }), addressNode(shop.owner)]) : el("span", { text: "" }),
          el("button", {
            text: "Buy",
            style: "margin-left: 8px;",
            onclick: () => {
              routeState.buyerItemId = String(it.itemId);
              window.location.hash = "#/buyer";
            }
          })
        ])
      );
    }
    listBox.appendChild(itemsEl);

    setText("txOut", "plaza loaded");
  }

  document.getElementById("plazaShopLimit").value = "20";
  document.getElementById("plazaItemLimit").value = "50";
  document.getElementById("plazaSource").value = "auto";
  document.getElementById("plazaShopIdFilter").value = "";
  document.getElementById("plazaItemIdFilter").value = "";
  document.getElementById("plazaCommunityOwnerFilter").value = "";
  await load();
}

async function renderApntsSalePage(container) {
  const apntsSaleUrl = String(runtimeCfg.apntsSaleUrl || "").trim();
  const hero = el("div", {
    style:
      "padding: 24px; border-radius: 16px; background: linear-gradient(135deg, #0f172a, #1e293b); color: #f8fafc; margin-bottom: 16px;"
  });
  hero.appendChild(el("div", { text: "aPNTs Sale" }));
  hero.appendChild(el("h2", { text: "aPNTs 购买入口" }));
  hero.appendChild(el("div", { text: "社区积分发行的统一入口，兼顾可扩展与风控治理。" }));
  hero.appendChild(
    el("div", { style: "margin-top: 12px;" }, [
      el("span", { text: "支持：USDT / USDC / ETH / WBTC", style: "margin-right: 12px;" }),
      el("span", { text: "风控：发行速率 + 限购 + 价格保护" })
    ])
  );
  const primaryBtn = el("button", {
    text: apntsSaleUrl ? "打开外部购买入口" : "去配置外部入口",
    style: "margin-top: 16px;",
    onclick: () => {
      if (apntsSaleUrl) {
        window.open(apntsSaleUrl, "_blank", "noopener,noreferrer");
        return;
      }
      window.location.hash = "#/config";
    }
  });
  const secondaryBtn = el("button", {
    text: "查看广场商品",
    style: "margin-left: 8px;",
    onclick: () => {
      window.location.hash = "#/plaza";
    }
  });
  hero.appendChild(el("div", {}, [primaryBtn, secondaryBtn]));
  container.appendChild(hero);

  const grid = el("div", { style: "display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px;" });
  const cardStyle = "border: 1px solid #e5e7eb; border-radius: 14px; padding: 16px; background: #ffffff;";
  grid.appendChild(
    el("div", { style: cardStyle }, [
      el("h3", { text: "发行概览" }),
      el("div", { text: "不限量但不可滥发，支持按社区设定发行速率与限额。" }),
      el("div", { text: "当前策略：10%-20% 经济规模区间作为建议上限。" })
    ])
  );
  grid.appendChild(
    el("div", { style: cardStyle }, [
      el("h3", { text: "支付方式" }),
      el("div", { text: "稳定币：USDT / USDC" }),
      el("div", { text: "主流资产：ETH / WBTC" }),
      el("div", { text: "结算：进入 treasury + 可配置分润" })
    ])
  );
  grid.appendChild(
    el("div", { style: cardStyle }, [
      el("h3", { text: "风控承诺" }),
      el("div", { text: "发行速率限制 / 每地址限购 / 价格偏离保护" }),
      el("div", { text: "参数变更需 timelock 观察期" })
    ])
  );
  grid.appendChild(
    el("div", { style: cardStyle }, [
      el("h3", { text: "购买步骤" }),
      el("div", { text: "1. 连接钱包并选择支付资产" }),
      el("div", { text: "2. 确认风险提示与发行统计" }),
      el("div", { text: "3. 提交购买并查看交易记录" })
    ])
  );
  container.appendChild(grid);

  const footer = el("div", { style: "margin-top: 16px; padding: 16px; border-radius: 14px; background: #f8fafc;" }, [
    el("h3", { text: "发行统计预览" }),
    el("div", { text: "总发行：--" }),
    el("div", { text: "24h 发行：-- | 7d 发行：-- | 30d 发行：--" }),
    el("div", { text: "Top Buyers：--" })
  ]);
  container.appendChild(footer);
}

async function renderGTokenSalePage(container) {
  const gtokenSaleUrl = String(runtimeCfg.gtokenSaleUrl || "").trim();
  const hero = el("div", {
    style:
      "padding: 24px; border-radius: 16px; background: linear-gradient(135deg, #0b1220, #0f766e); color: #ecfeff; margin-bottom: 16px;"
  });
  hero.appendChild(el("div", { text: "GToken Sale" }));
  hero.appendChild(el("h2", { text: "GToken 购买入口" }));
  hero.appendChild(el("div", { text: "21,000,000 固定上限，面向社区的质押与治理资产。" }));
  hero.appendChild(
    el("div", { style: "margin-top: 12px;" }, [
      el("span", { text: "支持：ETH / WBTC / aPNTs", style: "margin-right: 12px;" }),
      el("span", { text: "合规：上限控制 + 价格来源保护" })
    ])
  );
  const primaryBtn = el("button", {
    text: gtokenSaleUrl ? "打开外部购买入口" : "去配置外部入口",
    style: "margin-top: 16px;",
    onclick: () => {
      if (gtokenSaleUrl) {
        window.open(gtokenSaleUrl, "_blank", "noopener,noreferrer");
        return;
      }
      window.location.hash = "#/config";
    }
  });
  const secondaryBtn = el("button", {
    text: "查看广场商品",
    style: "margin-left: 8px;",
    onclick: () => {
      window.location.hash = "#/plaza";
    }
  });
  hero.appendChild(el("div", {}, [primaryBtn, secondaryBtn]));
  container.appendChild(hero);

  const grid = el("div", { style: "display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px;" });
  const cardStyle = "border: 1px solid #e5e7eb; border-radius: 14px; padding: 16px; background: #ffffff;";
  grid.appendChild(
    el("div", { style: cardStyle }, [
      el("h3", { text: "供给上限" }),
      el("div", { text: "最大铸币量：21,000,000" }),
      el("div", { text: "合约强制校验 totalMinted + mintAmount <= CAP" })
    ])
  );
  grid.appendChild(
    el("div", { style: cardStyle }, [
      el("h3", { text: "定价策略" }),
      el("div", { text: "早期固定兑换率，稳定后支持预言机或 TWAP" }),
      el("div", { text: "保护：最大滑点阈值 + 价格刷新窗口" })
    ])
  );
  grid.appendChild(
    el("div", { style: cardStyle }, [
      el("h3", { text: "资金流向" }),
      el("div", { text: "资产进入 treasury（多签）" }),
      el("div", { text: "可配置分润到 shop / 社区基金" })
    ])
  );
  grid.appendChild(
    el("div", { style: cardStyle }, [
      el("h3", { text: "购买指引" }),
      el("div", { text: "1. 准备 ETH/WBTC/aPNTs" }),
      el("div", { text: "2. 连接钱包并确认兑换率" }),
      el("div", { text: "3. 查看交易记录与余额变化" })
    ])
  );
  container.appendChild(grid);

  const footer = el("div", { style: "margin-top: 16px; padding: 16px; border-radius: 14px; background: #f8fafc;" }, [
    el("h3", { text: "发行统计预览" }),
    el("div", { text: "已铸币总量：-- / 21,000,000" }),
    el("div", { text: "24h 发行：-- | 7d 发行：-- | 30d 发行：--" }),
    el("div", { text: "Top Buyers：--" })
  ]);
  container.appendChild(footer);
}

async function renderRiskPage(container) {
  container.appendChild(el("h2", { text: "风险评估与可视化风控" }));
  container.appendChild(
    el("div", {
      text: "基于社区性质、经济规模、发行占比与流动速度生成风险等级与建议上限。数值可模拟调整，用于验收展示。"
    })
  );

  const form = el("div", { style: "margin-top: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px;" });
  form.appendChild(el("div", {}, [inputRow("社区名称", "riskCommunityName", "BreadDAO")]));
  form.appendChild(el("div", {}, [inputRow("社区性质", "riskCommunityNature", "面包店 / 线下商户")]));
  form.appendChild(el("div", {}, [inputRow("核心活动", "riskCommunityActivity", "每日线上订购与线下兑换")]));
  form.appendChild(el("div", {}, [inputRow("经济规模估算(年, USD)", "riskEconomicScale", "200000")]));

  const scaleSelect = el("select", { id: "riskScaleLevel" }, [
    el("option", { value: "micro", text: "微型" }),
    el("option", { value: "small", text: "小型" }),
    el("option", { value: "medium", text: "中型" }),
    el("option", { value: "large", text: "大型" })
  ]);
  form.appendChild(el("div", {}, [el("label", { for: "riskScaleLevel", text: "规模档位" }), scaleSelect]));

  const ratioInput = el("input", { id: "riskIssuedRatio", type: "range", min: "0", max: "100", value: "35" });
  const velocityInput = el("input", { id: "riskVelocity", type: "range", min: "0", max: "100", value: "55" });
  form.appendChild(
    el("div", {}, [
      el("label", { for: "riskIssuedRatio", text: "已发行占比(%)" }),
      ratioInput,
      el("div", { id: "riskIssuedRatioLabel", text: "35%" })
    ])
  );
  form.appendChild(
    el("div", {}, [
      el("label", { for: "riskVelocity", text: "流动速度(%)" }),
      velocityInput,
      el("div", { id: "riskVelocityLabel", text: "55%" })
    ])
  );

  container.appendChild(form);

  const stats = el("div", { style: "margin-top: 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;" });
  const statCard = (title, id) =>
    el("div", { style: "border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; background: #ffffff;" }, [
      el("div", { text: title }),
      el("div", { id, style: "font-size: 20px; font-weight: 600;" })
    ]);
  const levelBadge = el("div", { id: "riskLevelBadge" });
  stats.appendChild(levelBadge);
  stats.appendChild(statCard("风险等级", "riskLevel"));
  stats.appendChild(statCard("风险系数", "riskScore"));
  stats.appendChild(statCard("建议发行上限", "riskCap"));
  stats.appendChild(statCard("更新时间", "riskUpdatedAt"));
  container.appendChild(stats);

  const chartBox = el("div", { style: "margin-top: 16px; border-radius: 14px; padding: 16px; background: #f8fafc;" });
  chartBox.appendChild(el("h3", { text: "可视化概览" }));
  const issuedBar = el("div", { style: "height: 10px; border-radius: 999px; background: #e2e8f0; overflow: hidden;" }, [
    el("div", { id: "issuedBar", style: "height: 10px; width: 35%; background: #10b981;" })
  ]);
  const velocityBar = el("div", { style: "height: 10px; border-radius: 999px; background: #e2e8f0; overflow: hidden;" }, [
    el("div", { id: "velocityBar", style: "height: 10px; width: 55%; background: #06b6d4;" })
  ]);
  chartBox.appendChild(el("div", { text: "发行占比" }));
  chartBox.appendChild(issuedBar);
  chartBox.appendChild(el("div", { style: "margin-top: 10px;", text: "流动速度" }));
  chartBox.appendChild(velocityBar);
  container.appendChild(chartBox);

  const detailBox = el("div", { style: "margin-top: 16px; border-radius: 14px; padding: 16px; background: #ffffff; border: 1px solid #e5e7eb;" });
  detailBox.appendChild(el("h3", { text: "发行统计" }));
  const statsMeta = el("div", { id: "riskStatsMeta", style: "margin-bottom: 8px; color: #64748b;" });
  const statsTextEl = el("div", { id: "riskStatsText" });
  detailBox.appendChild(statsMeta);
  detailBox.appendChild(
    el("button", {
      text: "刷新统计",
      onclick: () => loadRiskSummary().catch(showTxError)
    })
  );
  detailBox.appendChild(statsTextEl);
  container.appendChild(detailBox);

  const scaleMap = {
    micro: { label: "微型", capMin: 0.1, capMax: 0.15 },
    small: { label: "小型", capMin: 0.1, capMax: 0.18 },
    medium: { label: "中型", capMin: 0.12, capMax: 0.2 },
    large: { label: "大型", capMin: 0.12, capMax: 0.22 }
  };

  let riskSummary = null;

  function updateRiskView() {
    const issuedRatio = Number(ratioInput.value || "0");
    const velocity = Number(velocityInput.value || "0");
    document.getElementById("riskIssuedRatioLabel").textContent = `${issuedRatio}%`;
    document.getElementById("riskVelocityLabel").textContent = `${velocity}%`;

    const scaleKey = String(scaleSelect.value || "small");
    const scale = scaleMap[scaleKey] || scaleMap.small;
    const econ = Number(val("riskEconomicScale") || "0");
    const capMin = econ * scale.capMin;
    const capMax = econ * scale.capMax;
    const capLabel = econ ? `$${Math.round(capMin).toLocaleString()} - $${Math.round(capMax).toLocaleString()}` : "-";

    const ratioRisk = issuedRatio <= 40 ? 20 : issuedRatio <= 50 ? 50 : issuedRatio <= 80 ? 75 : 95;
    const velocityRisk = velocity >= 60 ? 10 : velocity >= 40 ? 30 : velocity >= 20 ? 55 : 75;
    const scaleRisk = scaleKey === "micro" ? 70 : scaleKey === "small" ? 55 : scaleKey === "medium" ? 40 : 30;
    const score = Math.min(100, Math.round(ratioRisk * 0.5 + velocityRisk * 0.3 + scaleRisk * 0.2));
    const level = issuedRatio >= 80 ? "红色预警" : issuedRatio >= 50 ? "黄色预警" : "绿色稳定";
    const color = level === "红色预警" ? "#dc2626" : level === "黄色预警" ? "#f59e0b" : "#16a34a";

    document.getElementById("riskLevel").textContent = level;
    document.getElementById("riskLevel").style.color = color;
    levelBadge.innerHTML = "";
    levelBadge.appendChild(
      el("span", {
        text: level.replace("预警", ""),
        style: `display:inline-block;padding:4px 8px;border-radius:999px;background:${color}20;color:${color};font-weight:600;`
      })
    );
    document.getElementById("riskScore").textContent = `${score}/100`;
    document.getElementById("riskCap").textContent = capLabel;
    const updatedAtText = riskSummary?.updatedAt ? new Date(riskSummary.updatedAt).toLocaleString() : new Date().toLocaleString();
    document.getElementById("riskUpdatedAt").textContent = updatedAtText;

    document.getElementById("issuedBar").style.width = `${issuedRatio}%`;
    document.getElementById("issuedBar").style.background = color;
    document.getElementById("velocityBar").style.width = `${velocity}%`;

    const name = val("riskCommunityName") || "-";
    const nature = val("riskCommunityNature") || "-";
    const activity = val("riskCommunityActivity") || "-";
    const statsText = [
      `社区：${name}（${nature}）`,
      `核心活动：${activity}`,
      `经济规模估算：${econ ? `$${Math.round(econ).toLocaleString()}` : "-"}`,
      `发行占比：${issuedRatio}%｜流动速度：${velocity}%｜规模档位：${scale.label}`,
      `风险系数：${score}/100（${level}）`
    ];
    if (riskSummary?.totalPurchases != null) {
      statsText.push(`统计来源：${riskSummary.source || "-"}`);
      statsText.push(`购买笔数：${riskSummary.totalPurchases ?? 0}｜购买人数：${riskSummary.uniqueBuyers ?? 0}`);
      statsText.push(`活跃店铺：${riskSummary.uniqueShops ?? 0}｜涉及商品：${riskSummary.uniqueItems ?? 0}`);
      statsText.push(`支付总额：${riskSummary.totalPayAmount ?? "0"}｜平台费：${riskSummary.totalPlatformFeeAmount ?? "0"}`);
      if (Array.isArray(riskSummary.topBuyers) && riskSummary.topBuyers.length > 0) {
        statsText.push(
          `Top Buyers：${riskSummary.topBuyers.map((b) => `${shortHex(b.buyer)}(${b.payAmount})`).join(", ")}`
        );
      }
      if (Array.isArray(riskSummary.topItems) && riskSummary.topItems.length > 0) {
        statsText.push(`Top Items：${riskSummary.topItems.map((it) => `#${it.itemId}(${it.payAmount})`).join(", ")}`);
      }
      if (riskSummary.lastPurchaseAt || riskSummary.lastPurchaseBlock) {
        statsText.push(`最后购买：${riskSummary.lastPurchaseAt ?? "-"}｜block ${riskSummary.lastPurchaseBlock ?? "-"}`);
      }
    }
    document.getElementById("riskStatsText").textContent = statsText.join("\n");
  }

  async function loadRiskSummary() {
    statsMeta.textContent = "加载统计中...";
    try {
      const res = await fetchRiskSummary({ source: "index" });
      riskSummary = res;
      statsMeta.textContent = `统计来源：${res.source || "-"}｜购买笔数：${res.totalPurchases ?? 0}`;
    } catch (e) {
      riskSummary = null;
      statsMeta.textContent = `统计不可用：${e instanceof Error ? e.message : String(e)}`;
    }
    updateRiskView();
  }

  ratioInput.addEventListener("input", updateRiskView);
  velocityInput.addEventListener("input", updateRiskView);
  scaleSelect.addEventListener("change", updateRiskView);
  document.getElementById("riskCommunityName").addEventListener("input", updateRiskView);
  document.getElementById("riskCommunityNature").addEventListener("input", updateRiskView);
  document.getElementById("riskCommunityActivity").addEventListener("input", updateRiskView);
  document.getElementById("riskEconomicScale").addEventListener("input", updateRiskView);

  updateRiskView();
  await loadRiskSummary();
}

async function renderShopDetail(container, shopId) {
  // Header
  const header = el("div", { class: "section-header" }, [
    el("h2", { text: `兑换柜台 #${shopId}` }),
    el("a", { href: "#/plaza", text: "← 广场", style: "font-size:0.9em" })
  ]);
  container.appendChild(header);

  // Shop info card
  const infoCard = el("div", { class: "card", id: "shopInfoCard", style: "margin-bottom:12px" });
  container.appendChild(infoCard);

  // Stats card
  const statsCard = el("div", { class: "card", id: "shopStatsCard", style: "margin-bottom:12px" });
  statsCard.appendChild(el("div", { text: "加载统计中...", style: "color:#999" }));
  container.appendChild(statsCard);

  // Items section
  const itemsSection = el("div", {});
  const itemsTitle = el("h3", { text: "可兑换项目" });
  const itemsGrid = el("div", { id: "shopItemsGrid", style: "display:flex;flex-wrap:wrap;gap:12px" });
  itemsSection.appendChild(itemsTitle);
  itemsSection.appendChild(itemsGrid);
  container.appendChild(itemsSection);

  // Load shop info
  let shop;
  try {
    shop = await fetchShop(shopId);
  } catch (e) {
    infoCard.appendChild(el("div", { text: `加载失败: ${e.message}`, style: "color:red" }));
    return;
  }

  if (shop.paused) {
    infoCard.appendChild(el("div", {
      text: "⚠️ 此柜台已暂停",
      style: "background:#fff3cd;padding:8px;border-radius:4px;margin-bottom:8px"
    }));
  }
  infoCard.appendChild(kv("柜台ID", shopId));
  infoCard.appendChild(kv("所有者", addressNode(shop.owner)));
  infoCard.appendChild(kv("Treasury", addressNode(shop.treasury)));
  infoCard.appendChild(kv("Metadata Hash", shortHex(shop.metadataHash)));
  infoCard.appendChild(kv("状态", shop.paused ? "🔴 暂停" : "🟢 运营中"));

  // Load stats async
  const workerApiUrl = getCurrentCfgValue("workerApiUrl");
  if (workerApiUrl) {
    (async () => {
      try {
        const statsRes = await fetch(`${workerApiUrl}/shop-stats?shopId=${shopId}`);
        const statsJson = await statsRes.json();
        statsCard.innerHTML = "";
        if (statsJson.ok && statsJson.stats) {
          const s = statsJson.stats;
          statsCard.appendChild(el("h4", { text: "统计数据", style: "margin:0 0 8px" }));
          const statsRow = el("div", { style: "display:flex;gap:24px;flex-wrap:wrap" });
          statsRow.appendChild(el("div", {}, [el("div", { text: String(s.totalPurchases || 0), style: "font-size:1.4em;font-weight:bold" }), el("div", { text: "成交笔数", style: "color:#888;font-size:0.85em" })]));
          statsRow.appendChild(el("div", {}, [el("div", { text: String(s.uniqueBuyers || 0), style: "font-size:1.4em;font-weight:bold" }), el("div", { text: "独立买家", style: "color:#888;font-size:0.85em" })]));
          statsRow.appendChild(el("div", {}, [el("div", { text: String(s.totalQuantity || 0), style: "font-size:1.4em;font-weight:bold" }), el("div", { text: "总兑换数量", style: "color:#888;font-size:0.85em" })]));
          statsRow.appendChild(el("div", {}, [el("div", { text: `${statsJson.itemCount || 0}`, style: "font-size:1.4em;font-weight:bold" }), el("div", { text: "上架项目", style: "color:#888;font-size:0.85em" })]));
          statsCard.appendChild(statsRow);
          statsCard.appendChild(el("div", { text: `数据来源: ${s.source}`, style: "color:#aaa;font-size:0.8em;margin-top:8px" }));
        } else {
          statsCard.appendChild(el("div", { text: "统计数据暂不可用", style: "color:#999" }));
        }
      } catch {
        statsCard.innerHTML = "";
        statsCard.appendChild(el("div", { text: "统计服务不可达", style: "color:#aaa;font-size:0.9em" }));
      }
    })();
  } else {
    statsCard.innerHTML = "";
    statsCard.appendChild(el("div", { text: "未配置 Worker API", style: "color:#aaa" }));
  }

  // Load items
  try {
    const { items } = await fetchItemList({ cursor: 1n, limit: 200 });
    const filtered = items.filter((x) => String(x.item?.shopId) === String(shopId));

    if (filtered.length === 0) {
      itemsGrid.appendChild(el("div", { text: "暂无可兑换项目。", style: "color:#999" }));
    } else {
      for (const it of filtered) {
        const item = it.item;
        const card = el("div", {
          class: "card",
          style: "width:200px;display:flex;flex-direction:column;gap:6px"
        });
        card.appendChild(el("a", {
          href: `#/item/${it.itemId}`,
          text: `Item #${it.itemId}`,
          style: "font-weight:bold"
        }));
        if (item?.tokenURI) {
          card.appendChild(el("div", { text: shortText(String(item.tokenURI), 40), style: "font-size:0.8em;color:#888" }));
        }
        const priceStr = item?.unitPrice ? `${item.unitPrice} ${formatPayToken(item.payToken)}` : "";
        if (priceStr) card.appendChild(el("div", { text: `价格: ${priceStr}`, style: "color:#2a7" }));
        if (item?.maxSupply && BigInt(item.maxSupply) > 0n) {
          card.appendChild(el("div", { text: `供应: ${item.maxSupply}`, style: "font-size:0.85em" }));
        }
        if (item?.paused) {
          card.appendChild(el("div", { text: "⏸ 暂停", style: "color:#e90" }));
        } else if (!item?.active) {
          card.appendChild(el("div", { text: "下架", style: "color:#999" }));
        } else {
          card.appendChild(el("a", {
            href: `#/item/${it.itemId}`,
            text: "→ 查看兑换",
            style: "color:#07c;font-size:0.9em"
          }));
        }
        itemsGrid.appendChild(card);
      }
    }
  } catch (e) {
    itemsGrid.appendChild(el("div", { text: `项目加载失败: ${e.message}`, style: "color:red" }));
  }
}

function parseBytesLen(hex) {
  const s = String(hex || "");
  if (!s.startsWith("0x")) return null;
  return Math.max(0, Math.floor((s.length - 2) / 2));
}

function buildPurchaseProof(p) {
  const itemsAddress = getCurrentCfgValue("itemsAddress");
  const chainId = p && p.chainId != null ? Number(p.chainId) : Number(chain?.id || 0);
  const serialHash = p.serialHash && String(p.serialHash) !== "0x" + "0".repeat(64) ? String(p.serialHash) : null;
  return {
    kind: "MyShopPurchaseProof",
    version: 1,
    chainId,
    itemsAddress: itemsAddress ? String(itemsAddress) : "",
    txHash: p.txHash ? String(p.txHash) : "",
    logIndex: p.logIndex != null ? Number(p.logIndex) : null,
    blockNumber: p.blockNumber != null ? Number(p.blockNumber) : null,
    itemId: p.itemId != null ? String(p.itemId) : "",
    shopId: p.shopId != null ? String(p.shopId) : "",
    buyer: p.buyer ? String(p.buyer) : "",
    recipient: p.recipient ? String(p.recipient) : "",
    quantity: p.quantity != null ? String(p.quantity) : "",
    payToken: p.payToken ? String(p.payToken) : "",
    payAmount: p.payAmount != null ? String(p.payAmount) : "",
    platformFeeAmount: p.platformFeeAmount != null ? String(p.platformFeeAmount) : "",
    serialHash,
    firstTokenId: p.firstTokenId != null ? String(p.firstTokenId) : ""
  };
}

function renderPurchasesList(container, { purchases, emptyText }) {
  container.innerHTML = "";
  if (!Array.isArray(purchases) || purchases.length === 0) {
    container.appendChild(el("div", { text: emptyText || "No purchases." }));
    return;
  }
  for (const p of purchases) {
    const serialHash = p.serialHash && String(p.serialHash) !== "0x0000000000000000000000000000000000000000000000000000000000000000" ? shortHex(p.serialHash) : "-";
    const item = p.item || null;
    const actionLabel = item?.action && !isZeroAddress(item.action) ? shortHex(item.action) : "none";
    const nftLabel = item?.nftContract && !isZeroAddress(item.nftContract) ? shortHex(item.nftContract) : "none";
    const actionBytes = item ? parseBytesLen(item.actionData) : null;
    const tokenUriLabel = item?.tokenURI ? shortText(String(item.tokenURI), 64) : "";
    const proofBox = el("div", { style: "margin-left: 12px; display: none;" });
    const proofPre = el("pre", { style: "white-space: pre-wrap;" });
    const proof = buildPurchaseProof(p);
    proofPre.textContent = JSON.stringify(proof, null, 2);
    const btnToggle = el("button", {
      text: "Proof",
      style: "margin-left: 8px;",
      onclick: () => {
        proofBox.style.display = proofBox.style.display === "none" ? "" : "none";
      }
    });
    const btnCopy = el("button", {
      text: "Copy",
      style: "margin-left: 8px;",
      onclick: async () => {
        const text = proofPre.textContent || "";
        try {
          if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            setText("txOut", "proof copied");
            return;
          }
        } catch {
        }
        setText("txOut", "copy not available; please select proof text manually");
      }
    });
    proofBox.appendChild(el("div", {}, [btnCopy]));
    proofBox.appendChild(proofPre);
    container.appendChild(
      el("div", {}, [
        el("div", {}, [
          el("span", { text: `block=${p.blockNumber ?? ""} ` }),
          txLinkNode(p.txHash),
          el("span", { text: " item=" }),
          el("a", { href: `#/item/${p.itemId}`, text: `#${p.itemId}` }),
          el("span", { text: " shop=" }),
          el("a", { href: `#/shop/${p.shopId}`, text: `#${p.shopId}` }),
          el("span", {
            text: ` qty=${p.quantity} payToken=${formatPayToken(p.payToken)} payAmount=${p.payAmount} fee=${p.platformFeeAmount} firstTokenId=${p.firstTokenId} serialHash=${serialHash} buyer=`
          }),
          addressNode(p.buyer),
          el("span", { text: " recipient=" }),
          addressNode(p.recipient),
          btnToggle
        ]),
        item
          ? el("div", {
            style: "margin-left: 18px; color: #64748b;",
            text: `action=${actionLabel} actionBytes=${actionBytes ?? ""} nft=${nftLabel} tokenURI=${tokenUriLabel}`
          })
          : null,
        proofBox
      ])
    );
  }
}

// F1: IPFS multi-gateway fetch
const IPFS_GATEWAYS = [
  "https://cloudflare-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/"
];

async function fetchIpfs(cid) {
  for (const gw of IPFS_GATEWAYS) {
    try {
      const res = await fetch(gw + cid, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return res.json();
    } catch {
      // try next gateway
    }
  }
  return null;
}

async function fetchIpfsMetadata(tokenURI) {
  if (!tokenURI) return null;
  if (tokenURI.startsWith("ipfs://")) {
    const cid = tokenURI.slice(7);
    return fetchIpfs(cid);
  }
  // Fallback: use existing gateway-aware fetch
  return fetchMetadataFromTokenUri(tokenURI);
}

// F3: Purchase state machine
// States: idle -> checking -> awaiting_permit -> awaiting_approval -> pending -> confirming -> success | error
let purchaseState = { state: "idle", txHash: null, tokenId: null, error: null, blockNumber: null };

function setPurchaseState(next) {
  purchaseState = { ...purchaseState, ...next };
  renderPurchaseStateBars();
}

function renderPurchaseStateBars() {
  const bars = document.querySelectorAll(".purchase-state-bar");
  if (!bars.length) return;
  const { state, txHash, tokenId, error, blockNumber } = purchaseState;
  let text = "";
  let color = "#64748b";
  if (state === "idle") { text = ""; color = "#64748b"; }
  else if (state === "checking") { text = "Checking eligibility..."; color = "#2563eb"; }
  else if (state === "awaiting_permit") { text = "Getting serial permit..."; color = "#7c3aed"; }
  else if (state === "awaiting_approval") { text = "Approve token spending in wallet..."; color = "#d97706"; }
  else if (state === "pending") {
    const explorerBase = explorerBaseUrl(chain?.id);
    text = `Transaction submitted...`;
    color = "#0891b2";
    for (const bar of bars) {
      bar.innerHTML = "";
      bar.style.color = color;
      bar.appendChild(document.createTextNode("Transaction submitted... "));
      if (txHash && explorerBase) {
        bar.appendChild(el("a", { href: `${explorerBase}/tx/${txHash}`, target: "_blank", rel: "noreferrer", text: shortHex(txHash) }));
      } else if (txHash) {
        bar.appendChild(el("span", { text: shortHex(txHash) }));
      }
    }
    return;
  }
  else if (state === "confirming") {
    text = `Waiting for confirmation...${blockNumber ? ` (block ${blockNumber})` : ""}`;
    color = "#0891b2";
  }
  else if (state === "success") {
    const explorerBase = explorerBaseUrl(chain?.id);
    for (const bar of bars) {
      bar.innerHTML = "";
      bar.style.color = "#16a34a";
      bar.appendChild(el("span", { text: `Redeemed!${tokenId != null ? ` NFT #${tokenId} received` : ""} ` }));
      bar.appendChild(el("a", { href: "#/my", text: "View My NFTs" }));
    }
    return;
  }
  else if (state === "error") {
    for (const bar of bars) {
      bar.innerHTML = "";
      bar.style.color = "#dc2626";
      bar.appendChild(el("span", { text: translateRevertReason({ message: error || "" }) }));
    }
    return;
  }
  for (const bar of bars) {
    bar.textContent = text;
    bar.style.color = color;
  }
}

async function buyWithStateMachine({ itemId, quantity, recipient, extraData, ethValue }) {
  if (!walletClient || !connectedAddress) throw new Error("connect wallet first");
  const itemsAddress = requireAddress(getCurrentCfgValue("itemsAddress"), "itemsAddress");

  setPurchaseState({ state: "checking", txHash: null, tokenId: null, error: null });

  try {
    setPurchaseState({ state: "awaiting_approval" });
    await runWriteTx({
      label: `buy itemId=${itemId.toString()} qty=${quantity.toString()}`,
      buttonIds: ["btnItemDetailRedeem"],
      onStatus: (status, meta) => {
        if (status === "waiting_wallet") setPurchaseState({ state: "awaiting_approval" });
        else if (status === "pending") setPurchaseState({ state: "pending", txHash: meta.hash || null });
        else if (status === "success") setPurchaseState({ state: "confirming" });
        else if (status === "error") setPurchaseState({ state: "error", error: meta.error || "unknown error" });
      },
      write: () =>
        walletClient.writeContract({
          address: itemsAddress,
          abi: myShopItemsAbi,
          functionName: "buy",
          args: [itemId, quantity, recipient, extraData],
          account: connectedAddress,
          value: ethValue ? parseEther(ethValue) : undefined
        })
    });

    // Try to read firstTokenId from logs
    let tokenId = null;
    try {
      if (lastTx?.hash) {
        const receipt = await publicClient.getTransactionReceipt({ hash: lastTx.hash });
        for (const log of receipt.logs || []) {
          try {
            const decoded = decodeEventLog({ abi: myShopItemsAbi, data: log.data, topics: log.topics });
            if (decoded?.eventName === "Purchased" && decoded.args?.firstTokenId != null) {
              tokenId = decoded.args.firstTokenId.toString();
              break;
            }
          } catch {
            // skip
          }
        }
      }
    } catch {
      // non-fatal
    }
    setPurchaseState({ state: "success", tokenId });
  } catch (e) {
    const errMsg = getErrorText(e);
    setPurchaseState({ state: "error", error: errMsg });
    throw e;
  }
}

// F2: My History Page (#/my)
async function renderMyHistoryPage(container) {
  container.appendChild(el("h2", { text: "My Redemptions (#/my)" }));

  if (!connectedAddress) {
    container.appendChild(el("div", { text: "Please connect your wallet to view your redemptions." }));
    container.appendChild(
      el("button", {
        text: "Connect Wallet",
        onclick: () => connect().catch(showTxError)
      })
    );
    return;
  }

  const addrShort = shortHex(connectedAddress);
  container.appendChild(kv("Wallet", el("span", { text: addrShort })));

  const loadingMsg = el("div", { text: "Loading redemptions..." });
  container.appendChild(loadingMsg);

  const listBox = el("div", { id: "myHistoryList" });
  container.appendChild(listBox);

  let purchases = [];
  try {
    const res = await fetchPurchases({ buyer: connectedAddress, limit: 100 });
    purchases = res.purchases || [];
  } catch (e) {
    loadingMsg.textContent = `Failed to load: ${getErrorText(e)}`;
    return;
  }

  loadingMsg.remove();

  if (purchases.length === 0) {
    listBox.appendChild(el("div", { text: "No redemptions yet." }));
    return;
  }

  listBox.appendChild(el("div", { text: `${purchases.length} redemption(s) found.` }));

  // Fetch IPFS metadata names in background; use a cache
  const metaCache = new Map();

  for (const p of purchases) {
    const row = el("div", { style: "border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; margin: 6px 0;" });

    const item = p.item || null;
    const shopName = `Shop #${p.shopId}`;
    const itemNameEl = el("span", { text: `Item #${p.itemId}` });
    const explorerBase = explorerBaseUrl(chain?.id);
    const txLink = explorerBase && p.txHash
      ? el("a", { href: `${explorerBase}/tx/${p.txHash}`, target: "_blank", rel: "noreferrer", text: shortHex(p.txHash) })
      : el("span", { text: shortHex(p.txHash || "") });

    const dateText = p.blockNumber ? `block ${p.blockNumber}` : "";
    const tokenIdText = p.firstTokenId != null ? `Token #${p.firstTokenId}` : "";

    row.appendChild(
      el("div", {}, [
        el("strong", {}, [itemNameEl]),
        el("span", { text: ` — ${shopName}` }),
        tokenIdText ? el("span", { text: ` — ${tokenIdText}` }) : null,
        el("span", { text: " — tx: " }),
        txLink,
        dateText ? el("span", { text: ` — ${dateText}` }) : null
      ])
    );
    listBox.appendChild(row);

    // Async populate item name from IPFS metadata
    if (item && item.tokenURI) {
      const uri = item.tokenURI;
      (async () => {
        try {
          let meta = metaCache.get(uri);
          if (!meta) {
            meta = await fetchIpfsMetadata(uri);
            if (meta) metaCache.set(uri, meta);
          }
          if (meta && meta.name) {
            itemNameEl.textContent = `${meta.name} (Item #${p.itemId})`;
          }
        } catch {
          // non-fatal
        }
      })();
    }
  }
}

async function renderItemDetail(container, itemId) {
  // Reset purchase state machine for this page
  setPurchaseState({ state: "idle", txHash: null, tokenId: null, error: null });

  container.appendChild(el("h2", { text: `Item #${itemId}` }));

  // F1: IPFS metadata (show loading placeholder, fill in async)
  const metaNameEl = el("div", { text: "Loading..." });
  const metaDescEl = el("div", { text: "" });
  const metaImgEl = el("div");
  container.appendChild(
    el("div", { style: "margin-bottom: 8px;" }, [metaNameEl, metaDescEl, metaImgEl])
  );

  const out = el("div", { id: "itemDetailOut" });
  container.appendChild(out);

  const item = await fetchItem(itemId);

  // F1: Paused / active status badge
  let shopPaused = false;
  try {
    const shop = await fetchShop(item.shopId);
    shopPaused = !!shop.paused;
  } catch {
    // non-fatal
  }
  const isPaused = shopPaused || !item.active;
  if (isPaused) {
    container.appendChild(
      el("div", {
        style: "display:inline-block;padding:3px 10px;border-radius:999px;background:#fef2f2;color:#dc2626;font-weight:600;margin-bottom:6px;",
        text: shopPaused ? "Shop Paused" : "Item Paused"
      })
    );
  }

  out.appendChild(kv("source", String(item.__source || "")));
  out.appendChild(kv("shopId", el("a", { href: `#/shop/${item.shopId}`, text: `Shop #${item.shopId}` })));
  out.appendChild(kv("active", String(item.active)));

  // F1: Price
  const tokenSymbol = formatPayToken(item.payToken);
  out.appendChild(kv("price", `${item.unitPrice} ${tokenSymbol}`));
  out.appendChild(kv("payToken", formatPayToken(item.payToken)));
  out.appendChild(kv("unitPrice", String(item.unitPrice)));

  // F1: Stock status — maxSupply / perWallet from worker item data if available
  const maxSupply = item.maxSupply != null ? Number(item.maxSupply) : (item.maxItems != null ? Number(item.maxItems) : null);
  const soldCount = item.soldCount != null ? Number(item.soldCount) : null;
  const perWallet = item.perWallet != null ? Number(item.perWallet) : null;
  const startTime = item.startTime != null ? Number(item.startTime) : null;
  const endTime = item.endTime != null ? Number(item.endTime) : null;

  if (maxSupply !== null) {
    const stockText = maxSupply === 0
      ? "Unlimited"
      : soldCount !== null
        ? `${maxSupply - soldCount} / ${maxSupply} remaining`
        : `Max: ${maxSupply}`;
    out.appendChild(kv("stock", stockText));
  }

  if (perWallet !== null && perWallet > 0) {
    out.appendChild(kv("perWalletLimit", `Limit: ${perWallet} per wallet`));
  }

  // F1: Time window
  if (startTime) {
    out.appendChild(kv("startTime", new Date(startTime * 1000).toLocaleString()));
  }
  if (endTime) {
    out.appendChild(kv("endTime", new Date(endTime * 1000).toLocaleString()));
  }

  out.appendChild(kv("requiresSerial", String(item.requiresSerial)));
  out.appendChild(kv("soulbound", String(item.soulbound)));
  out.appendChild(kv("nftContract", addressNode(item.nftContract)));
  out.appendChild(kv("action", item.action && !isZeroAddress(item.action) ? addressNode(item.action) : "none"));
  out.appendChild(kv("actionDataBytes", String(parseBytesLen(item.actionData) ?? "")));
  out.appendChild(kv("actionData", item.actionData ? shortText(String(item.actionData), 80) : ""));
  const tokenUriHttp = toHttpUri(item.tokenURI);
  out.appendChild(kv("tokenURI", tokenUriHttp ? el("a", { href: tokenUriHttp, target: "_blank", rel: "noreferrer", text: tokenUriHttp }) : (item.tokenURI || "")));

  try {
    const itemsAddressVal = val("itemsAddress") || runtimeCfg.itemsAddress;
    const itemsAddress = requireAddress(itemsAddressVal, "itemsAddress");
    const defaultVersion = await publicClient.readContract({
      address: itemsAddress,
      abi: myShopItemsAbi,
      functionName: "itemDefaultPageVersion",
      args: [BigInt(itemId)]
    });
    const v = BigInt(defaultVersion);
    if (v > 0n) {
      const raw = await publicClient.readContract({
        address: itemsAddress,
        abi: myShopItemsAbi,
        functionName: "getItemPage",
        args: [BigInt(itemId), v]
      });
      const uri = pick(raw, "uri", 1);
      const contentHash = pick(raw, "contentHash", 0);
      out.appendChild(kv("defaultPageVersion", v.toString()));
      out.appendChild(kv("pageContentHash", shortHex(contentHash)));
      out.appendChild(kv("pageUri", uri ? el("a", { href: uri, target: "_blank", rel: "noreferrer", text: uri }) : ""));
    } else {
      out.appendChild(kv("defaultPageVersion", "0"));
    }
  } catch {
    out.appendChild(kv("defaultPageVersion", "unknown"));
  }

  // F1: IPFS metadata with multi-gateway fallback (async fill)
  (async () => {
    try {
      const meta = await fetchIpfsMetadata(item.tokenURI);
      if (meta) {
        const name = String(meta.name || "");
        const desc = String(meta.description || "");
        metaNameEl.textContent = name || `Item #${itemId}`;
        metaDescEl.textContent = desc;
        const imgSrc = meta.image || meta.image_url || "";
        const imgUrl = toHttpUri(imgSrc);
        if (imgUrl) {
          const img = el("img", { src: imgUrl, style: "max-width: 320px; display: block; margin: 8px 0;" });
          img.onerror = () => { img.style.display = "none"; };
          metaImgEl.appendChild(img);
        }
      } else {
        metaNameEl.textContent = `Item #${itemId}`;
      }
    } catch {
      metaNameEl.textContent = `Item #${itemId}`;
    }
  })();

  // F1: Purchase eligibility check
  const eligibilityBox = el("div", { style: "margin: 8px 0;" });
  container.appendChild(eligibilityBox);
  if (connectedAddress && perWallet != null && perWallet > 0) {
    (async () => {
      try {
        const res = await fetchPurchases({ buyer: connectedAddress, itemId: String(itemId), limit: 500 });
        const walletCount = (res.purchases || []).reduce((sum, p) => sum + Number(p.quantity || 1), 0);
        if (walletCount >= perWallet) {
          eligibilityBox.appendChild(
            el("div", {
              style: "display:inline-block;padding:3px 10px;border-radius:999px;background:#fef9c3;color:#92400e;font-weight:600;",
              text: `Limit reached (${walletCount}/${perWallet})`
            })
          );
        }
      } catch {
        // non-fatal
      }
    })();
  }

  // F3: Purchase state machine status bar
  const stateBar = el("div", { class: "purchase-state-bar", style: "min-height: 22px; margin: 8px 0; font-weight: 500;" });
  container.appendChild(stateBar);

  // F1: Redeem button (triggers F3 state machine)
  const redeemSection = el("div", { style: "margin: 12px 0;" });
  redeemSection.appendChild(el("h3", { text: "Redeem" }));
  redeemSection.appendChild(el("div", { text: "qty: 1 | recipient: connected wallet" }));
  if (item.requiresSerial) {
    redeemSection.appendChild(el("div", { text: "Note: this item requires a serial permit. Use the Buyer page for serial-based purchase." }));
  }
  const redeemBtn = el("button", {
    id: "btnItemDetailRedeem",
    text: "Redeem",
    style: "margin-top: 8px;",
    onclick: () => {
      if (!connectedAddress) {
        connect().catch(showTxError);
        return;
      }
      if (item.requiresSerial) {
        routeState.buyerItemId = String(itemId);
        window.location.hash = "#/buyer";
        return;
      }
      setPurchaseState({ state: "idle" });
      buyWithStateMachine({
        itemId: BigInt(itemId),
        quantity: 1n,
        recipient: getAddress(connectedAddress),
        extraData: "0x",
        ethValue: ""
      }).catch((e) => {
        showTxError(e);
      });
    }
  });
  redeemSection.appendChild(redeemBtn);
  redeemSection.appendChild(
    el("button", {
      text: "Advanced Buy (Buyer Page)",
      style: "margin-left: 8px;",
      onclick: () => {
        routeState.buyerItemId = String(itemId);
        window.location.hash = "#/buyer";
      }
    })
  );
  container.appendChild(redeemSection);

  // F1: Recent purchases (last 5)
  container.appendChild(el("hr"));
  container.appendChild(el("h3", { text: "Recent Purchases" }));
  const purchasesOut = el("div", { id: "purchasesOut" });
  container.appendChild(
    el("button", {
      text: "Reload Purchases",
      onclick: () => loadPurchases().catch(showTxError)
    })
  );
  container.appendChild(
    el("button", {
      text: "View All Purchases",
      style: "margin-left: 8px;",
      onclick: () => {
        window.location.hash = `#/purchases?itemId=${encodeURIComponent(String(itemId))}`;
      }
    })
  );
  container.appendChild(purchasesOut);

  async function loadPurchases() {
    const res = await fetchPurchases({ itemId: String(itemId), limit: 5 });
    const header = el("div", { text: `source=${res.source || ""} count=${res.count || 0}` });
    purchasesOut.innerHTML = "";
    purchasesOut.appendChild(header);
    const list = el("div", {});
    purchasesOut.appendChild(list);
    renderPurchasesList(list, { purchases: res.purchases, emptyText: "No purchases for this item." });
  }

  await loadPurchases();
}

async function renderPurchasesPage(container, query = {}) {
  container.appendChild(el("h2", { text: "购买记录（Purchases）" }));
  container.appendChild(el("div", { text: "数据源：默认走 Worker Index；也可切换为 chain 扫描（更慢但更接近链上真实）。" }));

  const sourceSelect = el("select", { id: "purchasesSource" }, [
    el("option", { value: "auto", text: "auto" }),
    el("option", { value: "index", text: "index" }),
    el("option", { value: "chain", text: "chain" })
  ]);

  container.appendChild(
    el("div", {}, [
      inputRow("buyer(optional)", "purchasesBuyer", query.buyer || connectedAddress || ""),
      inputRow("shopId(optional)", "purchasesShopId", query.shopId || ""),
      inputRow("itemId(optional)", "purchasesItemId", query.itemId || ""),
      inputRow("limit", "purchasesLimit", query.limit || "50"),
      inputRow("fromBlock(optional)", "purchasesFromBlock", query.fromBlock || ""),
      inputRow("toBlock(optional)", "purchasesToBlock", query.toBlock || ""),
      el("div", {}, [el("label", { for: "purchasesSource", text: "source" }), sourceSelect]),
      el("button", {
        text: "Mine",
        onclick: () => {
          if (!connectedAddress) {
            setText("txOut", "[WalletRequired] 请先连接钱包");
            return;
          }
          document.getElementById("purchasesBuyer").value = connectedAddress;
        }
      }),
      el("button", {
        text: "Clear",
        style: "margin-left: 8px;",
        onclick: () => {
          document.getElementById("purchasesBuyer").value = "";
          document.getElementById("purchasesShopId").value = "";
          document.getElementById("purchasesItemId").value = "";
          document.getElementById("purchasesFromBlock").value = "";
          document.getElementById("purchasesToBlock").value = "";
        }
      }),
      el("button", { text: "Load", onclick: () => load().catch(showTxError) })
    ])
  );
  document.getElementById("purchasesSource").value = query.source || "index";

  const meta = el("div", { id: "purchasesMeta" });
  const list = el("div", { id: "purchasesList" });
  container.appendChild(meta);
  container.appendChild(list);

  function buildRiskBadgeByCount(n) {
    const level = n >= 100 ? "红色" : n >= 30 ? "黄色" : "绿色";
    const color = level === "红色" ? "#dc2626" : level === "黄色" ? "#f59e0b" : "#16a34a";
    return el("span", {
      text: `风险：${level}`,
      style: `display:inline-block;margin-left:8px;padding:2px 6px;border-radius:999px;background:${color}20;color:${color};font-weight:600;`
    });
  }

  async function load() {
    setText("txOut", "loading purchases...");
    const buyer = val("purchasesBuyer") || undefined;
    const shopId = val("purchasesShopId") || undefined;
    const itemId = val("purchasesItemId") || undefined;
    const limit = Number(val("purchasesLimit") || "50");
    const fromBlock = val("purchasesFromBlock") || undefined;
    const toBlock = val("purchasesToBlock") || undefined;
    const source = val("purchasesSource") || "index";

    const res = await fetchPurchases({ buyer, shopId, itemId, limit, source, fromBlock, toBlock });
    meta.innerHTML = "";
    meta.appendChild(
      el("div", {
        text: `source=${res.source || ""} count=${res.count || 0} fromBlock=${res.fromBlock || ""} toBlock=${res.toBlock || ""} indexedToBlock=${res.indexedToBlock || ""}`
      })
    );
    meta.appendChild(buildRiskBadgeByCount(Number(res.count || 0)));
    renderPurchasesList(list, { purchases: res.purchases, emptyText: "No purchases matched filters." });
    setText("txOut", "purchases loaded");
  }

  await load();
}

async function renderBuyer(container) {
  container.appendChild(el("h2", { text: "买家入口（Buyer）" }));
  container.appendChild(el("div", { text: "流程：选 item →（可选）请求串号签名 → approve → buy" }));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Read Item" }),
      inputRow("itemId", "itemIdRead", routeState.buyerItemId || "1"),
      el("button", { text: "Read Item", onclick: () => readItem().catch(showTxError) }),
      el("pre", { id: "itemOut" }),
      el("div", { id: "itemMetaOut" })
    ])
  );

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Buy" }),
      el("div", {}, [el("strong", { text: "Buy Status" }), el("pre", { id: "buyFlowOut" })]),
      inputRow("itemId", "buyItemId", routeState.buyerItemId || "1"),
      inputRow("qty", "buyQty", "1"),
      inputRow("recipient", "buyRecipient", connectedAddress || ""),
      inputRow("buyer(for permit)", "buyBuyer", connectedAddress || ""),
      inputRow("payToken(for approve)", "buyPayToken"),
      inputRow("approveAmount(uint256)", "buyApproveAmount", "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
      el("button", { id: "btnApprove", text: "Approve", onclick: () => approvePayToken().catch(showTxError) }),
      el("h4", { text: "Serial Permit (optional)" }),
      inputRow("serial", "serial", "SERIAL-001"),
      inputRow("deadline(ts)", "serialDeadline", String(Math.floor(Date.now() / 1000) + 3600)),
      inputRow("extraData(hex)", "buyExtraData", "0x"),
      el("button", { text: "Fetch extraData", onclick: () => fetchSerialExtraData().catch(showTxError) }),
      inputRow("ethValue(optional)", "buyEthValue", ""),
      el("button", { id: "btnBuy", text: "Buy", onclick: () => buy().catch(showTxError) })
    ])
  );

  routeState.buyerItemId = null;
}

async function renderShopConsole(container, query = {}) {
  container.appendChild(el("h2", { text: "店主/运营后台（Shop Owner / Operator）" }));
  container.appendChild(
    el("div", { text: "提示：写操作会校验 shop owner / protocol owner / shopRoles；失败时会给出可操作提示。" })
  );

  const accessOut = el("pre", { id: "shopAccessOut" });
  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Access Check" }),
      inputRow("shopId", "shopIdAccess", query.shopId || "1"),
      el("button", {
        text: "Check Access",
        onclick: async () => {
          const shopId = BigInt(val("shopIdAccess"));
          const actor = getAddress(connectedAddress);
          const access = await getShopAccess({ shopId, actor });
          accessOut.textContent = JSON.stringify(access, null, 2);
          if (access.isProtocolOwner || access.isShopOwner || access.rolesMask !== 0) {
            window.location.hash = `#/shop-console?shopId=${shopId.toString()}`;
          }
        }
      }),
      accessOut
    ])
  );

  const refreshAccess = async () => {
    const shopId = BigInt(val("shopIdAccess"));
    const actor = getAddress(connectedAddress);
    const access = await getShopAccess({ shopId, actor });
    accessOut.textContent = JSON.stringify(access, null, 2);
    return access;
  };
  const initialAccess = await refreshAccess();

  if (!initialAccess.isProtocolOwner && !initialAccess.isShopOwner && initialAccess.rolesMask === 0) {
    container.appendChild(
      el("div", {
        style: "color: #b91c1c;",
        text: "当前钱包在该 shopId 下没有权限：无法进入店主后台。请切换 shopId 或切换钱包后重试。"
      })
    );
    return;
  }

  const roleConfig = normalizeRoleConfig(initialAccess.roleConfig);
  roleConfigState = roleConfig;
  const roleMaskShopAdmin = buildRoleMask(roleConfig, ["shopAdmin"]);
  const roleMaskMaintainer = buildRoleMask(roleConfig, ["shopAdmin", "itemMaintainer"]);
  const roleMaskEditor = buildRoleMask(roleConfig, ["shopAdmin", "itemEditor", "itemActionEditor"]);
  const roleMaskActionEditor = buildRoleMask(roleConfig, ["shopAdmin", "itemActionEditor"]);
  const roleMaskAll = buildRoleMask(roleConfig, ["shopAdmin", "itemMaintainer", "itemEditor", "itemActionEditor"]);

  const guardShop = ({ shopIdInputId, anyRolesMask = 0 }) => async (action) => {
    const shopId = BigInt(val(shopIdInputId));
    await requireShopAccess({ shopId, anyRolesMask });
    return action();
  };
  const guardItem = ({ itemIdInputId, anyRolesMask = 0 }) => async (action) => {
    const itemId = BigInt(val(itemIdInputId));
    await requireItemAccess({ itemId, anyRolesMask });
    return action();
  };

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Shop Roles" }),
      inputRow("shopId", "shopIdRole", "1"),
      inputRow("operator", "roleOperator"),
      el("div", {}, [
        el("label", {}, [
          el("input", { id: "roleShopAdmin", type: "checkbox" }),
          el("span", { text: ` shop admin(${roleConfig.shopAdmin})` })
        ])
      ]),
      el("div", {}, [
        el("label", {}, [
          el("input", { id: "roleItemMaintainer", type: "checkbox", checked: true }),
          el("span", { text: ` item maintainer(${roleConfig.itemMaintainer})` })
        ])
      ]),
      el("div", {}, [
        el("label", {}, [
          el("input", { id: "roleItemEditor", type: "checkbox", checked: true }),
          el("span", { text: ` item editor(${roleConfig.itemEditor})` })
        ])
      ]),
      el("div", {}, [
        el("label", {}, [
          el("input", { id: "roleItemActionEditor", type: "checkbox", checked: true }),
          el("span", { text: ` item+action editor(${roleConfig.itemActionEditor})` })
        ])
      ]),
      el("button", {
        text: "Set Roles",
        onclick: () =>
          guardShop({ shopIdInputId: "shopIdRole", anyRolesMask: roleMaskShopAdmin })(() => setShopRolesTx()).catch(showTxError)
      })
    ])
  );

  const roleOperatorEl = document.getElementById("roleOperator");
  if (roleOperatorEl && !String(roleOperatorEl.value || "").trim() && connectedAddress) roleOperatorEl.value = connectedAddress;

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Register Shop" }),
      inputRow("treasury", "shopTreasury"),
      inputRow("metadataHash(bytes32)", "shopMetadataHash", "0x" + "0".repeat(64)),
      el("button", { text: "Register", onclick: () => registerShop().catch(showTxError) })
    ])
  );

  const shopTreasuryEl = document.getElementById("shopTreasury");
  if (shopTreasuryEl && !String(shopTreasuryEl.value || "").trim() && connectedAddress) shopTreasuryEl.value = connectedAddress;

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Update Shop" }),
      inputRow("shopId", "shopIdUpdateShop", "1"),
      inputRow("treasury", "shopTreasuryUpdateShop"),
      inputRow("metadataHash(bytes32)", "shopMetadataHashUpdateShop", "0x" + "0".repeat(64)),
      el("button", {
        text: "Update",
        onclick: () =>
          guardShop({ shopIdInputId: "shopIdUpdateShop", anyRolesMask: roleMaskShopAdmin })(() => updateShopTx()).catch(showTxError)
      })
    ])
  );

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Pause Shop (shop admin or protocol governance)" }),
      inputRow("shopId", "shopIdPause", "1"),
      inputRow("paused(true|false)", "shopPaused", "true"),
      el("button", {
        text: "Set",
        onclick: () =>
          guardShop({ shopIdInputId: "shopIdPause", anyRolesMask: roleMaskShopAdmin })(() => setShopPausedTx()).catch(showTxError)
      })
    ])
  );

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Item Active (maintainer)" }),
      inputRow("itemId", "itemIdActive", "1"),
      inputRow("active(true|false)", "itemActive", "true"),
      el("button", {
        text: "Set Active",
        onclick: () =>
          guardItem({ itemIdInputId: "itemIdActive", anyRolesMask: roleMaskMaintainer })(() => setItemActiveTx()).catch(showTxError)
      })
    ])
  );

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Update Item (basic)" }),
      inputRow("itemId", "itemIdUpdate", "1"),
      inputRow("payToken", "payTokenUpdate"),
      inputRow("unitPrice", "unitPriceUpdate", "1000"),
      inputRow("nftContract", "nftContractUpdate"),
      inputRow("soulbound(true|false)", "soulboundUpdate", "true"),
      inputRow("tokenURI", "tokenURIUpdate", "ipfs://token"),
      inputRow("requiresSerial(true|false)", "requiresSerialUpdate", "true"),
      el("button", {
        text: "Update Item",
        onclick: () =>
          guardItem({ itemIdInputId: "itemIdUpdate", anyRolesMask: roleMaskEditor })(() => updateItemTx()).catch(showTxError)
      })
    ])
  );

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Update Item Action (action editor)" }),
      inputRow("itemId", "itemIdUpdateAction", "1"),
      inputRow("action", "actionUpdate", "0x0000000000000000000000000000000000000000"),
      inputRow("actionData(hex)", "actionDataUpdate", "0x"),
      el("button", {
        text: "Update Action",
        onclick: () =>
          guardItem({ itemIdInputId: "itemIdUpdateAction", anyRolesMask: roleMaskActionEditor })(() => updateItemActionTx()).catch(showTxError)
      })
    ])
  );

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Item Page (versioned)" }),
      inputRow("itemId", "itemIdPage", "1"),
      inputRow("uri", "pageUri", "https://example.com"),
      inputRow("contentHash(bytes32 optional)", "pageHash", "0x" + "0".repeat(64)),
      el("button", {
        text: "Add Page Version",
        onclick: () =>
          guardItem({ itemIdInputId: "itemIdPage", anyRolesMask: roleMaskEditor })(() => addItemPageTx()).catch(showTxError)
      }),
      el("h4", { text: "Default Page" }),
      inputRow("itemId", "itemIdDefaultPage", "1"),
      inputRow("version", "defaultPageVersion", "1"),
      el("button", {
        text: "Set Default",
        onclick: () =>
          guardItem({
            itemIdInputId: "itemIdDefaultPage",
            anyRolesMask: roleMaskEditor
          })(() => setDefaultItemPageTx()).catch(showTxError)
      })
    ])
  );

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Add Item" }),
      el("div", { style: "margin: 8px 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px;" }, [
        el("button", {
          text: "模板：NFT+积分卡",
          onclick: () => {
            setInputValue("soulbound", "true");
            setInputValue("requiresSerial", "false");
            setInputValue("tokenURI", "ipfs://membership-card");
            const actionAddr = getCurrentCfgValue("itemsActionAddress");
            if (actionAddr) setInputValue("action", actionAddr);
            setInputValue("actionData", "0x");
          }
        }),
        el("button", {
          text: "模板：NFT+NFT",
          onclick: () => {
            setInputValue("soulbound", "false");
            setInputValue("requiresSerial", "false");
            setInputValue("tokenURI", "ipfs://bundle-nft");
            const actionAddr = getCurrentCfgValue("erc721ActionAddress");
            if (actionAddr) setInputValue("action", actionAddr);
            setInputValue("actionData", "0x");
          }
        }),
        el("button", {
          text: "模板：NFT+NFT（按模板）",
          onclick: () => {
            try {
              setInputValue("soulbound", "false");
              setInputValue("requiresSerial", "false");
              setInputValue("tokenURI", "");
              const actionAddr = getCurrentCfgValue("erc721ActionAddress");
              if (actionAddr) setInputValue("action", actionAddr);
              const nft = getAddress(val("nftContract"));
              let tidRaw = val("mintNftTemplateId");
              if (!tidRaw) tidRaw = getCurrentCfgValue("defaultTemplateId") || "0";
              const templateId = BigInt(tidRaw || "0");
              const payload = encodeAbiParameters([{ type: "uint256" }], [templateId]);
              const hex = encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [nft, payload]);
              setInputValue("actionData", hex);
            } catch (e) {
              showTxError(e);
            }
          }
        }),
        el("button", {
          text: "模板：NFT+实物（兑换码）",
          onclick: () => {
            setInputValue("soulbound", "false");
            setInputValue("requiresSerial", "true");
            setInputValue("tokenURI", "ipfs://physical-redeem");
            setInputValue("action", "");
            setInputValue("actionData", "0x");
          }
        }),
        el("button", {
          text: "模板：NFT+电子产品（密码/兑换码）",
          onclick: () => {
            setInputValue("soulbound", "false");
            setInputValue("requiresSerial", "true");
            setInputValue("tokenURI", "ipfs://digital-redeem");
            setInputValue("action", "");
            setInputValue("actionData", "0x");
          }
        }),
        el("button", {
          text: "模板：基础空白",
          onclick: () => {
            setInputValue("soulbound", "");
            setInputValue("requiresSerial", "");
            setInputValue("tokenURI", "");
            setInputValue("action", "");
            setInputValue("actionData", "0x");
          }
        })
      ]),
      el("div", { style: "margin: 8px 0;" }, [
        el("h4", { text: "类别（Category）" }),
        el("select", { id: "categorySelect" }),
        el("button", {
          text: "加载类别",
          style: "margin-left: 8px;",
          onclick: async () => {
            try {
              const json = await workerApiGet("/categories");
              const select = document.getElementById("categorySelect");
              select.innerHTML = "";
              const list = Array.isArray(json.categories) ? json.categories : [];
              for (const c of list) {
                const opt = document.createElement("option");
                opt.value = String(c.id ?? "");
                opt.textContent = String(c.name ?? c.id ?? "");
                opt.setAttribute("data-docs-ipfs", String(c.docsIpfs ?? ""));
                opt.setAttribute("data-readme-ipfs", String(c.readmeIpfs ?? ""));
                opt.setAttribute("data-architecture-ipfs", String(c.architectureIpfs ?? ""));
                opt.setAttribute("data-template-ipfs", String(c.templateIpfs ?? ""));
                select.appendChild(opt);
              }
            } catch (e) {
              showTxError(e);
            }
          }
        }),
        el("button", {
          text: "查看文档",
          style: "margin-left: 8px;",
          onclick: () => {
            const select = document.getElementById("categorySelect");
            const idx = select.selectedIndex;
            if (idx < 0) return;
            const opt = select.options[idx];
            const docs = opt.getAttribute("data-docs-ipfs") || "";
            const readme = opt.getAttribute("data-readme-ipfs") || "";
            const arch = opt.getAttribute("data-architecture-ipfs") || "";
            const tpl = opt.getAttribute("data-template-ipfs") || "";
            const out = document.getElementById("categoryLinkOut");
            out.innerHTML = "";
            const links = [
              { label: "Docs", url: docs },
              { label: "README", url: readme },
              { label: "Architecture", url: arch },
              { label: "Template", url: tpl }
            ];
            for (const { label, url } of links) {
              if (!url) continue;
              const urls = ipfsGatewayUrls(url);
              const row = el("div", {}, [el("span", { text: `${label}: ` })]);
              urls.forEach((href, i) => {
                const a = el("a", { href, target: "_blank", rel: "noopener", text: i === 0 ? "主网关" : `备${i}` });
                row.appendChild(a);
                if (i < urls.length - 1) row.appendChild(document.createTextNode(" | "));
              });
              out.appendChild(row);
            }
          }
        }),
        el("button", {
          text: "应用类别",
          style: "margin-left: 8px;",
          onclick: () => {
            const id = String(val("categorySelect") || "");
            if (!id) return;
            if (id === "points") {
              setInputValue("soulbound", "true");
              setInputValue("requiresSerial", "false");
              setInputValue("tokenURI", "ipfs://membership-card");
              const actionAddr = getCurrentCfgValue("itemsActionAddress");
              if (actionAddr) setInputValue("action", actionAddr);
              setInputValue("actionData", "0x");
            } else if (id === "nft2nft") {
              setInputValue("soulbound", "false");
              setInputValue("requiresSerial", "false");
              setInputValue("tokenURI", "ipfs://bundle-nft");
              const actionAddr = getCurrentCfgValue("erc721ActionAddress");
              if (actionAddr) setInputValue("action", actionAddr);
              setInputValue("actionData", "0x");
            } else if (id === "physical") {
              setInputValue("soulbound", "false");
              setInputValue("requiresSerial", "true");
              setInputValue("tokenURI", "ipfs://physical-redeem");
              setInputValue("action", "");
              setInputValue("actionData", "0x");
            } else if (id === "digital") {
              setInputValue("soulbound", "false");
              setInputValue("requiresSerial", "true");
              setInputValue("tokenURI", "ipfs://digital-redeem");
              setInputValue("action", "");
              setInputValue("actionData", "0x");
            }
            setDisabledMany(["soulbound", "requiresSerial", "tokenURI", "action"], true);
          }
        }),
        el("button", {
          text: "解除类别限制",
          style: "margin-left: 8px;",
          onclick: () => setDisabledMany(["soulbound", "requiresSerial", "tokenURI", "action"], false)
        }),
        el("div", { id: "categoryLinkOut", style: "margin-top: 6px;" })
      ]),
      inputRow("shopId", "shopIdAdd", "1"),
      inputRow("payToken", "payToken"),
      inputRow("unitPrice", "unitPrice", "1000"),
      inputRow("nftContract", "nftContract"),
      inputRow("soulbound(true|false)", "soulbound", "true"),
      inputRow("tokenURI", "tokenURI", "ipfs://token"),
      inputRow("action(optional)", "action", "0x0000000000000000000000000000000000000000"),
      inputRow("actionData(hex)", "actionData", "0x"),
      el("div", { style: "margin: 8px 0;" }, [
        el("h4", { text: "MintERC20 actionData builder" }),
        inputRow("mintToken", "mintToken", "0x..."),
        inputRow("amountPerUnit(uint256)", "amountPerUnit", "1000"),
        el("button", {
          text: "Build actionData",
          onclick: () => {
            try {
              const token = getAddress(val("mintToken"));
              const amount = BigInt(val("amountPerUnit") || "0");
              const hex = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, amount]);
              setInputValue("actionData", hex);
            } catch (e) {
              showTxError(e);
            }
          }
        })
      ]),
      el("div", { style: "margin: 8px 0;" }, [
        el("h4", { text: "MintERC721 actionData builder" }),
        inputRow("nft(address)", "mintNft", "0x..."),
        inputRow("tokenURI(string)", "mintNftTokenURI", "ipfs://bundle"),
        inputRow("templateId(uint256)", "mintNftTemplateId", ""),
        el("div", {}, [
          el("button", {
            text: "Build by tokenURI",
            onclick: () => {
              try {
                const nft = getAddress(val("mintNft"));
                const uri = String(val("mintNftTokenURI") || "");
                const payload = encodeAbiParameters([{ type: "string" }], [uri]);
                const hex = encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [nft, payload]);
                setInputValue("actionData", hex);
              } catch (e) {
                showTxError(e);
              }
            }
          }),
          el("button", {
            text: "Build by templateId",
            style: "margin-left: 8px;",
            onclick: () => {
              try {
                const nft = getAddress(val("mintNft"));
                let tidRaw = val("mintNftTemplateId");
                if (!tidRaw) tidRaw = getCurrentCfgValue("defaultTemplateId") || "0";
                const templateId = BigInt(tidRaw || "0");
                const payload = encodeAbiParameters([{ type: "uint256" }], [templateId]);
                const hex = encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [nft, payload]);
                setInputValue("actionData", hex);
              } catch (e) {
                showTxError(e);
              }
            }
          })
        ])
      ]),
      inputRow("requiresSerial(true|false)", "requiresSerial", "true"),
      el("h4", { text: "Risk Allowance (optional)" }),
      inputRow("shopOwner", "riskShopOwner"),
      inputRow("maxItems", "maxItems", "10"),
      inputRow("deadline(ts)", "riskDeadline", String(Math.floor(Date.now() / 1000) + 3600)),
      inputRow("nonce(auto fill)", "riskNonce", ""),
      inputRow("signature(auto fill)", "riskSig", "0x"),
      el("button", { text: "Fetch Risk Sig", onclick: () => fetchRiskSig().catch(showTxError) }),
      el("button", {
        text: "Add",
        onclick: () =>
          guardShop({
            shopIdInputId: "shopIdAdd",
            anyRolesMask: roleMaskAll
          })(() => addItem()).catch(showTxError)
      })
    ])
  );

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "Backup / Restore Items" }),
      inputRow("shopId", "shopIdExport", "1"),
      el("button", {
        text: "Export Shop Items (json)",
        onclick: () => exportShopItemsTx().catch(showTxError)
      }),
      el("h4", { text: "Import (paste json)" }),
      el("textarea", { id: "importJson", rows: "8", style: "width: 100%;", placeholder: "{...}" }),
      el("button", {
        text: "Import Items",
        onclick: () =>
          guardShop({
            shopIdInputId: "shopIdExport",
            anyRolesMask: roleMaskAll
          })(() => importShopItemsTx()).catch(showTxError)
      })
    ])
  );
}

async function renderProtocolConsole(container, { canWrite }) {
  container.appendChild(el("h2", { text: "协议后台（Protocol）" }));
  if (!canWrite) container.appendChild(el("div", { text: "提示：当前钱包不是协议 owner，仍可 Read，但写操作会被禁用。" }));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "MyShops（协议参数）" }),
      el("button", { text: "Read", onclick: () => readProtocolConfig().catch(showTxError) }),
      el("pre", { id: "platformOut" }),
      inputRow("registry", "platformRegistry"),
      el("button", { text: "Set Registry", disabled: !canWrite, onclick: () => setRegistryTx().catch(showTxError) }),
      inputRow("platformTreasury", "platformTreasury"),
      el("button", { text: "Set Protocol Treasury", disabled: !canWrite, onclick: () => setProtocolTreasuryTx().catch(showTxError) }),
      inputRow("listingFeeToken", "platformListingFeeToken"),
      inputRow("listingFeeAmount(uint256)", "platformListingFeeAmount", "0"),
      el("button", { text: "Set Listing Fee", disabled: !canWrite, onclick: () => setListingFeeTx().catch(showTxError) }),
      inputRow("protocolFeeBps(uint16)", "platformFeeBps", "100"),
      el("button", { text: "Set Protocol Fee", disabled: !canWrite, onclick: () => setProtocolFeeTx().catch(showTxError) }),
      inputRow("newOwner", "shopsNewOwner"),
      el("button", {
        text: "Transfer MyShops Ownership",
        disabled: !canWrite,
        onclick: () => transferShopsOwnershipTx().catch(showTxError)
      })
    ])
  );

  container.appendChild(el("hr"));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "MyShopItems Config" }),
      el("button", { text: "Read", onclick: () => readItemsConfig().catch(showTxError) }),
      el("pre", { id: "itemsOut" }),
      inputRow("riskSigner", "itemsRiskSigner"),
      el("button", { text: "Set Risk Signer", disabled: !canWrite, onclick: () => setRiskSignerTx().catch(showTxError) }),
      inputRow("serialSigner", "itemsSerialSigner"),
      el("button", { text: "Set Serial Signer", disabled: !canWrite, onclick: () => setSerialSignerTx().catch(showTxError) }),
      inputRow("action", "itemsActionAddress"),
      inputRow("allowed(true|false)", "itemsActionAllowed", "true"),
      el("button", { text: "Set Action Allowed", disabled: !canWrite, onclick: () => setActionAllowedTx().catch(showTxError) }),
      inputRow("newOwner", "itemsNewOwner"),
      el("button", {
        text: "Transfer MyShopItems Ownership",
        disabled: !canWrite,
        onclick: () => transferItemsOwnershipTx().catch(showTxError)
      })
    ])
  );
}

function getCurrentCfgValue(id) {
  const node = document.getElementById(id);
  const v = node ? String(node.value || "").trim() : "";
  if (v) return v;
  return runtimeCfg[id] ? String(runtimeCfg[id]) : "";
}

async function getProtocolOwners() {
  const myshop = createMyShopReadClient({
    publicClient,
    shopsAddress: getCurrentCfgValue("shopsAddress"),
    itemsAddress: getCurrentCfgValue("itemsAddress")
  });
  return myshop.getProtocolOwners();
}

async function getShopAccess({ shopId, actor }) {
  requireAddress(getCurrentCfgValue("shopsAddress"), "shopsAddress");
  const myshop = createMyShopReadClient({
    publicClient,
    shopsAddress: getCurrentCfgValue("shopsAddress"),
    itemsAddress: getCurrentCfgValue("itemsAddress")
  });

  const owners = await myshop.getProtocolOwners();
  const shopOwner = await myshop.getShopOwner(shopId);
  const rolesMask = await myshop.getShopRolesMask(shopId, actor);
  const roleConfig = await myshop.getRoleConfig();
  const isProtocolOwner = myshop.isProtocolOwner(owners, actor);
  const isShopOwner = shopOwner === actor;

  return { isProtocolOwner, isShopOwner, rolesMask, shopOwner, roleConfig };
}

async function requireShopAccess({ shopId, anyRolesMask = 0, allowProtocolOwner = true, allowShopOwner = true }) {
  if (!connectedAddress) throw new Error("请先连接钱包");
  const actor = getAddress(connectedAddress);
  const access = await getShopAccess({ shopId, actor });
  if (allowProtocolOwner && access.isProtocolOwner) return;
  if (allowShopOwner && access.isShopOwner) return;
  if (anyRolesMask && (access.rolesMask & anyRolesMask) !== 0) return;
  throw new Error("无权限：该操作需要对应角色（shopRoles）或 shop owner / protocol owner");
}

async function getItemShopId(itemId) {
  const itemsAddressVal = requireAddress(getCurrentCfgValue("itemsAddress"), "itemsAddress");
  const item = await publicClient.readContract({
    address: itemsAddressVal,
    abi: myShopItemsAbi,
    functionName: "items",
    args: [itemId]
  });
  return BigInt(pick(item, "shopId", 0));
}

async function requireItemAccess({ itemId, anyRolesMask = 0, allowProtocolOwner = true, allowShopOwner = true }) {
  const shopId = await getItemShopId(itemId);
  return requireShopAccess({ shopId, anyRolesMask, allowProtocolOwner, allowShopOwner });
}

function renderWalletRequired(container, { title, required }) {
  container.appendChild(el("h2", { text: title }));
  container.appendChild(el("div", { text: `需要连接钱包：${required}` }));
  container.appendChild(el("div", { text: "请先点击顶部 Connect Wallet，然后重试。" }));
}

function renderRoleRequired(container, { title, required }) {
  container.appendChild(el("h2", { text: title }));
  container.appendChild(el("div", { text: `需要权限：${required}` }));
  container.appendChild(el("div", { text: "建议：先打开「角色」页面，选择 shopId 做一次 Access Check。" }));
}

async function renderConfig(container) {
  container.appendChild(el("h2", { text: "配置（Config）" }));

  container.appendChild(
    el("div", {}, [
      inputRow("RPC URL", "rpcUrl"),
      inputRow("CHAIN_ID", "chainId"),
      inputRow("SHOPS_ADDRESS", "shopsAddress"),
      inputRow("ITEMS_ADDRESS", "itemsAddress"),
      inputRow("ITEMS_ACTION_ADDRESS (MintERC20Action)", "itemsActionAddress"),
      inputRow("ERC721_ACTION_ADDRESS (MintERC721Action)", "erc721ActionAddress"),
      inputRow("ERC721_DEFAULT_TEMPLATE_ID (uint256)", "defaultTemplateId"),
      inputRow("WORKER_URL (permit)", "workerUrl"),
      inputRow("WORKER_API_URL (query)", "workerApiUrl"),
      inputRow("IPFS_GATEWAY (eg. https://gw.example.com)", "ipfsGateway"),
      inputRow("APNTS_SALE_URL", "apntsSaleUrl"),
      inputRow("GTOKEN_SALE_URL", "gtokenSaleUrl"),
      el("button", {
        text: "Fill from env",
        onclick: () => {
          document.getElementById("rpcUrl").value = envCfg.rpcUrl || "";
          document.getElementById("chainId").value = envCfg.chainId ? String(envCfg.chainId) : "";
          document.getElementById("shopsAddress").value = envCfg.shopsAddress || "";
          document.getElementById("itemsAddress").value = envCfg.itemsAddress || "";
          document.getElementById("itemsActionAddress").value = envCfg.itemsActionAddress || "";
          document.getElementById("erc721ActionAddress").value = envCfg.erc721ActionAddress || "";
          document.getElementById("defaultTemplateId").value = envCfg.defaultTemplateId || "";
          document.getElementById("workerUrl").value = envCfg.workerUrl || "";
          document.getElementById("workerApiUrl").value = envCfg.workerApiUrl || "";
          document.getElementById("ipfsGateway").value = envCfg.ipfsGateway || "";
          document.getElementById("apntsSaleUrl").value = envCfg.apntsSaleUrl || "";
          document.getElementById("gtokenSaleUrl").value = envCfg.gtokenSaleUrl || "";
        }
      }),
      el("button", {
        text: "Fill from current",
        onclick: () => {
          document.getElementById("rpcUrl").value = runtimeCfg.rpcUrl || "";
          document.getElementById("chainId").value = runtimeCfg.chainId ? String(runtimeCfg.chainId) : "";
          document.getElementById("shopsAddress").value = runtimeCfg.shopsAddress || "";
          document.getElementById("itemsAddress").value = runtimeCfg.itemsAddress || "";
          document.getElementById("itemsActionAddress").value = runtimeCfg.itemsActionAddress || "";
          document.getElementById("erc721ActionAddress").value = runtimeCfg.erc721ActionAddress || "";
          document.getElementById("defaultTemplateId").value = runtimeCfg.defaultTemplateId || "";
          document.getElementById("workerUrl").value = runtimeCfg.workerUrl || "";
          document.getElementById("workerApiUrl").value = runtimeCfg.workerApiUrl || "";
          document.getElementById("ipfsGateway").value = runtimeCfg.ipfsGateway || "";
          document.getElementById("apntsSaleUrl").value = runtimeCfg.apntsSaleUrl || "";
          document.getElementById("gtokenSaleUrl").value = runtimeCfg.gtokenSaleUrl || "";
        }
      }),
      el("button", { text: "Load from Worker /config", onclick: () => loadConfigFromWorker().catch(showTxError) }),
      el("button", { text: "Save & Apply", onclick: () => applyConfigFromInputs() }),
      el("button", {
        text: "测试网关",
        onclick: () => testGateways().catch((e) => setText("gatewayTestOut", String(e?.message || e)))
      }),
      el("pre", { id: "gatewayTestOut" })
    ])
  );

  document.getElementById("rpcUrl").value = runtimeCfg.rpcUrl || "";
  document.getElementById("chainId").value = runtimeCfg.chainId ? String(runtimeCfg.chainId) : "";
  document.getElementById("shopsAddress").value = runtimeCfg.shopsAddress || "";
  document.getElementById("itemsAddress").value = runtimeCfg.itemsAddress || "";
  document.getElementById("itemsActionAddress").value = runtimeCfg.itemsActionAddress || "";
  document.getElementById("erc721ActionAddress").value = runtimeCfg.erc721ActionAddress || "";
  document.getElementById("defaultTemplateId").value = runtimeCfg.defaultTemplateId || "";
  document.getElementById("workerUrl").value = runtimeCfg.workerUrl || "";
  document.getElementById("workerApiUrl").value = runtimeCfg.workerApiUrl || "";
  document.getElementById("ipfsGateway").value = runtimeCfg.ipfsGateway || "";
  document.getElementById("apntsSaleUrl").value = runtimeCfg.apntsSaleUrl || "";
  document.getElementById("gtokenSaleUrl").value = runtimeCfg.gtokenSaleUrl || "";
}

async function renderRolesPage(container, query = {}) {
  container.appendChild(el("h2", { text: "角色与权限（Roles）" }));
  container.appendChild(el("div", { text: "用于确认：你是谁（protocol owner / shop owner / shopRoles）以及你能做什么。" }));

  container.appendChild(
    el("div", {}, [
      el("h3", { text: "页面 IA（Information Architecture）" }),
      el("div", { text: "广场：所有人可访问；买家：需要钱包；店主后台：需要 shop owner / operator；协议后台：需要 protocol owner。" })
    ])
  );

  const out = el("pre", { id: "rolesOut" });
  container.appendChild(
    el("div", {}, [
      inputRow("shopId", "rolesShopId", query.shopId || "1"),
      el("button", { text: "Check", onclick: () => load().catch(showTxError) }),
      out
    ])
  );

  async function load() {
    if (!connectedAddress) throw new Error("请先连接钱包");
    const shopId = BigInt(val("rolesShopId"));
    const actor = getAddress(connectedAddress);
    try {
      const owners = await getProtocolOwners();
      const access = await getShopAccess({ shopId, actor });
      roleConfigState = normalizeRoleConfig(access.roleConfig);
      const roles = decodeShopRoles(access.rolesMask);
      const pageAccess = {
        plaza: true,
        buyer: !!connectedAddress,
        purchases: true,
        roles: !!connectedAddress,
        shopConsole: access.isProtocolOwner || access.isShopOwner || access.rolesMask !== 0,
        protocolConsole: access.isProtocolOwner
      };

      out.textContent = JSON.stringify(
        {
          actor,
          protocolOwners: owners,
          shopId: shopId.toString(),
          shopOwner: access.shopOwner,
          isProtocolOwner: access.isProtocolOwner,
          isShopOwner: access.isShopOwner,
          rolesMask: access.rolesMask,
          roleConfig: normalizeRoleConfig(access.roleConfig),
          roles,
          pageAccess,
          recommendedEntry: access.isProtocolOwner ? "protocol-console" : access.isShopOwner || roles.length ? "shop-console" : "buyer"
        },
        null,
        2
      );
    } catch (e) {
      roleConfigState = normalizeRoleConfig(null);
      const pageAccess = {
        plaza: true,
        buyer: !!connectedAddress,
        purchases: true,
        roles: !!connectedAddress,
        shopConsole: false,
        protocolConsole: false
      };
      out.textContent = JSON.stringify(
        {
          actor,
          shopId: shopId.toString(),
          error: formatError(e),
          pageAccess
        },
        null,
        2
      );
    }
  }

  await load();
}

async function renderDiagnostics(container) {
  container.appendChild(el("h2", { text: "诊断（Diagnostics）" }));

  const cfgBox = el("div", { id: "diagCfg" });
  const out = el("pre", { id: "diagOut" });
  const riskBox = el("div", { id: "diagRiskBox", style: "margin-top: 12px; border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px; background: #ffffff;" });
  container.appendChild(cfgBox);
  container.appendChild(
    el("div", {}, [
      el("button", { text: "Check RPC", onclick: () => checkRpc().catch(showTxError) }),
      el("button", { text: "Check Worker (permit)", style: "margin-left: 8px;", onclick: () => checkWorkerPermit().catch(showTxError) }),
      el("button", { text: "Check Worker API (query)", style: "margin-left: 8px;", onclick: () => checkWorkerApi().catch(showTxError) }),
      el("button", { text: "Open Config", style: "margin-left: 8px;", onclick: () => (window.location.hash = "#/config") })
    ])
  );
  container.appendChild(out);
  container.appendChild(riskBox);

  function write(obj) {
    out.textContent = JSON.stringify(obj, null, 2);
  }

  function currentCfgSnapshot() {
    return {
      rpcUrl: getCurrentCfgValue("rpcUrl"),
      chainId: getCurrentCfgValue("chainId"),
      shopsAddress: getCurrentCfgValue("shopsAddress"),
      itemsAddress: getCurrentCfgValue("itemsAddress"),
      workerUrl: getCurrentCfgValue("workerUrl"),
      workerApiUrl: getCurrentCfgValue("workerApiUrl")
    };
  }

  function renderCfg() {
    const c = currentCfgSnapshot();
    cfgBox.innerHTML = "";
    cfgBox.appendChild(el("div", { text: `rpcUrl=${c.rpcUrl || ""}` }));
    cfgBox.appendChild(el("div", { text: `chainId=${c.chainId || ""}` }));
    cfgBox.appendChild(el("div", { text: `shopsAddress=${c.shopsAddress || ""}` }));
    cfgBox.appendChild(el("div", { text: `itemsAddress=${c.itemsAddress || ""}` }));
    cfgBox.appendChild(el("div", { text: `workerUrl=${c.workerUrl || ""}` }));
    cfgBox.appendChild(el("div", { text: `workerApiUrl=${c.workerApiUrl || ""}` }));
  }

  async function safeHttpGet(baseUrl, path) {
    const base = normalizeBaseUrl(baseUrl);
    if (!base) throw new Error("base url is empty");
    const url = new URL(path, base);
    return fetchJson(url.toString());
  }

  async function checkRpc() {
    setText("txOut", "diagnostics: checking rpc...");
    const latest = await publicClient.getBlockNumber();
    write({
      ok: true,
      kind: "rpc",
      chainId: chain.id,
      latestBlock: latest.toString(),
      mismatch: getChainMismatch()
    });
    setText("txOut", "diagnostics: rpc ok");
  }

  async function checkWorkerPermit() {
    setText("txOut", "diagnostics: checking worker (permit)...");
    const base = getPermitBaseUrl();
    const health = await safeHttpGet(base, "/health");
    write({
      ok: true,
      kind: "worker_permit",
      baseUrl: base,
      health
    });
    setText("txOut", "diagnostics: worker (permit) ok");
  }

  async function checkWorkerApi() {
    setText("txOut", "diagnostics: checking worker api (query)...");
    const base = getApiBaseUrl();
    const health = await safeHttpGet(base, "/health");
    const config = await safeHttpGet(base, "/config");
    const indexer = await safeHttpGet(base, "/indexer");
    let riskSummary = null;
    try {
      riskSummary = await safeHttpGet(base, "/risk-summary");
    } catch (e) {
      riskSummary = { ok: false, error: getErrorText(e) };
    }
    write({
      ok: true,
      kind: "worker_api",
      baseUrl: base,
      health,
      config,
      indexer,
      riskSummary
    });
    updateDiagRisk(riskSummary);
    setText("txOut", "diagnostics: worker api ok");
  }

  function updateDiagRisk(summary) {
    riskBox.innerHTML = "";
    riskBox.appendChild(el("h3", { text: "风险摘要（Risk Summary）" }));
    if (!summary || summary.ok === false) {
      riskBox.appendChild(el("div", { style: "color: #991b1b;", text: `不可用：${summary?.error || "unknown error"}` }));
      return;
    }
    const level = computeRiskLevel(summary);
    const color = level === "红色" ? "#dc2626" : level === "黄色" ? "#f59e0b" : "#16a34a";
    const badge = el("span", {
      text: `风险等级：${level}`,
      style: `display:inline-block;padding:4px 8px;border-radius:999px;background:${color}20;color:${color};font-weight:600;margin-bottom:8px;`
    });
    riskBox.appendChild(badge);
    riskBox.appendChild(kv("来源", String(summary.source || "-")));
    riskBox.appendChild(kv("购买笔数", String(summary.totalPurchases ?? 0)));
    riskBox.appendChild(kv("购买人数", String(summary.uniqueBuyers ?? 0)));
    riskBox.appendChild(kv("活跃店铺", String(summary.uniqueShops ?? 0)));
    riskBox.appendChild(kv("涉及商品", String(summary.uniqueItems ?? 0)));
    riskBox.appendChild(kv("支付总额", String(summary.totalPayAmount ?? "0")));
    riskBox.appendChild(kv("平台费", String(summary.totalPlatformFeeAmount ?? "0")));
    if (summary.lastPurchaseAt || summary.lastPurchaseBlock) {
      riskBox.appendChild(kv("最后购买时间", String(summary.lastPurchaseAt ?? "-")));
      riskBox.appendChild(kv("最后购买区块", String(summary.lastPurchaseBlock ?? "-")));
    }
    if (Array.isArray(summary.topBuyers) && summary.topBuyers.length > 0) {
      const list = el("div", {}, [el("div", { text: "Top Buyers" })]);
      for (const b of summary.topBuyers) {
        list.appendChild(
          el("div", {}, [
            addressNode(b.buyer),
            el("span", { text: ` pay=${b.payAmount} purchases=${b.purchases}` })
          ])
        );
      }
      riskBox.appendChild(list);
    }
    if (Array.isArray(summary.topItems) && summary.topItems.length > 0) {
      const list = el("div", {}, [el("div", { text: "Top Items" })]);
      for (const it of summary.topItems) {
        list.appendChild(el("div", { text: `#${it.itemId} pay=${it.payAmount} qty=${it.quantity} purchases=${it.purchases}` }));
      }
      riskBox.appendChild(list);
    }
  }

  function computeRiskLevel(summary) {
    const n = Number(summary?.totalPurchases ?? 0);
    if (n >= 100) return "红色";
    if (n >= 30) return "黄色";
    return "绿色";
  }

  renderCfg();
  await checkRpc();
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML = "";

  const mismatch = getChainMismatch();
  const header = el("div", {}, [
    el("h1", { text: "MyShop Plaza" }),
    el("button", { text: "Connect Wallet", onclick: () => connect().catch(showTxError) }),
    el("div", { id: "conn", text: connectedAddress ? `connected: ${connectedAddress}` : "not connected" }),
    el("div", { id: "roleSummary", text: "" }),
    el("div", { id: "serviceSummary", text: "" }),
    mismatch
      ? el("div", {
          style: "color: #b45309;",
          text: `Chain mismatch: walletChainId=${mismatch.walletChainId} expectedChainId=${mismatch.expectedChainId}`
        })
      : null,
    el("div", {}, [
      navLink("广场", "#/plaza"),
      navLink("aPNTs 购买", "#/sale-apnts"),
      navLink("GToken 购买", "#/sale-gtoken"),
      navLink("风控评估", "#/risk"),
      navLink("买家", "#/buyer"),
      navLink("My NFTs", "#/my"),
      navLink("购买记录", "#/purchases"),
      navLink("角色", "#/roles"),
      navLink("店主后台", "#/shop-console"),
      navLinkWithId("navProtocolConsole", "协议后台", "#/protocol-console"),
      navLink("诊断", "#/diag"),
      navLink("配置", "#/config")
    ])
  ]);
  app.appendChild(header);
  app.appendChild(el("hr"));

  const main = el("div", { id: "main" });
  app.appendChild(main);
  app.appendChild(el("hr"));
  app.appendChild(el("div", { id: "txPanel" }));
  app.appendChild(el("pre", { id: "txOut" }));
  updateTxPanel();

  const route = getRoute();

  (async () => {
    try {
      if (connectedAddress) {
        try {
          const owners = await getProtocolOwners();
          const addr = getAddress(connectedAddress);
          const isProtocolOwner =
            (owners.shopsOwner && owners.shopsOwner === addr) || (owners.itemsOwner && owners.itemsOwner === addr);
          setText("roleSummary", isProtocolOwner ? "role=protocolOwner" : "role=walletConnected");
          const navProtocol = document.getElementById("navProtocolConsole");
          if (navProtocol) navProtocol.style.display = isProtocolOwner ? "" : "none";
        } catch {
          setText("roleSummary", "role=walletConnected");
          const navProtocol = document.getElementById("navProtocolConsole");
          if (navProtocol) navProtocol.style.display = "none";
        }
      } else {
        setText("roleSummary", "");
        const navProtocol = document.getElementById("navProtocolConsole");
        if (navProtocol) navProtocol.style.display = "none";
      }

      const now = Date.now();
      const shouldRefreshService = now - lastServiceCheckAtMs > 5000;
      if (lastServiceStatusText) setText("serviceSummary", lastServiceStatusText);
      if (shouldRefreshService) {
        lastServiceCheckAtMs = now;
        (async () => {
          const parts = [];
          const permitBase = getPermitBaseUrl();
          const apiBase = getApiBaseUrl();

          if (permitBase) {
            try {
              await fetchJsonWithTimeout(new URL("/health", permitBase).toString(), 1500);
              parts.push("permit=ok");
            } catch {
              parts.push("permit=down");
            }
          } else {
            parts.push("permit=unset");
          }

          if (apiBase) {
            try {
              await fetchJsonWithTimeout(new URL("/health", apiBase).toString(), 1500);
              parts.push("api=ok");
            } catch {
              parts.push("api=down");
            }
          } else {
            parts.push("api=unset");
          }

          lastServiceStatusText = parts.join(" ");
          setText("serviceSummary", lastServiceStatusText);
        })();
      }

      if (route.parts.length === 0 || route.parts[0] === "plaza") {
        await renderPlaza(main);
        return;
      }
      if (route.parts[0] === "sale-apnts") {
        await renderApntsSalePage(main);
        return;
      }
      if (route.parts[0] === "sale-gtoken") {
        await renderGTokenSalePage(main);
        return;
      }
      if (route.parts[0] === "risk") {
        await renderRiskPage(main);
        return;
      }
      if (route.parts[0] === "shop" && route.parts[1]) {
        await renderShopDetail(main, route.parts[1]);
        return;
      }
      if (route.parts[0] === "item" && route.parts[1]) {
        await renderItemDetail(main, route.parts[1]);
        return;
      }
      if (route.parts[0] === "purchases") {
        await renderPurchasesPage(main, route.query);
        return;
      }
      if (route.parts[0] === "buyer") {
        if (route.query.itemId) routeState.buyerItemId = String(route.query.itemId);
        await renderBuyer(main);
        return;
      }
      if (route.parts[0] === "my") {
        await renderMyHistoryPage(main);
        return;
      }
      if (route.parts[0] === "roles") {
        if (!connectedAddress) {
          renderWalletRequired(main, { title: "角色与权限（Roles）", required: "any wallet" });
          return;
        }
        await renderRolesPage(main, route.query);
        return;
      }
      if (route.parts[0] === "shop-console") {
        if (!connectedAddress) {
          renderWalletRequired(main, { title: "店主/运营后台（Shop Owner / Operator）", required: "shop owner / operator" });
          return;
        }
        await renderShopConsole(main, route.query);
        return;
      }
      if (route.parts[0] === "protocol-console") {
        if (!connectedAddress) {
          renderWalletRequired(main, { title: "协议后台（Protocol）", required: "protocol owner" });
          return;
        }
        let canWrite = false;
        try {
          const owners = await getProtocolOwners();
          const addr = getAddress(connectedAddress);
          canWrite =
            (owners.shopsOwner && owners.shopsOwner === addr) || (owners.itemsOwner && owners.itemsOwner === addr);
        } catch {
          canWrite = false;
        }
        if (!canWrite) {
          renderRoleRequired(main, { title: "协议后台（Protocol）", required: "protocol owner" });
          return;
        }
        await renderProtocolConsole(main, { canWrite });
        return;
      }
      if (route.parts[0] === "config") {
        await renderConfig(main);
        return;
      }
      if (route.parts[0] === "diag") {
        await renderDiagnostics(main);
        return;
      }
      window.location.hash = "#/plaza";
    } catch (e) {
      showTxError(e);
    }
  })();
}

window.addEventListener("hashchange", render);
render();
