import { decodeEventLog, getAddress, parseAbiItem } from "viem";
import { http, createPublicClient } from "viem";

import { myShopItemsAbi, myShopsAbi } from "./abi.js";
import { enqueueWebhook } from "./webhookQueue.js";

const purchasedEvent = parseAbiItem(
  "event Purchased(uint256 indexed itemId,uint256 indexed shopId,address indexed buyer,address recipient,uint256 quantity,address payToken,uint256 payAmount,uint256 platformFeeAmount,bytes32 serialHash,uint256 firstTokenId)"
);

export async function watchPurchased({
  rpcUrl,
  chain,
  itemsAddress,
  pollIntervalMs,
  lookbackBlocks,
  webhookUrl,
  telegram
}) {
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl)
  });

  const address = getAddress(itemsAddress);
  let cachedShopsAddress = null;

  let lastBlock = await client.getBlockNumber();
  if (lastBlock > BigInt(lookbackBlocks)) lastBlock -= BigInt(lookbackBlocks);

  for (;;) {
    const latest = await client.getBlockNumber();
    if (latest >= lastBlock) {
      const fromBlock = lastBlock;
      const toBlock = latest;
      const logs = await client.getLogs({
        address,
        event: purchasedEvent,
        fromBlock,
        toBlock
      });

      for (const log of logs) {
        const decoded = decodeEventLog({
          abi: myShopItemsAbi,
          data: log.data,
          topics: log.topics
        });

        // W9: detect gasless (ERC-4337 / Paymaster) purchases.
        // In a standard EOA tx, tx.from == the buyer (msg.sender in the contract).
        // In an AA UserOp submitted via EntryPoint/Paymaster, tx.from is the
        // bundler/relayer address, which differs from the buyer recorded in the event.
        // We fetch the transaction to compare tx.from with the on-chain buyer.
        let gasless = false;
        try {
          if (log.transactionHash) {
            const tx = await client.getTransaction({ hash: log.transactionHash });
            // tx.from is the EOA that submitted the transaction (bundler in AA flow).
            // decoded.args.buyer is the msg.sender recorded by the contract.
            // If they differ, the tx was submitted by a third party (bundler / paymaster).
            if (tx && tx.from && decoded.args.buyer) {
              gasless = tx.from.toLowerCase() !== decoded.args.buyer.toLowerCase();
            }
          }
        } catch {
          // non-fatal: gasless detection is best-effort
        }

        const payload = {
          chainId: chain.id,
          txHash: log.transactionHash,
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
          firstTokenId: decoded.args.firstTokenId?.toString(),
          gasless
        };

        const enriched = await enrichPurchased({
          client,
          itemsAddress: address,
          shopId: decoded.args.shopId,
          itemId: decoded.args.itemId,
          cachedShopsAddress
        });
        cachedShopsAddress = enriched.cachedShopsAddress;

        const fullPayload = {
          ...payload,
          item: enriched.item,
          shop: enriched.shop
        };

        if (webhookUrl) {
          enqueueWebhook(webhookUrl, fullPayload);
        }

        if (telegram) {
          await _sendTelegram(telegram, fullPayload);
        }

        if (!webhookUrl && !telegram) {
          process.stdout.write(
            JSON.stringify(fullPayload, null, 2) + "\n"
          );
        }
      }
    }

    lastBlock = latest + 1n;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

async function _sendTelegram(telegram, payload) {
  const text =
    `MyShop Purchased\n` +
    `chainId: ${payload.chainId}\n` +
    `tx: ${payload.txHash}\n` +
    `itemId: ${payload.itemId}\n` +
    `shopId: ${payload.shopId}\n` +
    `buyer: ${payload.buyer}\n` +
    `recipient: ${payload.recipient}\n` +
    `quantity: ${payload.quantity}\n` +
    `payToken: ${payload.payToken}\n` +
    `payAmount: ${payload.payAmount}\n` +
    `platformFeeAmount: ${payload.platformFeeAmount}\n` +
    `serialHash: ${payload.serialHash}\n` +
    `firstTokenId: ${payload.firstTokenId}\n` +
    `gasless: ${payload.gasless ?? false}\n` +
    `shopTreasury: ${payload.shop?.treasury ?? ""}\n` +
    `nft: ${payload.item?.nftContract ?? ""}\n` +
    `tokenURI: ${payload.item?.tokenURI ?? ""}\n` +
    `action: ${payload.item?.action ?? ""}\n`;

  const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: telegram.chatId,
      text
    })
  });
}

async function enrichPurchased({ client, itemsAddress, shopId, itemId, cachedShopsAddress }) {
  const rawItem = await client.readContract({
    address: itemsAddress,
    abi: myShopItemsAbi,
    functionName: "items",
    args: [itemId]
  });

  const shopsAddress =
    cachedShopsAddress ??
    getAddress(
      await client.readContract({
        address: itemsAddress,
        abi: myShopItemsAbi,
        functionName: "shops",
        args: []
      })
    );

  const rawShop = await client.readContract({
    address: shopsAddress,
    abi: myShopsAbi,
    functionName: "shops",
    args: [shopId]
  });

  return {
    cachedShopsAddress: shopsAddress,
    item: {
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
    },
    shop: {
      owner: pick(rawShop, "owner", 0),
      treasury: pick(rawShop, "treasury", 1),
      metadataHash: pick(rawShop, "metadataHash", 2),
      paused: pick(rawShop, "paused", 3)
    }
  };
}

function pick(obj, key, index) {
  const value = obj?.[key] ?? obj?.[index];
  if (value === undefined) throw new Error(`Unable to read ${key}`);
  return value;
}
