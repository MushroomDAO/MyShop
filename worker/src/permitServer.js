import http from "node:http";
import { URL } from "node:url";
import { openDb, getDbPath } from "./db.js";

import { encodeAbiParameters, getAddress, http as httpTransport, keccak256, parseAbiParameters, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient } from "viem";

import { myShopItemsAbi } from "./abi.js";

class RateLimitError extends Error {
  constructor({ message = "rate_limited", retryAfterMs = null } = {}) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

class HttpError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

export async function startPermitServer({
  rpcUrl,
  chain,
  itemsAddress,
  serialSignerPrivateKey,
  riskSignerPrivateKey,
  serialIssuerUrl,
  port
}) {
  const publicClient = createPublicClient({
    chain,
    transport: httpTransport(rpcUrl)
  });
  let domainChainId = chain.id;
  try {
    domainChainId = await publicClient.getChainId();
  } catch {
    domainChainId = chain.id;
  }

  const walletClients = {
    serial: serialSignerPrivateKey
      ? createWalletClient({
          chain,
          transport: httpTransport(rpcUrl),
          account: privateKeyToAccount(serialSignerPrivateKey)
        })
      : null,
    risk: riskSignerPrivateKey
      ? createWalletClient({
          chain,
          transport: httpTransport(rpcUrl),
          account: privateKeyToAccount(riskSignerPrivateKey)
        })
      : null
  };

  const limiter = {
    enabled: process.env.PERMIT_RATE_LIMIT === "0" ? false : true,
    windowMs: Number(process.env.PERMIT_RATE_LIMIT_WINDOW_MS ?? "60000"),
    max: Number(process.env.PERMIT_RATE_LIMIT_MAX ?? "120"),
    maxBuckets: Number(process.env.PERMIT_RATE_LIMIT_MAX_BUCKETS ?? "5000"),
    buckets: new Map()
  };

  const stats = {
    requestsTotal: 0,
    okTotal: 0,
    okSerialPermitTotal: 0,
    okRiskAllowanceTotal: 0,
    rateLimitedTotal: 0,
    httpErrorTotal: 0,
    internalErrorTotal: 0,
    errorCodeCounts: new Map(),
    pathCounts: new Map(),
    pathDurationSumMs: new Map(),
    pathDurationCount: new Map()
  };

  const server = http.createServer(async (req, res) => {
    const startedAtMs = Date.now();
    let pathName = "unknown";
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type"
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      pathName = url.pathname;
      stats.requestsTotal += 1;

      if (url.pathname === "/health") {
        stats.okTotal += 1;
        let dbStatus = "ok";
        try {
          openDb();
        } catch {
          dbStatus = "error";
        }
        _json(res, 200, {
          ok: true,
          timestamp: Math.floor(Date.now() / 1000),
          services: {
            permitServer: { status: "ok", port },
            signers: {
              serialSigner: { configured: walletClients.serial != null },
              riskSigner: { configured: walletClients.risk != null }
            },
            db: { status: dbStatus, path: getDbPath() }
          }
        });
        return;
      }

      if (url.pathname === "/config") {
        _requireMethod(req, ["GET"]);
        stats.okTotal += 1;
        _json(res, 200, {
          ok: true,
          chainId: domainChainId,
          itemsAddress: getAddress(itemsAddress),
          serialSignerConfigured: walletClients.serial != null,
          riskSignerConfigured: walletClients.risk != null,
          rateLimit: {
            enabled: limiter.enabled,
            windowMs: limiter.windowMs,
            max: limiter.max
          }
        });
        return;
      }

      if (url.pathname === "/categories") {
        _requireMethod(req, ["GET"]);
        let categories = [
          { id: "points", name: "NFT+积分卡", docsIpfs: "", readmeIpfs: "", architectureIpfs: "", templateIpfs: "" },
          { id: "nft2nft", name: "NFT+NFT", docsIpfs: "", readmeIpfs: "", architectureIpfs: "", templateIpfs: "" },
          { id: "physical", name: "NFT+实物（兑换码）", docsIpfs: "", readmeIpfs: "", architectureIpfs: "", templateIpfs: "" },
          { id: "digital", name: "NFT+电子产品（密码/兑换码）", docsIpfs: "", readmeIpfs: "", architectureIpfs: "", templateIpfs: "" }
        ];
        try {
          const raw = process.env.MYSHOP_CATEGORIES_JSON;
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) categories = parsed;
          }
        } catch {}
        stats.okTotal += 1;
        _json(res, 200, { ok: true, categories, schema: { id: "string", name: "string", docsIpfs: "ipfs://", readmeIpfs: "ipfs://", architectureIpfs: "ipfs://", templateIpfs: "ipfs://" } });
        return;
      }

      if (url.pathname === "/serial-permit-demo") {
        _requireMethod(req, ["GET"]);
        const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8"/>
    <title>SerialPermit Demo</title>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"; margin: 24px; }
      .row { margin: 8px 0; }
      input { width: 360px; padding: 6px 8px; }
      button { padding: 6px 12px; }
      pre { background: #f8fafc; border: 1px solid #e5e7eb; padding: 12px; border-radius: 8px; overflow: auto; }
    </style>
  </head>
  <body>
    <h2>SerialPermit 示例</h2>
    <div class="row"><label>buyer(address)：<input id="buyer" placeholder="0x..."/></label></div>
    <div class="row"><label>itemId(uint256)：<input id="itemId" placeholder="1"/></label></div>
    <div class="row"><label>serial(字符串)：<input id="serial" placeholder="CARD-0001"/></label></div>
    <div class="row"><label>deadline(秒时间戳)：<input id="deadline" placeholder="${Math.floor(Date.now()/1000)+3600}"/></label></div>
    <div class="row"><label>nonce(可选)：<input id="nonce" placeholder=""/></label></div>
    <div class="row"><button id="btn">请求 /serial-permit</button></div>
    <h3>响应</h3>
    <pre id="out"></pre>
    <script>
      const btn = document.getElementById('btn');
      const out = document.getElementById('out');
      btn.addEventListener('click', async () => {
        try {
          const buyer = document.getElementById('buyer').value.trim();
          const itemId = document.getElementById('itemId').value.trim();
          const serial = document.getElementById('serial').value.trim();
          const deadline = document.getElementById('deadline').value.trim();
          const nonce = document.getElementById('nonce').value.trim();
          const qs = new URLSearchParams();
          if (buyer) qs.set('buyer', buyer);
          if (itemId) qs.set('itemId', itemId);
          if (serial) qs.set('serial', serial);
          if (deadline) qs.set('deadline', deadline);
          if (nonce) qs.set('nonce', nonce);
          const res = await fetch('/serial-permit?' + qs.toString());
          const json = await res.json();
          out.textContent = JSON.stringify(json, null, 2);
        } catch (e) {
          out.textContent = String(e && e.message ? e.message : e);
        }
      });
    </script>
  </body>
</html>`;
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "access-control-allow-origin": "*"
        });
        res.end(html);
        stats.okTotal += 1;
        return;
      }

      if (url.pathname === "/metrics") {
        _requireMethod(req, ["GET"]);
        const lines = [];
        lines.push(`myshop_permit_requests_total ${stats.requestsTotal}`);
        lines.push(`myshop_permit_ok_total ${stats.okTotal}`);
        lines.push(`myshop_permit_ok_serial_permit_total ${stats.okSerialPermitTotal}`);
        lines.push(`myshop_permit_ok_risk_allowance_total ${stats.okRiskAllowanceTotal}`);
        lines.push(`myshop_permit_rate_limited_total ${stats.rateLimitedTotal}`);
        lines.push(`myshop_permit_http_error_total ${stats.httpErrorTotal}`);
        lines.push(`myshop_permit_internal_error_total ${stats.internalErrorTotal}`);
        lines.push(`myshop_permit_rate_limit_enabled ${limiter.enabled ? 1 : 0}`);
        lines.push(`myshop_permit_rate_limit_window_ms ${limiter.windowMs}`);
        lines.push(`myshop_permit_rate_limit_max ${limiter.max}`);
        lines.push(`myshop_permit_rate_limit_max_buckets ${limiter.maxBuckets}`);
        lines.push(`myshop_permit_rate_limit_bucket_count ${limiter.buckets.size}`);

        const codes = Array.from(stats.errorCodeCounts.keys()).sort();
        for (const code of codes) {
          const count = stats.errorCodeCounts.get(code) ?? 0;
          const safeCode = String(code).replace(/[^a-zA-Z0-9_]/g, "_");
          lines.push(`myshop_permit_error_code_${safeCode}_total ${count}`);
        }

        const paths = Array.from(stats.pathCounts.keys()).sort();
        for (const p of paths) {
          const safePath = String(p).replace(/[^a-zA-Z0-9_]/g, "_");
          lines.push(`myshop_permit_path_${safePath}_requests_total ${stats.pathCounts.get(p) ?? 0}`);
          lines.push(`myshop_permit_path_${safePath}_duration_ms_sum ${stats.pathDurationSumMs.get(p) ?? 0}`);
          lines.push(`myshop_permit_path_${safePath}_duration_ms_count ${stats.pathDurationCount.get(p) ?? 0}`);
        }

        stats.okTotal += 1;
        _text(res, 200, `${lines.join("\n")}\n`);
        return;
      }

      if (limiter.enabled && (url.pathname === "/serial-permit" || url.pathname === "/risk-allowance")) {
        _rateLimitOrThrow({ req, url, limiter });
      }

      if (url.pathname === "/serial-permit") {
        _requireMethod(req, ["GET"]);
        if (!walletClients.serial) {
          throw new HttpError({
            status: 500,
            code: "signer_not_configured",
            message: "SERIAL_SIGNER_PRIVATE_KEY not set"
          });
        }
        const buyer = _getAddressParam(url, "buyer");
        const itemId = _getUintParam(url, "itemId", { min: 1n });
        const deadline = _getDeadlineParam(url, "deadline");
        const nonce = await _resolveNonce(publicClient, itemsAddress, buyer, url.searchParams.get("nonce"));

        const serialResult = await _resolveSerialHash({
          url,
          serialIssuerUrl,
          buyer,
          itemId
        });
        const serialHash = serialResult.serialHash;

        // Check if nonce already issued by this server for this (itemId, buyer)
        try {
          const db = openDb();
          const existing = db
            .prepare("SELECT 1 FROM issued_nonces WHERE item_id = ? AND buyer = ? AND nonce = ?")
            .get(itemId.toString(), buyer.toLowerCase(), nonce.toString());
          if (existing) {
            throw new HttpError({
              status: 409,
              code: "nonce_already_issued",
              message: "This nonce has already been issued for this buyer and item"
            });
          }
        } catch (e) {
          if (e instanceof HttpError) throw e;
          // DB error is non-fatal for nonce check — log and continue
        }

        const signature = await walletClients.serial.signTypedData({
          domain: { name: "MyShop", version: "1", chainId: domainChainId, verifyingContract: getAddress(itemsAddress) },
          types: {
            SerialPermit: [
              { name: "itemId", type: "uint256" },
              { name: "buyer", type: "address" },
              { name: "serialHash", type: "bytes32" },
              { name: "deadline", type: "uint256" },
              { name: "nonce", type: "uint256" }
            ]
          },
          primaryType: "SerialPermit",
          message: { itemId, buyer, serialHash, deadline, nonce }
        });

        // Persist the issued nonce
        try {
          const db = openDb();
          db.prepare(
            "INSERT OR IGNORE INTO issued_nonces (item_id, buyer, nonce, issued_at) VALUES (?, ?, ?, ?)"
          ).run(itemId.toString(), buyer.toLowerCase(), nonce.toString(), Math.floor(Date.now() / 1000));
        } catch {
          // non-fatal: nonce is still recorded on-chain after buyer uses it
        }

        const extraData = encodeAbiParameters(
          parseAbiParameters("bytes32 serialHash,uint256 deadline,uint256 nonce,bytes sig"),
          [serialHash, deadline, nonce, signature]
        );

        _json(res, 200, {
          ok: true,
          buyer,
          itemId: itemId.toString(),
          serial: serialResult.serial,
          serialHash,
          deadline: deadline.toString(),
          nonce: nonce.toString(),
          signature,
          extraData
        });
        stats.okTotal += 1;
        stats.okSerialPermitTotal += 1;
        return;
      }

      if (url.pathname === "/risk-allowance") {
        _requireMethod(req, ["GET"]);
        if (!walletClients.risk) {
          throw new HttpError({
            status: 500,
            code: "signer_not_configured",
            message: "RISK_SIGNER_PRIVATE_KEY not set"
          });
        }
        const shopOwner = _getAddressParam(url, "shopOwner");
        const maxItems = _getUintParam(url, "maxItems", { min: 1n });
        const deadline = _getDeadlineParam(url, "deadline");
        const nonce = await _resolveNonce(publicClient, itemsAddress, shopOwner, url.searchParams.get("nonce"));

        const signature = await walletClients.risk.signTypedData({
          domain: { name: "MyShop", version: "1", chainId: domainChainId, verifyingContract: getAddress(itemsAddress) },
          types: {
            RiskAllowance: [
              { name: "shopOwner", type: "address" },
              { name: "maxItems", type: "uint256" },
              { name: "deadline", type: "uint256" },
              { name: "nonce", type: "uint256" }
            ]
          },
          primaryType: "RiskAllowance",
          message: { shopOwner, maxItems, deadline, nonce }
        });

        _json(res, 200, {
          ok: true,
          shopOwner,
          maxItems: maxItems.toString(),
          deadline: deadline.toString(),
          nonce: nonce.toString(),
          signature
        });
        stats.okTotal += 1;
        stats.okRiskAllowanceTotal += 1;
        return;
      }

      _json(res, 404, { ok: false, error: "not_found" });
    } catch (e) {
      if (e instanceof RateLimitError) {
        stats.rateLimitedTotal += 1;
        const retryAfterMs = typeof e.retryAfterMs === "number" ? e.retryAfterMs : null;
        const retryAfterSec = retryAfterMs != null ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null;
        _json(
          res,
          429,
          {
            ok: false,
            error: "rate_limited",
            errorCode: "rate_limited",
            retryAfterMs
          },
          retryAfterSec != null ? { "retry-after": String(retryAfterSec) } : {}
        );
        return;
      }
      if (e instanceof HttpError) {
        stats.httpErrorTotal += 1;
        stats.errorCodeCounts.set(e.code, (stats.errorCodeCounts.get(e.code) ?? 0) + 1);
        _json(res, e.status, {
          ok: false,
          error: e.message,
          errorCode: e.code,
          errorDetails: e.details
        });
        return;
      }
      stats.internalErrorTotal += 1;
      stats.errorCodeCounts.set("internal_error", (stats.errorCodeCounts.get("internal_error") ?? 0) + 1);
      _json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e), errorCode: "internal_error" });
    } finally {
      stats.pathCounts.set(pathName, (stats.pathCounts.get(pathName) ?? 0) + 1);
      const durationMs = Date.now() - startedAtMs;
      stats.pathDurationSumMs.set(pathName, (stats.pathDurationSumMs.get(pathName) ?? 0) + durationMs);
      stats.pathDurationCount.set(pathName, (stats.pathDurationCount.get(pathName) ?? 0) + 1);
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return {
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    port
  };
}

function _get(url, key) {
  const value = url.searchParams.get(key);
  if (!value) {
    throw new HttpError({
      status: 400,
      code: "missing_param",
      message: `Missing query param: ${key}`,
      details: { param: key }
    });
  }
  return value;
}

function _json(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    ...extraHeaders
  });
  res.end(JSON.stringify(obj));
}

function _text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(body);
}

function _requireMethod(req, allowed) {
  const method = req.method ?? "GET";
  if (allowed.includes(method)) return;
  throw new HttpError({
    status: 405,
    code: "method_not_allowed",
    message: "Method not allowed",
    details: { method, allowed }
  });
}

function _getAddressParam(url, key) {
  const raw = _get(url, key);
  try {
    return getAddress(raw);
  } catch {
    throw new HttpError({
      status: 400,
      code: "invalid_param",
      message: `Invalid address param: ${key}`,
      details: { param: key, value: raw }
    });
  }
}

function _getUintParam(url, key, { min, max } = {}) {
  const raw = _get(url, key);
  if (!/^\d+$/.test(raw)) {
    throw new HttpError({
      status: 400,
      code: "invalid_param",
      message: `Invalid uint param: ${key}`,
      details: { param: key, value: raw }
    });
  }
  const value = BigInt(raw);
  if (min != null && value < min) {
    throw new HttpError({
      status: 400,
      code: "invalid_param",
      message: `Param out of range: ${key}`,
      details: { param: key, value: raw, min: min.toString() }
    });
  }
  if (max != null && value > max) {
    throw new HttpError({
      status: 400,
      code: "invalid_param",
      message: `Param out of range: ${key}`,
      details: { param: key, value: raw, max: max.toString() }
    });
  }
  return value;
}

function _getDeadlineParam(url, key) {
  const deadline = _getUintParam(url, key, { min: 1n });
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= nowSec) {
    throw new HttpError({
      status: 400,
      code: "deadline_expired",
      message: "deadline must be in the future",
      details: { param: key, nowSec: nowSec.toString(), deadline: deadline.toString() }
    });
  }
  return deadline;
}

function _getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded) && forwarded.length > 0 && forwarded[0].trim()) return forwarded[0].split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function _rateLimitOrThrow({ req, url, limiter }) {
  const ip = _getClientIp(req);
  const key = `${ip}:${url.pathname}`;
  const now = Date.now();

  const existing = limiter.buckets.get(key);
  if (!existing) {
    _evictIfNeeded(limiter, now);
    limiter.buckets.set(key, { timestamps: [now], lastSeenMs: now });
    return;
  }

  existing.lastSeenMs = now;
  const cutoff = now - limiter.windowMs;
  const ts = existing.timestamps;
  let keepFrom = 0;
  while (keepFrom < ts.length && ts[keepFrom] < cutoff) keepFrom++;
  if (keepFrom > 0) ts.splice(0, keepFrom);

  if (ts.length >= limiter.max) {
    const oldest = ts.length ? ts[0] : now;
    const retryAfterMs = Math.max(1, oldest + limiter.windowMs - now);
    throw new RateLimitError({ retryAfterMs });
  }
  ts.push(now);
}

function _evictIfNeeded(limiter, nowMs) {
  if (limiter.buckets.size < limiter.maxBuckets) return;

  let oldestKey = null;
  let oldestSeen = Infinity;
  for (const [k, v] of limiter.buckets.entries()) {
    const seen = typeof v?.lastSeenMs === "number" ? v.lastSeenMs : nowMs;
    if (seen < oldestSeen) {
      oldestSeen = seen;
      oldestKey = k;
    }
  }
  if (oldestKey != null) limiter.buckets.delete(oldestKey);
}

async function _resolveNonce(publicClient, itemsAddress, user, nonceParam) {
  if (nonceParam != null && nonceParam !== "") {
    if (!/^\d+$/.test(nonceParam)) {
      throw new HttpError({
        status: 400,
        code: "invalid_param",
        message: "Invalid uint param: nonce",
        details: { param: "nonce", value: nonceParam }
      });
    }
    const nonce = BigInt(nonceParam);
    const maxNonce = BigInt(process.env.PERMIT_MAX_NONCE ?? "1000000");
    if (nonce > maxNonce) {
      throw new HttpError({
        status: 400,
        code: "invalid_param",
        message: "Param out of range: nonce",
        details: { param: "nonce", value: nonceParam, max: maxNonce.toString() }
      });
    }
    return nonce;
  }
  for (let i = 0n; i < 1000n; i++) {
    const used = await publicClient.readContract({
      address: getAddress(itemsAddress),
      abi: myShopItemsAbi,
      functionName: "usedNonces",
      args: [user, i]
    });
    if (!used) return i;
  }
  throw new Error("No free nonce found within 0..999");
}

async function _resolveSerialHash({ url, serialIssuerUrl, buyer, itemId }) {
  const serialHashParam = url.searchParams.get("serialHash");
  if (serialHashParam) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(serialHashParam)) {
      throw new HttpError({
        status: 400,
        code: "invalid_param",
        message: "Invalid bytes32 param: serialHash",
        details: { param: "serialHash", value: serialHashParam }
      });
    }
    return { serial: null, serialHash: serialHashParam };
  }

  const serialParam = url.searchParams.get("serial");
  if (serialParam) {
    const maxLen = Number(process.env.PERMIT_MAX_SERIAL_LENGTH ?? "128");
    if (serialParam.length < 1 || serialParam.length > maxLen) {
      throw new HttpError({
        status: 400,
        code: "invalid_param",
        message: "Param out of range: serial",
        details: { param: "serial", minLength: 1, maxLength: maxLen }
      });
    }
    return { serial: serialParam, serialHash: keccak256(toBytes(serialParam)) };
  }

  if (!serialIssuerUrl) {
    throw new HttpError({
      status: 400,
      code: "missing_param",
      message: "Missing query param: serial (or set SERIAL_ISSUER_URL)",
      details: { param: "serial" }
    });
  }

  const context = url.searchParams.get("context");
  const maxContextLen = Number(process.env.PERMIT_MAX_CONTEXT_LENGTH ?? "256");
  if (context != null && context.length > maxContextLen) {
    throw new HttpError({
      status: 400,
      code: "invalid_param",
      message: "Param out of range: context",
      details: { param: "context", maxLength: maxContextLen }
    });
  }

  const issued = await _issueSerial(serialIssuerUrl, {
    buyer,
    itemId: itemId.toString(),
    context
  });

  if (issued.serialHash) return { serial: issued.serial ?? null, serialHash: issued.serialHash };
  if (issued.serial) return { serial: issued.serial, serialHash: keccak256(toBytes(issued.serial)) };
  throw new HttpError({
    status: 502,
    code: "serial_issuer_error",
    message: "SERIAL_ISSUER_URL response must include serial or serialHash"
  });
}

async function _issueSerial(serialIssuerUrl, payload) {
  if (serialIssuerUrl === "mock" || serialIssuerUrl === "mock://serial") {
    const seed = `myshop:serialIssuerMock:v1:${payload.buyer}:${payload.itemId}:${payload.context ?? ""}`;
    return { serialHash: keccak256(toBytes(seed)) };
  }

  let res;
  try {
    res = await fetch(serialIssuerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    throw new HttpError({
      status: 502,
      code: "serial_issuer_error",
      message: e instanceof Error ? e.message : String(e)
    });
  }

  if (!res.ok) {
    throw new HttpError({
      status: 502,
      code: "serial_issuer_error",
      message: `SERIAL_ISSUER_URL error: HTTP ${res.status}`
    });
  }
  const json = await res.json();
  if (json == null || typeof json !== "object") {
    throw new HttpError({
      status: 502,
      code: "serial_issuer_error",
      message: "SERIAL_ISSUER_URL returned non-object JSON"
    });
  }
  return json;
}
