// xpntsReward.js
// Mints/transfers xPNTs to buyer after successful purchase.
// XPNTS_ENABLED env var gates this feature.

import { createWalletClient, createPublicClient, http, parseAbi, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const XPNTS_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)"
]);

/**
 * Reward a buyer with xPNTs after a successful purchase.
 * Non-blocking — logs errors but never throws.
 *
 * @param {object} opts
 * @param {string} opts.buyer         - buyer address (checksummed)
 * @param {string} opts.purchaseId    - txHash or log id (for logging)
 * @param {string|number|bigint} opts.quantity - purchase quantity (informational)
 * @param {object} opts.chain         - viem chain object
 * @param {string} opts.rpcUrl        - RPC URL string
 * @returns {Promise<{txHash: string, amount: bigint, buyer: string}|null>}
 */
export async function rewardBuyerXpnts({ buyer, purchaseId, quantity, chain, rpcUrl }) {
  if (!process.env.XPNTS_ENABLED || process.env.XPNTS_ENABLED !== "true") {
    return null;
  }

  const contractAddress = process.env.XPNTS_CONTRACT_ADDRESS;
  const rewardAmountRaw = process.env.XPNTS_REWARD_AMOUNT;
  const signerKey = process.env.XPNTS_SIGNER_PRIVATE_KEY;

  if (!contractAddress || !rewardAmountRaw || !signerKey) {
    console.warn("[xpntsReward] XPNTS_ENABLED=true but missing XPNTS_CONTRACT_ADDRESS, XPNTS_REWARD_AMOUNT or XPNTS_SIGNER_PRIVATE_KEY — skipping");
    return null;
  }

  let xpntsAddress;
  try {
    xpntsAddress = getAddress(contractAddress);
  } catch {
    console.error(`[xpntsReward] Invalid XPNTS_CONTRACT_ADDRESS: ${contractAddress}`);
    return null;
  }

  let buyerAddress;
  try {
    buyerAddress = getAddress(buyer);
  } catch {
    console.error(`[xpntsReward] Invalid buyer address: ${buyer}`);
    return null;
  }

  const amount = BigInt(rewardAmountRaw);

  try {
    const account = privateKeyToAccount(signerKey);
    const transport = http(rpcUrl || "http://127.0.0.1:8545");

    const walletClient = createWalletClient({
      chain,
      transport,
      account
    });

    // Try mint first; fall back to transfer if mint reverts
    let txHash;
    try {
      txHash = await walletClient.writeContract({
        address: xpntsAddress,
        abi: XPNTS_ABI,
        functionName: "mint",
        args: [buyerAddress, amount]
      });
    } catch (mintErr) {
      console.warn(`[xpntsReward] mint failed (purchaseId=${purchaseId}), trying transfer: ${mintErr?.message ?? mintErr}`);
      try {
        txHash = await walletClient.writeContract({
          address: xpntsAddress,
          abi: XPNTS_ABI,
          functionName: "transfer",
          args: [buyerAddress, amount]
        });
      } catch (transferErr) {
        console.error(`[xpntsReward] transfer also failed (purchaseId=${purchaseId}): ${transferErr?.message ?? transferErr}`);
        return null;
      }
    }

    console.log(`[xpntsReward] rewarded buyer=${buyerAddress} amount=${amount.toString()} txHash=${txHash} purchaseId=${purchaseId}`);
    return { txHash, amount, buyer: buyerAddress };
  } catch (e) {
    console.error(`[xpntsReward] unexpected error (purchaseId=${purchaseId}): ${e?.message ?? e}`);
    return null;
  }
}
