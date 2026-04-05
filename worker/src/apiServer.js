import http from "node:http";
import { URL } from "node:url";

import { decodeEventLog, getAddress, http as httpTransport, parseAbiItem } from "viem";
import { createPublicClient } from "viem";

import { myShopItemsAbi, myShopsAbi } from "./abi.js";
import { openDb, getDbPath } from "./db.js";

const purchasedEvent = parseAbiItem(
  "event Purchased(uint256 indexed itemId,uint256 indexed shopId,address indexed buyer,address recipient,uint256 quantity,address payToken,uint256 payAmount,uint256 platformFeeAmount,bytes32 serialHash,uint256 firstTokenId)"
);

export async function startApiServer({ rpcUrl, chain, itemsAddress, port }) {
  const client = createPublicClient({
    chain,
    transport: httpTransport(rpcUrl)
  });

  const items = getAddress(itemsAddress);
  const cache = {
    shopsAddress: null,
    itemById: new Map(),
    shopById: new Map(),
    itemCount: null,
    itemCountAtMs: 0,
    shopCount: null,
    shopCountAtMs: 0
  };

  const indexer = {
    enabled: process.env.ENABLE_INDEXER == null ? true : process.env.ENABLE_INDEXER === "1",
    pollIntervalMs: Number(process.env.INDEXER_POLL_INTERVAL_MS ?? "1000"),
    lookbackBlocks: BigInt(process.env.INDEXER_LOOKBACK_BLOCKS ?? "5000"),
    replayLookbackBlocks: BigInt(process.env.INDEXER_REPLAY_LOOKBACK_BLOCKS ?? "50"),
    reorgLookbackBlocks: BigInt(process.env.INDEXER_REORG_LOOKBACK_BLOCKS ?? "5"),
    dedupeWindowBlocks: BigInt(process.env.INDEXER_DEDUPE_WINDOW_BLOCKS ?? "2048"),
    maxRecords: Number(process.env.INDEXER_MAX_RECORDS ?? "5000"),
    lastIndexedBlock: null,
    lastTipBlock: null,
    lastPollAtMs: null,
    lastSuccessAtMs: null,
    lastErrorAtMs: null,
    lastError: null,
    lastErrorKind: null,
    lastBackoffAtMs: null,
    lastBackoffMs: null,
    consecutiveErrors: 0,
    totalPolls: 0,
    totalErrors: 0,
    totalBackoffs: 0,
    totalBackoffMs: 0,
    recoveredFromErrorCount: 0,
    lastRecoveryAtMs: null,
    lastRangeFromBlock: null,
    lastRangeToBlock: null,
    lastLogsCount: null,
    totalLogFetches: 0,
    totalLogs: 0,
    purchases: [],
    purchaseKeys: new Set(),
    droppedOnReplay: 0,
    droppedOnReorg: 0,
    running: false,
    stop: false,
    replayedOnStart: false,
    persist: {
      enabled: process.env.INDEXER_PERSIST === "0" ? false : true,
      lastSavedAtMs: null,
      errors: 0
    }
  };

  if (indexer.persist.enabled) {
    _loadIndexerState({ indexer, chainId: chain.id, itemsAddress: items });
  }

  if (indexer.enabled) {
    indexer.running = true;
    _startIndexer({ client, chainId: chain.id, itemsAddress: items, cache, indexer }).catch(() => {
      indexer.running = false;
    });
  }

  const stats = {
    requestsTotal: 0,
    okTotal: 0,
    httpErrorTotal: 0,
    internalErrorTotal: 0,
    pathCounts: new Map(),
    pathDurationSumMs: new Map(),
    pathDurationCount: new Map()
  };

  const server = http.createServer(async (req, res) => {
    const startedAtMs = Date.now();
    let pathName = "unknown";
    let statusCode = 0;
    const originalWriteHead = res.writeHead;
    res.writeHead = function (...args) {
      statusCode = Number(args[0] ?? 0);
      return originalWriteHead.apply(this, args);
    };
    try {
      if (req.method === "OPTIONS") {
        pathName = "OPTIONS";
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-api-key"
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      pathName = url.pathname;

      if (url.pathname === "/health") {
        let dbStatus = "ok";
        let totalPurchasesInDb = null;
        try {
          const db = openDb();
          const row = db.prepare("SELECT COUNT(*) AS cnt FROM purchases WHERE chain_id = ?").get(chain.id);
          totalPurchasesInDb = row ? Number(row.cnt) : 0;
        } catch {
          dbStatus = "error";
        }
        return _json(res, 200, {
          ok: true,
          timestamp: Math.floor(Date.now() / 1000),
          services: {
            apiServer: { status: "ok", port },
            indexer: {
              status: indexer.running ? "ok" : (indexer.enabled ? "stopped" : "disabled"),
              enabled: indexer.enabled,
              lastIndexedBlock: indexer.lastIndexedBlock?.toString() ?? null,
              cachedPurchases: indexer.purchases.length,
              totalPurchasesInDb
            },
            db: { status: dbStatus, path: getDbPath() }
          }
        });
      }

      if (url.pathname === "/config") {
        const shopsAddress = await _resolveShopsAddress(client, items, cache);
        return _json(res, 200, {
          ok: true,
          chainId: chain.id,
          rpcUrl,
          itemsAddress: items,
          shopsAddress,
          indexer: {
            enabled: indexer.enabled,
            running: indexer.running,
            lastIndexedBlock: indexer.lastIndexedBlock?.toString() ?? null,
            cachedPurchases: indexer.purchases.length
          }
        });
      }

      if (url.pathname === "/indexer") {
        const lagBlocks =
          indexer.lastTipBlock != null && indexer.lastIndexedBlock != null
            ? (indexer.lastTipBlock - indexer.lastIndexedBlock).toString()
            : null;
        return _json(res, 200, {
          ok: true,
          enabled: indexer.enabled,
          running: indexer.running,
          pollIntervalMs: indexer.pollIntervalMs,
          lookbackBlocks: indexer.lookbackBlocks.toString(),
          replayLookbackBlocks: indexer.replayLookbackBlocks.toString(),
          reorgLookbackBlocks: indexer.reorgLookbackBlocks.toString(),
          dedupeWindowBlocks: indexer.dedupeWindowBlocks.toString(),
          maxRecords: indexer.maxRecords,
          lastIndexedBlock: indexer.lastIndexedBlock?.toString() ?? null,
          lastTipBlock: indexer.lastTipBlock?.toString() ?? null,
          lagBlocks,
          lastPollAtMs: indexer.lastPollAtMs,
          lastSuccessAtMs: indexer.lastSuccessAtMs,
          lastErrorAtMs: indexer.lastErrorAtMs,
          lastError: indexer.lastError,
          lastErrorKind: indexer.lastErrorKind,
          lastBackoffAtMs: indexer.lastBackoffAtMs,
          lastBackoffMs: indexer.lastBackoffMs,
          consecutiveErrors: indexer.consecutiveErrors,
          totalPolls: indexer.totalPolls,
          totalErrors: indexer.totalErrors,
          totalBackoffs: indexer.totalBackoffs,
          totalBackoffMs: indexer.totalBackoffMs,
          recoveredFromErrorCount: indexer.recoveredFromErrorCount,
          lastRecoveryAtMs: indexer.lastRecoveryAtMs,
          reconnectCount: indexer.recoveredFromErrorCount,
          lastReconnectAtMs: indexer.lastRecoveryAtMs,
          lastRangeFromBlock: indexer.lastRangeFromBlock?.toString() ?? null,
          lastRangeToBlock: indexer.lastRangeToBlock?.toString() ?? null,
          lastLogsCount: indexer.lastLogsCount,
          totalLogFetches: indexer.totalLogFetches,
          totalLogs: indexer.totalLogs,
          droppedOnReplay: indexer.droppedOnReplay,
          droppedOnReorg: indexer.droppedOnReorg,
          cachedPurchases: indexer.purchases.length,
          persist: {
            enabled: indexer.persist.enabled,
            path: getDbPath(),
            lastSavedAtMs: indexer.persist.lastSavedAtMs,
            errors: indexer.persist.errors
          }
        });
      }

      if (url.pathname === "/metrics") {
        const enabled = indexer.enabled ? 1 : 0;
        const running = indexer.running ? 1 : 0;
        const lastIndexed = indexer.lastIndexedBlock ?? null;
        const lastTip = indexer.lastTipBlock ?? null;
        const lag = lastIndexed != null && lastTip != null ? lastTip - lastIndexed : null;

        const lines = [];
        lines.push(`myshop_api_requests_total ${stats.requestsTotal}`);
        lines.push(`myshop_api_ok_total ${stats.okTotal}`);
        lines.push(`myshop_api_http_error_total ${stats.httpErrorTotal}`);
        lines.push(`myshop_api_internal_error_total ${stats.internalErrorTotal}`);
        lines.push(`myshop_indexer_enabled ${enabled}`);
        lines.push(`myshop_indexer_running ${running}`);
        if (lastIndexed != null) lines.push(`myshop_indexer_last_indexed_block ${lastIndexed.toString()}`);
        if (lastTip != null) lines.push(`myshop_indexer_last_tip_block ${lastTip.toString()}`);
        if (lag != null) lines.push(`myshop_indexer_lag_blocks ${lag.toString()}`);
        lines.push(`myshop_indexer_cached_purchases ${indexer.purchases.length}`);
        lines.push(`myshop_indexer_consecutive_errors ${indexer.consecutiveErrors}`);
        lines.push(`myshop_indexer_total_polls ${indexer.totalPolls}`);
        lines.push(`myshop_indexer_total_errors ${indexer.totalErrors}`);
        lines.push(`myshop_indexer_recovered_from_error_count ${indexer.recoveredFromErrorCount}`);
        lines.push(`myshop_indexer_reconnect_count ${indexer.recoveredFromErrorCount}`);
        lines.push(`myshop_indexer_total_backoffs ${indexer.totalBackoffs}`);
        lines.push(`myshop_indexer_total_backoff_ms_sum ${indexer.totalBackoffMs}`);
        if (indexer.lastPollAtMs != null) lines.push(`myshop_indexer_last_poll_at_ms ${indexer.lastPollAtMs}`);
        if (indexer.lastSuccessAtMs != null) lines.push(`myshop_indexer_last_success_at_ms ${indexer.lastSuccessAtMs}`);
        if (indexer.lastErrorAtMs != null) lines.push(`myshop_indexer_last_error_at_ms ${indexer.lastErrorAtMs}`);
        if (indexer.lastBackoffMs != null) lines.push(`myshop_indexer_last_backoff_ms ${indexer.lastBackoffMs}`);
        if (indexer.lastBackoffAtMs != null) lines.push(`myshop_indexer_last_backoff_at_ms ${indexer.lastBackoffAtMs}`);
        if (indexer.lastRecoveryAtMs != null) lines.push(`myshop_indexer_last_recovery_at_ms ${indexer.lastRecoveryAtMs}`);
        if (indexer.lastRecoveryAtMs != null) lines.push(`myshop_indexer_last_reconnect_at_ms ${indexer.lastRecoveryAtMs}`);
        lines.push(`myshop_indexer_last_error_kind_tip ${indexer.lastErrorKind === "tip" ? 1 : 0}`);
        lines.push(`myshop_indexer_last_error_kind_logs ${indexer.lastErrorKind === "logs" ? 1 : 0}`);
        lines.push(`myshop_indexer_total_log_fetches ${indexer.totalLogFetches}`);
        lines.push(`myshop_indexer_total_logs ${indexer.totalLogs}`);
        if (indexer.lastLogsCount != null) lines.push(`myshop_indexer_last_logs_count ${indexer.lastLogsCount}`);
        if (indexer.lastRangeFromBlock != null) lines.push(`myshop_indexer_last_range_from_block ${indexer.lastRangeFromBlock.toString()}`);
        if (indexer.lastRangeToBlock != null) lines.push(`myshop_indexer_last_range_to_block ${indexer.lastRangeToBlock.toString()}`);
        lines.push(`myshop_indexer_reorg_lookback_blocks ${indexer.reorgLookbackBlocks.toString()}`);
        lines.push(`myshop_indexer_dedupe_window_blocks ${indexer.dedupeWindowBlocks.toString()}`);
        lines.push(`myshop_indexer_dropped_on_replay ${indexer.droppedOnReplay}`);
        lines.push(`myshop_indexer_dropped_on_reorg ${indexer.droppedOnReorg}`);
        lines.push(`myshop_indexer_persist_enabled ${indexer.persist.enabled ? 1 : 0}`);
        lines.push(`myshop_indexer_persist_errors ${indexer.persist.errors}`);
        if (indexer.persist.lastSavedAtMs != null) lines.push(`myshop_indexer_persist_last_saved_at_ms ${indexer.persist.lastSavedAtMs}`);
        lines.push(`myshop_indexer_db_purchases ${indexer.purchases.length}`);

        const paths = Array.from(stats.pathCounts.keys()).sort();
        for (const p of paths) {
          const safePath = String(p).replace(/[^a-zA-Z0-9_]/g, "_");
          lines.push(`myshop_api_path_${safePath}_requests_total ${stats.pathCounts.get(p) ?? 0}`);
          lines.push(`myshop_api_path_${safePath}_duration_ms_sum ${stats.pathDurationSumMs.get(p) ?? 0}`);
          lines.push(`myshop_api_path_${safePath}_duration_ms_count ${stats.pathDurationCount.get(p) ?? 0}`);
        }

        return _text(res, 200, `${lines.join("\n")}\n`);
      }

      if (url.pathname === "/shop") {
        const shopId = BigInt(_get(url, "shopId"));
        const shop = await _getShop(client, items, shopId, cache);
        return _json(res, 200, { ok: true, shopId: shopId.toString(), shop });
      }

      if (url.pathname === "/shops") {
        const cursorParam = url.searchParams.get("cursor");
        const limitParam = url.searchParams.get("limit");
        const cursor = cursorParam ? BigInt(cursorParam) : 1n;
        const limit = limitParam ? Math.min(200, Math.max(1, Number(limitParam))) : 20;

        const shopsAddress = await _resolveShopsAddress(client, items, cache);
        const count = await _getShopCount(client, shopsAddress, cache);

        const shops = [];
        for (let id = cursor; id <= count && shops.length < limit; id++) {
          const shop = await _getShop(client, items, id, cache);
          shops.push({ shopId: id.toString(), shop });
        }

        const nextCursor = cursor + BigInt(shops.length);
        return _json(res, 200, {
          ok: true,
          cursor: cursor.toString(),
          nextCursor: nextCursor <= count ? nextCursor.toString() : null,
          shopCount: count.toString(),
          shops
        });
      }

      if (url.pathname === "/item") {
        const itemId = BigInt(_get(url, "itemId"));
        const item = await _getItem(client, items, itemId, cache);
        return _json(res, 200, { ok: true, itemId: itemId.toString(), item });
      }

      if (url.pathname === "/items") {
        const cursorParam = url.searchParams.get("cursor");
        const limitParam = url.searchParams.get("limit");
        const cursor = cursorParam ? BigInt(cursorParam) : 1n;
        const limit = limitParam ? Math.min(200, Math.max(1, Number(limitParam))) : 20;

        const count = await _getItemCount(client, items, cache);

        const itemsList = [];
        for (let id = cursor; id <= count && itemsList.length < limit; id++) {
          const item = await _getItem(client, items, id, cache);
          itemsList.push({ itemId: id.toString(), item });
        }

        const nextCursor = cursor + BigInt(itemsList.length);
        return _json(res, 200, {
          ok: true,
          cursor: cursor.toString(),
          nextCursor: nextCursor <= count ? nextCursor.toString() : null,
          itemCount: count.toString(),
          items: itemsList
        });
      }

      if (url.pathname === "/purchases") {
        const args = {};
        const buyer = url.searchParams.get("buyer");
        const shopId = url.searchParams.get("shopId");
        const itemId = url.searchParams.get("itemId");

        if (buyer) args.buyer = getAddress(buyer);
        if (shopId) args.shopId = BigInt(shopId);
        if (itemId) args.itemId = BigInt(itemId);

        const latest = await client.getBlockNumber();
        const fromBlock = url.searchParams.get("fromBlock")
          ? BigInt(url.searchParams.get("fromBlock"))
          : latest > 5000n
            ? latest - 5000n
            : 0n;
        const toBlock = url.searchParams.get("toBlock") ? BigInt(url.searchParams.get("toBlock")) : latest;

        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Math.min(2000, Math.max(1, Number(limitParam))) : 200;

        const include = url.searchParams.get("include") ?? "enrich";
        const includeEnrich = include.includes("enrich");

        const source = (url.searchParams.get("source") ?? "index").toLowerCase();
        // "db" source: query SQLite directly (historical, full dataset, no block range limit)
        const useDb = indexer.persist.enabled && source === "db";
        const useIndex = !useDb && indexer.enabled && source !== "chain";

        let purchases;
        let resolvedSource;
        if (useDb) {
          purchases = await _getPurchasesFromDb({
            client,
            chainId: chain.id,
            itemsAddress: items,
            buyer: args.buyer,
            shopId: args.shopId,
            itemId: args.itemId,
            limit,
            includeEnrich,
            cache
          });
          resolvedSource = "db";
        } else if (useIndex) {
          purchases = await _getPurchasesFromIndex({
            client,
            chainId: chain.id,
            itemsAddress: items,
            fromBlock,
            toBlock,
            buyer: args.buyer,
            shopId: args.shopId,
            itemId: args.itemId,
            limit,
            includeEnrich,
            cache,
            indexer
          });
          resolvedSource = "index";
        } else {
          purchases = await _getPurchasesFromChain({
            client,
            chainId: chain.id,
            itemsAddress: items,
            fromBlock,
            toBlock,
            args: Object.keys(args).length ? args : undefined,
            limit,
            includeEnrich,
            cache
          });
          resolvedSource = "chain";
        }

        return _json(res, 200, {
          ok: true,
          source: resolvedSource,
          fromBlock: fromBlock.toString(),
          toBlock: toBlock.toString(),
          latest: latest.toString(),
          indexedToBlock: indexer.lastIndexedBlock?.toString() ?? null,
          count: purchases.length,
          purchases
        });
      }

      // W5: shop stats API — /shop-stats?shopId=1
      if (url.pathname === "/shop-stats") {
        const shopIdParam = url.searchParams.get("shopId");
        if (!shopIdParam) {
          return _json(res, 400, { ok: false, error: "shopId required" });
        }
        const shopId = BigInt(shopIdParam);
        const shop = await _getShop(client, items, shopId, cache);
        const itemCount = await _getShopItemCount(client, items, shopId, cache);

        // Aggregate from SQLite if available, else from in-memory index
        const stats = indexer.persist.enabled
          ? _getShopStatsFromDb({ chainId: chain.id, shopId: shopIdParam })
          : _getShopStatsFromIndex({ indexer, shopId: shopIdParam });

        return _json(res, 200, {
          ok: true,
          shopId: shopId.toString(),
          shop,
          itemCount: itemCount.toString(),
          stats
        });
      }

      if (url.pathname === "/risk-summary") {
        const buyer = url.searchParams.get("buyer");
        const shopIdParam = url.searchParams.get("shopId");
        const itemIdParam = url.searchParams.get("itemId");
        const source = (url.searchParams.get("source") ?? "index").toLowerCase();
        const useIndex = indexer.enabled && source !== "chain";

        const args = {};
        if (buyer) args.buyer = getAddress(buyer);
        if (shopIdParam) args.shopId = BigInt(shopIdParam);
        if (itemIdParam) args.itemId = BigInt(itemIdParam);

        let list;
        if (useIndex) {
          list = indexer.purchases.slice();
          if (args.buyer) list = list.filter((p) => p.buyer.toLowerCase() === args.buyer.toLowerCase());
          if (args.shopId) list = list.filter((p) => p.shopId === args.shopId.toString());
          if (args.itemId) list = list.filter((p) => p.itemId === args.itemId.toString());
        } else {
          const latest = await client.getBlockNumber();
          const fromBlock = latest > 5000n ? latest - 5000n : 0n;
          list = await _getPurchasesFromChain({
            client,
            chainId: chain.id,
            itemsAddress: items,
            fromBlock,
            toBlock: latest,
            args: Object.keys(args).length ? args : undefined,
            limit: 2000,
            includeEnrich: false,
            cache
          });
        }

        const summary = await _buildRiskSummary({ client, list, cache });
        return _json(res, 200, { ok: true, source: useIndex ? "index" : "chain", ...summary });
      }

      // W14: Dispute routes — only when DISPUTE_ESCROW_ADDRESS is configured
      const disputeEscrowAddress = process.env.DISPUTE_ESCROW_ADDRESS;
      if (disputeEscrowAddress) {
        // GET /disputes/:purchaseId
        const disputeByIdMatch = url.pathname.match(/^\/disputes\/(0x[0-9a-fA-F]{64})$/);
        if (disputeByIdMatch) {
          const purchaseId = disputeByIdMatch[1].toLowerCase();
          const db = openDb();
          const row = db.prepare("SELECT * FROM disputes WHERE purchase_id = ?").get(purchaseId);
          if (!row) return _json(res, 404, { ok: false, error: "no_dispute" });
          return _json(res, 200, { ok: true, ...formatDispute(row) });
        }

        // GET /disputes?buyer=0x...
        if (url.pathname === "/disputes") {
          const buyer = url.searchParams.get("buyer");
          const db = openDb();
          let rows;
          if (buyer) {
            const buyerAddr = getAddress(buyer);
            rows = db.prepare("SELECT * FROM disputes WHERE buyer = ? ORDER BY opened_at DESC LIMIT 100").all(buyerAddr);
          } else {
            rows = db.prepare("SELECT * FROM disputes ORDER BY opened_at DESC LIMIT 100").all();
          }
          return _json(res, 200, { ok: true, count: rows.length, disputes: rows.map(formatDispute) });
        }
      }

      // W15: x402 access verification — GET /x402/verify?address=0x...&resource=<uri>&contract=0x...
      if (url.pathname === "/x402/verify") {
        // Optional API-key auth (X402_API_KEY env; if unset, no auth required for dev)
        const x402ApiKey = process.env.X402_API_KEY;
        if (x402ApiKey) {
          const reqKey = req.headers["x-api-key"];
          if (reqKey !== x402ApiKey) {
            return _json(res, 401, { ok: false, error: "unauthorized" });
          }
        }

        const addressParam = url.searchParams.get("address");
        const resource = url.searchParams.get("resource") ?? "";
        const contractParam = url.searchParams.get("contract");

        if (!addressParam || !contractParam) {
          return _json(res, 400, { ok: false, error: "address and contract are required" });
        }

        const holderAddress = getAddress(addressParam);
        const nftContract = getAddress(contractParam);

        // Simple balanceOf check — no signing needed
        const balanceRaw = await client.readContract({
          address: nftContract,
          abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
          functionName: "balanceOf",
          args: [holderAddress]
        });
        const balance = Number(BigInt(balanceRaw));
        return _json(res, 200, {
          ok: true,
          eligible: balance > 0,
          balance,
          resource,
          address: holderAddress
        });
      }

      return _json(res, 404, { ok: false, error: "not_found" });
    } catch (e) {
      return _json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      stats.requestsTotal += 1;
      stats.pathCounts.set(pathName, (stats.pathCounts.get(pathName) ?? 0) + 1);

      const durationMs = Date.now() - startedAtMs;
      stats.pathDurationSumMs.set(pathName, (stats.pathDurationSumMs.get(pathName) ?? 0) + durationMs);
      stats.pathDurationCount.set(pathName, (stats.pathDurationCount.get(pathName) ?? 0) + 1);

      if (statusCode >= 200 && statusCode < 400) stats.okTotal += 1;
      else if (statusCode >= 400 && statusCode < 500) stats.httpErrorTotal += 1;
      else stats.internalErrorTotal += 1;
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return {
    close: () =>
      new Promise((resolve, reject) => {
        indexer.stop = true;
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    port
  };
}

function formatDispute(row) {
  return {
    purchaseId: row.purchase_id,
    buyer: row.buyer,
    status: row.status,
    payToken: row.pay_token,
    amount: row.amount,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    txHash: row.tx_hash
  };
}

function _json(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
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

function _get(url, key) {
  const value = url.searchParams.get(key);
  if (!value) throw new Error(`Missing query param: ${key}`);
  return value;
}

async function _resolveShopsAddress(client, itemsAddress, cache) {
  if (cache.shopsAddress) return cache.shopsAddress;
  cache.shopsAddress = getAddress(
    await client.readContract({
      address: itemsAddress,
      abi: myShopItemsAbi,
      functionName: "shops",
      args: []
    })
  );
  return cache.shopsAddress;
}

async function _getItem(client, itemsAddress, itemId, cache) {
  const key = itemId.toString();
  const cached = cache.itemById.get(key);
  if (cached) return cached;

  const rawItem = await client.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "items",
    args: [itemId]
  });

  const item = {
    shopId: pick(rawItem, "shopId", 0).toString(),
    payToken: pick(rawItem, "payToken", 1),
    unitPrice: pick(rawItem, "unitPrice", 2).toString(),
    nftContract: pick(rawItem, "nftContract", 3),
    soulbound: pick(rawItem, "soulbound", 4),
    tokenURI: pick(rawItem, "tokenURI", 5),
    action: pick(rawItem, "action", 6),
    actionData: pick(rawItem, "actionData", 7),
    requiresSerial: pick(rawItem, "requiresSerial", 8),
    active: pick(rawItem, "active", 9)
  };

  cache.itemById.set(key, item);
  return item;
}

async function _getShop(client, itemsAddress, shopId, cache) {
  const key = shopId.toString();
  const cached = cache.shopById.get(key);
  if (cached) return cached;

  const shopsAddress = await _resolveShopsAddress(client, itemsAddress, cache);
  const rawShop = await client.readContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "shops",
    args: [shopId]
  });

  const shop = {
    owner: pick(rawShop, "owner", 0),
    treasury: pick(rawShop, "treasury", 1),
    metadataHash: pick(rawShop, "metadataHash", 2),
    paused: pick(rawShop, "paused", 3)
  };

  cache.shopById.set(key, shop);
  return shop;
}

function pick(obj, key, index) {
  const value = obj?.[key] ?? obj?.[index];
  if (value === undefined) throw new Error(`Unable to read ${key}`);
  return value;
}

async function _getItemCount(client, itemsAddress, cache) {
  const now = Date.now();
  if (cache.itemCount != null && now - cache.itemCountAtMs < 1500) return cache.itemCount;
  const count = await client.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "itemCount",
    args: []
  });
  cache.itemCount = BigInt(count);
  cache.itemCountAtMs = now;
  return cache.itemCount;
}

async function _getShopCount(client, shopsAddress, cache) {
  const now = Date.now();
  if (cache.shopCount != null && now - cache.shopCountAtMs < 1500) return cache.shopCount;
  const count = await client.readContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "shopCount",
    args: []
  });
  cache.shopCount = BigInt(count);
  cache.shopCountAtMs = now;
  return cache.shopCount;
}

