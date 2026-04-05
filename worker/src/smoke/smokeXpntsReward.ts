// smokeXpntsReward.ts
// Smoke test: xpntsReward module initialises and no-ops gracefully when env vars are missing.

import assert from "node:assert/strict";

// Ensure env vars are NOT set so we test the graceful no-op path
delete process.env.XPNTS_ENABLED;
delete process.env.XPNTS_CONTRACT_ADDRESS;
delete process.env.XPNTS_REWARD_AMOUNT;
delete process.env.XPNTS_SIGNER_PRIVATE_KEY;

const { rewardBuyerXpnts } = await import("../xpntsReward.js");

// 1. Returns null when XPNTS_ENABLED is not set
const result1 = await rewardBuyerXpnts({
  buyer: "0x0000000000000000000000000000000000000001",
  purchaseId: "0xabc",
  quantity: "1",
  chain: { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } },
  rpcUrl: "http://127.0.0.1:8545"
});
assert.equal(result1, null, "should return null when XPNTS_ENABLED is not set");

// 2. Returns null when XPNTS_ENABLED=false
process.env.XPNTS_ENABLED = "false";
const result2 = await rewardBuyerXpnts({
  buyer: "0x0000000000000000000000000000000000000001",
  purchaseId: "0xdef",
  quantity: "1",
  chain: { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } },
  rpcUrl: "http://127.0.0.1:8545"
});
assert.equal(result2, null, "should return null when XPNTS_ENABLED=false");

// 3. Returns null when XPNTS_ENABLED=true but required vars are missing (warns, does not throw)
process.env.XPNTS_ENABLED = "true";
// deliberately leave CONTRACT_ADDRESS, REWARD_AMOUNT, SIGNER_KEY unset
const result3 = await rewardBuyerXpnts({
  buyer: "0x0000000000000000000000000000000000000001",
  purchaseId: "0x123",
  quantity: "1",
  chain: { id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } },
  rpcUrl: "http://127.0.0.1:8545"
});
assert.equal(result3, null, "should return null when required xPNTs env vars are missing");

console.log("smokeXpntsReward: all assertions passed");
