import { getDeploymentDefaults } from "./deployments.js";

export function loadConfig() {
  const deployment = import.meta.env.VITE_DEPLOYMENT ?? "";
  const defaults = getDeploymentDefaults(deployment);

  const raw = {
    rpcUrl: import.meta.env.VITE_RPC_URL ?? defaults.rpcUrl ?? "",
    chainId: import.meta.env.VITE_CHAIN_ID ?? (defaults.chainId != null ? String(defaults.chainId) : ""),
    itemsAddress: import.meta.env.VITE_ITEMS_ADDRESS ?? defaults.itemsAddress ?? "",
    shopsAddress: import.meta.env.VITE_SHOPS_ADDRESS ?? defaults.shopsAddress ?? "",
    workerUrl: import.meta.env.VITE_WORKER_URL ?? defaults.workerUrl ?? "",
    workerApiUrl: import.meta.env.VITE_WORKER_API_URL ?? defaults.workerApiUrl ?? "",
    apntsSaleUrl: import.meta.env.VITE_APNTS_SALE_URL ?? defaults.apntsSaleUrl ?? "",
    gtokenSaleUrl: import.meta.env.VITE_GTOKEN_SALE_URL ?? defaults.gtokenSaleUrl ?? "",
    itemsActionAddress: import.meta.env.VITE_ITEMS_ACTION_ADDRESS ?? defaults.itemsActionAddress ?? "",
    erc721ActionAddress: import.meta.env.VITE_ERC721_ACTION_ADDRESS ?? defaults.erc721ActionAddress ?? "",
    defaultTemplateId: import.meta.env.VITE_ERC721_DEFAULT_TEMPLATE_ID ?? defaults.defaultTemplateId ?? "",
    ipfsGateway: import.meta.env.VITE_IPFS_GATEWAY ?? defaults.ipfsGateway ?? "",
    disputeEscrowAddress: import.meta.env.VITE_DISPUTE_ESCROW_ADDRESS ?? "",
    disputeWindowSeconds: import.meta.env.VITE_DISPUTE_WINDOW_SECONDS ?? "604800",
    x402ActionAddress: import.meta.env.VITE_X402_ACTION_ADDRESS ?? "",
    // M7: AirAccount passkey + gasless config
    enableGasless: import.meta.env.VITE_ENABLE_GASLESS ?? "",
    airaccountFactory: import.meta.env.VITE_AIRACCOUNT_FACTORY ?? "0xa0007c5db27548d8c1582773856db1d123107383",
    bundlerUrl: import.meta.env.VITE_BUNDLER_URL ?? ""
  };

  const cfg = {
    rpcUrl: raw.rpcUrl ?? "",
    chainId: raw.chainId ? Number(raw.chainId) : 0,
    itemsAddress: raw.itemsAddress ?? "",
    shopsAddress: raw.shopsAddress ?? "",
    workerUrl: raw.workerUrl ?? "",
    workerApiUrl: raw.workerApiUrl ?? "",
    apntsSaleUrl: raw.apntsSaleUrl ?? "",
    gtokenSaleUrl: raw.gtokenSaleUrl ?? "",
    itemsActionAddress: raw.itemsActionAddress ?? "",
    erc721ActionAddress: raw.erc721ActionAddress ?? "",
    defaultTemplateId: raw.defaultTemplateId ?? "",
    ipfsGateway: raw.ipfsGateway ?? "",
    disputeEscrowAddress: raw.disputeEscrowAddress ?? "",
    disputeWindowSeconds: raw.disputeWindowSeconds ? Number(raw.disputeWindowSeconds) : 604800,
    x402ActionAddress: raw.x402ActionAddress ?? "",
    // M7: AirAccount passkey + gasless config
    enableGasless: raw.enableGasless === "1" || raw.enableGasless === "true",
    airaccountFactory: raw.airaccountFactory ?? "0xa0007c5db27548d8c1582773856db1d123107383",
    bundlerUrl: raw.bundlerUrl ?? ""
  };

  return cfg;
}