async function _getShopItemCount(client, itemsAddress, shopId, cache) {
  const key = `shopItemCount:${shopId}`;
  const now = Date.now();
  if (cache[key] != null && now - (cache[key + "AtMs"] ?? 0) < 1500) return cache[key];
  const count = await client.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "shopItemCount",
    args: [shopId]
  });
  cache[key] = BigInt(count);
  cache[key + "AtMs"] = now;
  return cache[key];
}

async function _getPurchasesFromChain({ client, chainId, itemsAddress, fromBlock, toBlock, args, limit, includeEnrich, cache }) {
  const logs = await client.getLogs({
    address: itemsAddress,
    event: purchasedEvent,
    args,
    fromBlock,
    toBlock
  });

  const sliced = logs.slice(0, Math.max(0, limit));
  const purchases = [];

  for (const log of sliced) {
    const base = _decodePurchasedLog({ chainId, log });
    if (!includeEnrich) {
      purchases.push(base);
      continue;
    }
    const item = await _getItem(client, itemsAddress, BigInt(base.itemId), cache);
    const shop = await _getShop(client, itemsAddress, BigInt(base.shopId), cache);
    purchases.push({ ...base, item, shop });
  }

  return purchases;
}

async function _getPurchasesFromIndex({
  client,
  chainId,
  itemsAddress,
  fromBlock,
  toBlock,
  buyer,
  shopId,
  itemId,
  limit,
  includeEnrich,
  cache,
  indexer
}) {
  if (fromBlock > BigInt(Number.MAX_SAFE_INTEGER) || toBlock > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("block range too large for in-memory indexer; use source=chain");
  }
  const from = Number(fromBlock);
  const to = Number(toBlock);

  const list = [];
  const buyerNorm = buyer ? buyer.toLowerCase() : null;
  const shopIdStr = shopId != null ? shopId.toString() : null;
  const itemIdStr = itemId != null ? itemId.toString() : null;

  for (let i = indexer.purchases.length - 1; i >= 0 && list.length < limit; i--) {
    const p = indexer.purchases[i];
    if (p.blockNumber < from || p.blockNumber > to) continue;
    if (buyerNorm && p.buyer.toLowerCase() !== buyerNorm) continue;
    if (shopIdStr && p.shopId !== shopIdStr) continue;
    if (itemIdStr && p.itemId !== itemIdStr) continue;
    list.push(p);
  }

  if (!includeEnrich) return list;

  const enriched = [];
  for (const p of list) {
    const item = await _getItem(client, itemsAddress, BigInt(p.itemId), cache);
    const shop = await _getShop(client, itemsAddress, BigInt(p.shopId), cache);
    enriched.push({ ...p, item, shop });
  }

  return enriched;
}

