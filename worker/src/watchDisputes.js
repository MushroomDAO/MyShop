import { getAddress, parseAbiItem } from "viem";
import { http, createPublicClient } from "viem";

import { openDb } from "./db.js";
import { log } from "./logger.js";

const disputeOpenedEvent = parseAbiItem(
  "event DisputeOpened(bytes32 indexed purchaseId,address indexed buyer,address payToken,uint256 amount)"
);
const disputeResolvedEvent = parseAbiItem(
  "event DisputeResolved(bytes32 indexed purchaseId,address indexed winner,bool buyerWon)"
);
const disputeCancelledEvent = parseAbiItem(
  "event DisputeCancelled(bytes32 indexed purchaseId)"
);

export async function watchDisputes({
  rpcUrl,
  chain,
  escrowAddress,
  pollIntervalMs,
  lookbackBlocks
}) {
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl)
  });

  const address = getAddress(escrowAddress);

  let lastBlock = await client.getBlockNumber();
  if (lastBlock > BigInt(lookbackBlocks)) lastBlock -= BigInt(lookbackBlocks);

  log.info("watchDisputes started", { address, fromBlock: lastBlock.toString() });

  for (;;) {
    const latest = await client.getBlockNumber();
    if (latest >= lastBlock) {
      const fromBlock = lastBlock;
      const toBlock = latest;

      try {
        const [openedLogs, resolvedLogs, cancelledLogs] = await Promise.all([
          client.getLogs({ address, event: disputeOpenedEvent, fromBlock, toBlock }),
          client.getLogs({ address, event: disputeResolvedEvent, fromBlock, toBlock }),
          client.getLogs({ address, event: disputeCancelledEvent, fromBlock, toBlock })
        ]);

        const db = openDb();
        const upsertOpen = db.prepare(`
          INSERT INTO disputes (purchase_id, buyer, pay_token, amount, status, opened_at, tx_hash)
          VALUES (?, ?, ?, ?, 'open', ?, ?)
          ON CONFLICT(purchase_id) DO UPDATE SET
            buyer=excluded.buyer,
            pay_token=excluded.pay_token,
            amount=excluded.amount,
            status='open',
            opened_at=excluded.opened_at,
            tx_hash=excluded.tx_hash
        `);
        const updateResolved = db.prepare(`
          UPDATE disputes SET status=?, resolved_at=? WHERE purchase_id=?
        `);
        const updateCancelled = db.prepare(`
          UPDATE disputes SET status='cancelled', resolved_at=? WHERE purchase_id=?
        `);

        const now = Math.floor(Date.now() / 1000);

        for (const logEntry of openedLogs) {
          const purchaseId = logEntry.topics[1];
          const buyer = getAddress(`0x${logEntry.topics[2].slice(26)}`);
          // Decode non-indexed fields from data
          const data = logEntry.data;
          // payToken is address (32 bytes padded), amount is uint256 (32 bytes)
          const payToken = getAddress(`0x${data.slice(26, 66)}`);
          const amount = BigInt(`0x${data.slice(66, 130)}`).toString();
          const txHash = logEntry.transactionHash;

          upsertOpen.run(purchaseId, buyer, payToken, amount, now, txHash);
          log.info("dispute opened", { purchaseId, buyer, payToken, amount });
        }

        for (const logEntry of resolvedLogs) {
          const purchaseId = logEntry.topics[1];
          // buyerWon is bool in data (last 32 bytes, last byte is 0x00 or 0x01)
          const buyerWon = logEntry.data.slice(-1) === "1";
          const status = buyerWon ? "resolved_buyer" : "resolved_shop";
          updateResolved.run(status, now, purchaseId);
          log.info("dispute resolved", { purchaseId, status });
        }

        for (const logEntry of cancelledLogs) {
          const purchaseId = logEntry.topics[1];
          updateCancelled.run(now, purchaseId);
          log.info("dispute cancelled", { purchaseId });
        }
      } catch (err) {
        log.error("watchDisputes poll error", { error: String(err) });
      }
    }

    lastBlock = latest + 1n;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
