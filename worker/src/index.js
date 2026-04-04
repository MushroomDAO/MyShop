import { getAddress } from "viem";
import fs from "node:fs";

import { optionalEnv, requireEnv } from "./env.js";
import { log } from "./logger.js";
import { getDeploymentDefaults } from "../../frontend/src/deployments.js";
import { startApiServer } from "./apiServer.js";
import { startPermitServer } from "./permitServer.js";
import { watchPurchased } from "./watchPurchased.js";

const mode = optionalEnv("MODE", "both");

const deployment = optionalEnv("DEPLOYMENT", "");
const defaults = getDeploymentDefaults(deployment);

const rpcUrl = optionalEnv("RPC_URL", defaults.rpcUrl ?? "");
if (!rpcUrl) throw new Error("Missing env: RPC_URL (or set DEPLOYMENT)");

const chainIdRaw = optionalEnv("CHAIN_ID", defaults.chainId != null ? String(defaults.chainId) : "");
if (!chainIdRaw) throw new Error("Missing env: CHAIN_ID (or set DEPLOYMENT)");
const chainId = Number(chainIdRaw);

const itemsAddressRaw = optionalEnv("ITEMS_ADDRESS", defaults.itemsAddress ?? "");
if (!itemsAddressRaw) throw new Error("Missing env: ITEMS_ADDRESS (or set DEPLOYMENT)");
const itemsAddress = getAddress(itemsAddressRaw);

const chain = {
  id: chainId,
  name: optionalEnv("CHAIN_NAME", defaults.chainId === 31337 ? "anvil" : "custom"),
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } }
};

const webhookUrl = optionalEnv("WEBHOOK_URL", "");
const telegramBotToken = optionalEnv("TELEGRAM_BOT_TOKEN", "");
const telegramChatId = optionalEnv("TELEGRAM_CHAT_ID", "");
const pollIntervalMs = Number(optionalEnv("POLL_INTERVAL_MS", "4000"));
const lookbackBlocks = Number(optionalEnv("LOOKBACK_BLOCKS", "50"));

const serialSignerPrivateKey = _readSecret({
  value: optionalEnv("SERIAL_SIGNER_PRIVATE_KEY", ""),
  filePath: optionalEnv("SERIAL_SIGNER_PRIVATE_KEY_FILE", "")
});
const riskSignerPrivateKey = _readSecret({
  value: optionalEnv("RISK_SIGNER_PRIVATE_KEY", ""),
  filePath: optionalEnv("RISK_SIGNER_PRIVATE_KEY_FILE", "")
});
const serialIssuerUrl = optionalEnv("SERIAL_ISSUER_URL", "");
const port = Number(optionalEnv("PORT", "8787"));
const enableApi = optionalEnv("ENABLE_API", "0") === "1";
const apiPort = Number(optionalEnv("API_PORT", "8788"));

if (mode === "watch" || mode === "both") {
  watchPurchased({
    rpcUrl,
    chain,
    itemsAddress,
    pollIntervalMs,
    lookbackBlocks,
    webhookUrl: webhookUrl || null,
    telegram:
      telegramBotToken && telegramChatId
        ? {
            botToken: telegramBotToken,
            chatId: telegramChatId
          }
        : null
  }).catch((e) => {
    log.error("watchPurchased fatal", { error: String(e) });
    process.exit(1);
  });
}

if (mode === "permit" || mode === "both") {
  startPermitServer({
    rpcUrl,
    chain,
    itemsAddress,
    serialSignerPrivateKey: serialSignerPrivateKey ? normalizePrivateKey(serialSignerPrivateKey) : null,
    riskSignerPrivateKey: riskSignerPrivateKey ? normalizePrivateKey(riskSignerPrivateKey) : null,
    serialIssuerUrl: serialIssuerUrl || null,
    port
  })
    .then(({ port: actualPort }) => {
      log.info("permit server started", { port: actualPort });
    })
    .catch((e) => {
      log.error("permit server fatal", { error: String(e) });
      process.exit(1);
    });
}

if (enableApi) {
  startApiServer({
    rpcUrl,
    chain,
    itemsAddress,
    port: apiPort
  })
    .then(({ port: actualPort }) => {
      log.info("api server started", { port: actualPort });
    })
    .catch((e) => {
      log.error("api server fatal", { error: String(e) });
      process.exit(1);
    });
}

if (!["watch", "permit", "both"].includes(mode)) {
  throw new Error("MODE must be watch|permit|both");
}

function normalizePrivateKey(value) {
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Invalid private key format");
  return hex;
}

function _readSecret({ value, filePath }) {
  if (value) return value;
  if (!filePath) return "";
  return fs.readFileSync(filePath, "utf8").trim();
}