// W4: query purchases directly from SQLite (full history, not limited to in-memory window)
async function _getPurchasesFromDb({ client, chainId, itemsAddress, buyer, shopId, itemId, limit, includeEnrich, cache }) {
  try {
    const db = openDb();
    let sql = `SELECT tx_hash, log_index, block_number, item_id, shop_id, buyer, recipient,
                      quantity, pay_token, pay_amount, platform_fee_amount, serial_hash,
                      token_id AS first_token_id, chain_id
               FROM purchases WHERE chain_id = ?`;
    const params = [Number(chainId)];

    if (buyer) { sql += " AND LOWER(buyer) = ?"; params.push(buyer.toLowerCase()); }
    if (shopId != null) { sql += " AND shop_id = ?"; params.push(shopId.toString()); }
    if (itemId != null) { sql += " AND item_id = ?"; params.push(itemId.toString()); }
    sql += " ORDER BY block_number DESC, log_index DESC LIMIT ?";
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    const list = rows.map((r) => ({
      chainId: r.chain_id,
      txHash: r.tx_hash,
      logIndex: r.log_index,
      blockNumber: r.block_number,
      itemId: r.item_id,
      shopId: r.shop_id,
      buyer: r.buyer,
      recipient: r.recipient,
      quantity: r.quantity,
      payToken: r.pay_token,
      payAmount: r.pay_amount,
      platformFeeAmount: r.platform_fee_amount,
      serialHash: r.serial_hash,
      firstTokenId: r.first_token_id
    }));

    if (!includeEnrich) return list;
    const enriched = [];
    for (const p of list) {
      const item = await _getItem(client, itemsAddress, BigInt(p.itemId), cache);
      const shop = await _getShop(client, itemsAddress, BigInt(p.shopId), cache);
      enriched.push({ ...p, item, shop });
    }
    return enriched;
  } catch (e) {
    // Re-throw so the HTTP handler can return a proper error response
    throw Object.assign(new Error("db_query_failed: " + (e?.message ?? "unknown")), { code: "db_error" });
  }
}

// W5: aggregate shop stats from SQLite
// Revenue/fees stored as TEXT strings (wei-scale integers) — sum in JS with BigInt to avoid REAL precision loss
function _getShopStatsFromDb({ chainId, shopId }) {
  try {
    const db = openDb();
    // Quantities are safe to sum as integers; amounts are text wei-values, sum in JS
    const countRow = db.prepare(`
      SELECT COUNT(*) AS total_purchases,
             SUM(CAST(quantity AS INTEGER)) AS total_quantity,
             COUNT(DISTINCT buyer) AS unique_buyers,
             MAX(block_number) AS last_block
      FROM purchases WHERE chain_id = ? AND shop_id = ?
    `).get(Number(chainId), shopId.toString());

    const amountRows = db.prepare(`
      SELECT pay_amount, platform_fee_amount
      FROM purchases WHERE chain_id = ? AND shop_id = ?
    `).all(Number(chainId), shopId.toString());

    let totalRevenue = 0n;
    let totalPlatformFees = 0n;
    for (const r of amountRows) {
      try { totalRevenue += BigInt(r.pay_amount ?? "0"); } catch {}
      try { totalPlatformFees += BigInt(r.platform_fee_amount ?? "0"); } catch {}
    }

    return {
      source: "db",
      totalPurchases: countRow ? Number(countRow.total_purchases) : 0,
      totalQuantity: countRow ? Number(countRow.total_quantity ?? 0) : 0,
      totalRevenue: totalRevenue.toString(),
      totalPlatformFees: totalPlatformFees.toString(),
      uniqueBuyers: countRow ? Number(countRow.unique_buyers) : 0,
      lastPurchaseBlock: countRow?.last_block ?? null
    };
  } catch {
    return { source: "db", error: "db_unavailable" };
  }
}

// W5: aggregate shop stats from in-memory indexer
function _getShopStatsFromIndex({ indexer, shopId }) {
  let totalPurchases = 0;
  let totalQuantity = 0n;
  let totalRevenue = 0n;
  let totalPlatformFees = 0n;
  const buyers = new Set();
  let lastBlock = null;

  for (const p of indexer.purchases) {
    if (p.shopId !== shopId) continue;
    totalPurchases++;
    totalQuantity += _toBigInt(p.quantity);
    totalRevenue += _toBigInt(p.payAmount);
    totalPlatformFees += _toBigInt(p.platformFeeAmount);
    if (p.buyer) buyers.add(p.buyer.toLowerCase());
    if (p.blockNumber != null) {
      const b = Number(p.blockNumber);
      if (lastBlock == null || b > lastBlock) lastBlock = b;
    }
  }

  return {
    source: "index",
    totalPurchases,
    totalQuantity: totalQuantity.toString(),
    totalRevenue: totalRevenue.toString(),
    totalPlatformFees: totalPlatformFees.toString(),
    uniqueBuyers: buyers.size,
    lastPurchaseBlock: lastBlock
  };
}

async function _buildRiskSummary({ client, list }) {
  const buyerMap = new Map();
  const itemMap = new Map();
  const shopSet = new Set();
  const itemSet = new Set();
  let totalQuantity = 0n;
  let totalPayAmount = 0n;
  let totalPlatformFeeAmount = 0n;
  let lastBlock = null;
  let lastPurchaseAt = null;

  for (const p of list) {
    if (p.shopId != null) shopSet.add(String(p.shopId));
    if (p.itemId != null) itemSet.add(String(p.itemId));
    if (p.blockNumber != null) {
      const b = Number(p.blockNumber);
      if (lastBlock == null || b > lastBlock) lastBlock = b;
    }

    const quantity = _toBigInt(p.quantity);
    const payAmount = _toBigInt(p.payAmount);
    const platformFeeAmount = _toBigInt(p.platformFeeAmount);

    totalQuantity += quantity;
    totalPayAmount += payAmount;
    totalPlatformFeeAmount += platformFeeAmount;

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

  if (lastBlock != null) {
    try {
      const block = await client.getBlock({ blockNumber: BigInt(lastBlock) });
      if (block?.timestamp != null) {
        lastPurchaseAt = new Date(Number(block.timestamp) * 1000).toISOString();
      }
    } catch {
      lastPurchaseAt = null;
    }
  }

  const topBuyers = _topByValue(buyerMap, "payAmount", 5).map((entry) => ({
    buyer: entry.key,
    payAmount: entry.payAmount.toString(),
    purchases: entry.purchases
  }));
  const topItems = _topByValue(itemMap, "payAmount", 5).map((entry) => ({
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
    lastPurchaseAt,
    updatedAt: new Date().toISOString()
  };
}

function _toBigInt(value) {
  try {
    if (value == null) return 0n;
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function _topByValue(map, field, limit) {
  const list = [];
  for (const [key, value] of map.entries()) {
    list.push({ key, ...value });
  }
  list.sort((a, b) => {
    if (a[field] === b[field]) return 0;
    return a[field] > b[field] ? -1 : 1;
  });
  return list.slice(0, limit);
}

// Atomically persist a batch of purchases + advance last_block in one transaction
function _persistPurchaseBatch({ purchases, toBlock, chainId }) {
  try {
    const db = openDb();
    const insertPurchase = db.prepare(
      `INSERT OR IGNORE INTO purchases
         (shop_id, item_id, buyer, recipient, token_id, serial_hash, quantity,
          tx_hash, log_index, block_number, timestamp, chain_id, pay_token, pay_amount, platform_fee_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upsertState = db.prepare(
      `INSERT INTO indexer_state (chain_id, last_block, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chain_id) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at`
    );
    const nowSec = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      for (const p of purchases) {
        insertPurchase.run(
          p.shopId ?? "",
          p.itemId ?? "",
          p.buyer ?? "",
          p.recipient ?? "",
          p.firstTokenId ?? null,
          p.serialHash ?? null,
          p.quantity ?? "1",
          p.txHash ?? "",
          p.logIndex ?? 0,
          p.blockNumber ?? 0,
          0,
          Number(chainId),
          p.payToken ?? null,
          p.payAmount ?? null,
          p.platformFeeAmount ?? null
        );
      }
      upsertState.run(Number(chainId), Number(toBlock), nowSec);
    })();
    return true;
  } catch {
    // non-fatal: in-memory array is still the source of truth for queries
    return false;
  }
}

function _loadIndexerState({ indexer, chainId, itemsAddress }) {
  try {
    const db = openDb();

    // Load last indexed block from indexer_state table
    const stateRow = db.prepare("SELECT last_block FROM indexer_state WHERE chain_id = ?").get(Number(chainId));
    if (stateRow && stateRow.last_block > 0) {
      indexer.lastIndexedBlock = BigInt(stateRow.last_block);
    }

    // Load recent purchases into memory (up to maxRecords)
    const rows = db
      .prepare(
        `SELECT tx_hash, log_index, block_number, item_id, shop_id, buyer, recipient,
                quantity, pay_token, pay_amount, platform_fee_amount, serial_hash,
                token_id AS first_token_id, chain_id
         FROM purchases
         WHERE chain_id = ?
         ORDER BY block_number ASC, log_index ASC
         LIMIT ?`
      )
      .all(Number(chainId), indexer.maxRecords);

    indexer.purchases = rows.map((r) => ({
      chainId: r.chain_id,
      txHash: r.tx_hash,
      logIndex: r.log_index,
      blockNumber: r.block_number,
      itemId: r.item_id,
      shopId: r.shop_id,
      buyer: r.buyer,
      recipient: r.recipient,
      quantity: r.quantity,
      payToken: r.pay_token,
      payAmount: r.pay_amount,
      platformFeeAmount: r.platform_fee_amount,
      serialHash: r.serial_hash,
      firstTokenId: r.first_token_id
    }));
    indexer.purchaseKeys = new Set(indexer.purchases.map((p) => `${p.txHash}:${p.logIndex}`));
  } catch (e) {
    indexer.persist.errors += 1;
  }
}


function _decodePurchasedLog({ chainId, log }) {
  const decoded = decodeEventLog({
    abi: myShopItemsAbi,
    data: log.data,
    topics: log.topics
  });

  return {
    chainId,
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
}

function _rebuildPurchaseKeys(indexer) {
  indexer.purchaseKeys = new Set(indexer.purchases.map((p) => `${p.txHash}:${p.logIndex}`));
}

function _dropPurchasesFromBlock(indexer, fromBlock) {
  const threshold = Number(fromBlock);
  const before = indexer.purchases.length;
  indexer.purchases = indexer.purchases.filter((p) => Number(p.blockNumber) < threshold);
  const dropped = before - indexer.purchases.length;
  _rebuildPurchaseKeys(indexer);
  return dropped;
}

function _trimPurchasesToWindow(indexer) {
  if (indexer.lastIndexedBlock == null) return;
  if (indexer.dedupeWindowBlocks <= 0n) return;
  const floorBlock = indexer.lastIndexedBlock > indexer.dedupeWindowBlocks ? indexer.lastIndexedBlock - indexer.dedupeWindowBlocks : 0n;
  const floor = Number(floorBlock);
  const before = indexer.purchases.length;
  if (before === 0) return;
  indexer.purchases = indexer.purchases.filter((p) => Number(p.blockNumber) >= floor);
  if (indexer.purchases.length !== before) _rebuildPurchaseKeys(indexer);
}

async function _sleepBackoff(indexer) {
  const ms = _backoffMs(indexer);
  indexer.lastBackoffMs = ms;
  indexer.lastBackoffAtMs = Date.now();
  indexer.totalBackoffs += 1;
  indexer.totalBackoffMs += ms;
  await new Promise((r) => setTimeout(r, ms));
}

async function _startIndexer({ client, chainId, itemsAddress, cache, indexer }) {
  if (indexer.lastIndexedBlock == null) {
    const latest = await client.getBlockNumber();
    const startFrom = latest > indexer.lookbackBlocks ? latest - indexer.lookbackBlocks : 0n;
    indexer.lastIndexedBlock = startFrom > 0n ? startFrom - 1n : 0n;
  }

  if (!indexer.replayedOnStart && indexer.persist.enabled && indexer.replayLookbackBlocks > 0n) {
    const rewind = indexer.lastIndexedBlock > indexer.replayLookbackBlocks ? indexer.replayLookbackBlocks : indexer.lastIndexedBlock;
    indexer.lastIndexedBlock = indexer.lastIndexedBlock - rewind;
    indexer.droppedOnReplay += _dropPurchasesFromBlock(indexer, indexer.lastIndexedBlock + 1n);
    indexer.replayedOnStart = true;
  }

  while (!indexer.stop) {
    indexer.totalPolls += 1;
    indexer.lastPollAtMs = Date.now();

    let tip;
    try {
      tip = await client.getBlockNumber();
    } catch (e) {
      _markIndexerError(indexer, "tip", e);
      await _sleepBackoff(indexer);
      continue;
    }

    indexer.lastTipBlock = tip;
    let fromBlock = indexer.lastIndexedBlock + 1n;
    if (indexer.reorgLookbackBlocks > 0n && indexer.lastIndexedBlock > 0n) {
      const rewind =
        indexer.lastIndexedBlock > indexer.reorgLookbackBlocks ? indexer.reorgLookbackBlocks : indexer.lastIndexedBlock;
      const reorgFrom = indexer.lastIndexedBlock - rewind + 1n;
      if (reorgFrom < fromBlock) {
        fromBlock = reorgFrom;
        indexer.droppedOnReorg += _dropPurchasesFromBlock(indexer, fromBlock);
      }
    }
    const toBlock = tip;

    if (fromBlock > toBlock) {
      if (indexer.consecutiveErrors > 0) {
        indexer.recoveredFromErrorCount += 1;
        indexer.lastRecoveryAtMs = Date.now();
      }
      indexer.lastSuccessAtMs = Date.now();
      indexer.consecutiveErrors = 0;
      await new Promise((r) => setTimeout(r, indexer.pollIntervalMs));
      continue;
    }

    if (fromBlock <= toBlock) {
      indexer.lastRangeFromBlock = fromBlock;
      indexer.lastRangeToBlock = toBlock;
      indexer.totalLogFetches += 1;
      let logs;
      try {
        logs = await client.getLogs({
          address: itemsAddress,
          event: purchasedEvent,
          fromBlock,
          toBlock
        });
      } catch (e) {
        _markIndexerError(indexer, "logs", e);
        await _sleepBackoff(indexer);
        continue;
      }

      indexer.lastLogsCount = logs.length;
      indexer.totalLogs += logs.length;
      const newPurchases = [];
      for (const log of logs) {
        const key = `${log.transactionHash}:${log.logIndex}`;
        if (indexer.purchaseKeys.has(key)) continue;
        indexer.purchaseKeys.add(key);

        const p = _decodePurchasedLog({ chainId, log });
        indexer.purchases.push(p);
        newPurchases.push(p);

        if (indexer.purchases.length > indexer.maxRecords) {
          const removed = indexer.purchases.splice(0, indexer.purchases.length - indexer.maxRecords);
          for (const r of removed) indexer.purchaseKeys.delete(`${r.txHash}:${r.logIndex}`);
        }
      }

      indexer.lastIndexedBlock = toBlock;
      _trimPurchasesToWindow(indexer);

      // Atomically persist new purchases + last_block in one transaction
      if (indexer.persist.enabled) {
        _persistPurchaseBatch({ purchases: newPurchases, toBlock, chainId });
        indexer.persist.lastSavedAtMs = Date.now();
      }
      if (indexer.consecutiveErrors > 0) {
        indexer.recoveredFromErrorCount += 1;
        indexer.lastRecoveryAtMs = Date.now();
      }
      indexer.lastSuccessAtMs = Date.now();
      indexer.consecutiveErrors = 0;
    }

    await new Promise((r) => setTimeout(r, indexer.pollIntervalMs));
  }

  indexer.running = false;
}

function _markIndexerError(indexer, kind, e) {
  indexer.totalErrors += 1;
  indexer.consecutiveErrors += 1;
  indexer.lastErrorAtMs = Date.now();
  indexer.lastError = e instanceof Error ? e.message : String(e);
  indexer.lastErrorKind = kind;
}

function _backoffMs(indexer) {
  const max = Number(process.env.INDEXER_BACKOFF_MAX_MS ?? "15000");
  const base = Math.max(100, Number(indexer.pollIntervalMs));
  const pow = Math.min(6, Math.max(0, Number(indexer.consecutiveErrors)));
  const ms = base * Math.pow(2, pow);
  return Math.min(max, Math.max(base, Math.floor(ms)));
}
