# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MyShop is a minimal on-chain e-commerce/ticketing/NFT system: "链上协议 + 轻服务" (On-chain Protocol + Light Services). It consists of three independent subprojects:

- **`contracts/`** — Foundry-based Solidity contracts (shop registry, item purchase, action modules)
- **`frontend/`** — Vite + vanilla JS SPA (no framework), interacts with contracts via viem
- **`worker/`** — Node.js service (JS with some TS tooling) providing EIP-712 signing, a query API, and event watching

## Commands

### Contracts (Foundry)
```bash
cd contracts
forge build
forge test
./build-test-contracts.sh    # build + test from root
```

### Frontend
```bash
cd frontend
pnpm install
cp .env.example .env         # fill in contract addresses
pnpm dev                     # dev server on port 5173
pnpm check                   # validate JS syntax
pnpm lint
pnpm test:e2e                # Playwright E2E tests
pnpm regression              # check + build + test:e2e
```

### Worker
```bash
cd worker
pnpm install
cp .env.example .env         # fill in addresses + signing keys
pnpm dev                     # starts worker (node src/index.js)
pnpm smoke:all               # smoke tests (tsx)
pnpm regression:worker       # check + smoke
```

### Full Regression
```bash
./flow-test.sh               # starts anvil, deploys, runs worker + frontend regression
RUN_E2E=1 ./flow-test.sh     # include Playwright E2E
```

## Architecture

### On-Chain Protocol
Two core contracts:
- **`MyShops.sol`** — shop registry; requires `ROLE_COMMUNITY` from an external AAStar Registry
- **`MyShopItems.sol`** — atomic purchase entry point; `buy()` verifies EIP-712 permit → splits fees → mints NFT → executes action in one tx

Items have a composable **action** field pointing to a whitelisted contract (`actions/`). Currently: `MintERC20Action`, `MintERC721Action`, `EmitEventAction`. New actions require governance whitelisting.

### Worker Services (ports 8787 / 8788)
Three roles, started via `MODE=watch|permit|both`:
1. **permitServer** (8787) — signs `SerialPermit` and `RiskAllowance` EIP-712 structs; optionally delegates serial generation to `SERIAL_ISSUER_URL`
2. **apiServer** (8788) — `/shops`, `/items`, `/purchases` query API with an in-memory indexer and automatic fallback to chain queries
3. **watchPurchased** — polls `Purchased` events and fans out to webhook and/or Telegram

### Frontend
Single-page app with hash-based routing (`#/plaza`, `#/buyer`, `#/shop-console`, `#/protocol-console`, `#/risk`, `#/config`). All logic lives in `frontend/src/main.js` (large file). Contract ABIs are in `contracts.js`. Runtime configuration (RPC URL, contract addresses) is persisted to `localStorage` and editable at `#/config`.

### Key Data Flow
```
Buyer → frontend → worker /serial-permit → signed EIP-712 SerialPermit
Frontend → MyShopItems.buy(permit, extraData)
Contract → fee split → NFT mint → action execution → Purchased event
Worker watchPurchased → enrich → webhook / Telegram
Frontend (#/plaza) → worker /shops /items (indexed, fast)
```

### EIP-712 Permit System
- `SerialPermit` — gates purchase by requiring a worker-signed serial; prevents double-spend via on-chain nonce
- `RiskAllowance` — allows a shop to exceed default per-buyer item limits; also nonce-protected
- Both use domain-separated EIP-712 with `CHAIN_ID` and contract address

### Environment Variables
| Variable | Where | Purpose |
|---|---|---|
| `VITE_SHOPS_ADDRESS` / `VITE_ITEMS_ADDRESS` | frontend | Contract addresses |
| `VITE_RPC_URL` / `VITE_CHAIN_ID` | frontend | Chain connection |
| `VITE_WORKER_URL` | frontend | Permit server (8787) |
| `VITE_WORKER_API_URL` | frontend | Query API (8788) |
| `SERIAL_SIGNER_PRIVATE_KEY` | worker | Signs SerialPermit |
| `RISK_SIGNER_PRIVATE_KEY` | worker | Signs RiskAllowance |
| `SERIAL_ISSUER_URL` | worker | Optional external serial generator |
| `ENABLE_API` / `API_PORT` | worker | Toggle query API |

### Test Infrastructure
- Contract tests: Foundry (`contracts/test/`)
- Worker tests: tsx-based smoke tests (`worker/src/smoke/`)
- Frontend E2E: Playwright (`frontend/e2e/`)
- Regression state output to `demo/` (addresses, logs, indexer state)

## Key Docs
- `Solution.md` — system design, boundary definitions, layered architecture (L0–L3)
- `docs/architecture.md` — module boundaries, data flows, event-as-items pattern
- `docs/worker.md` — permit API security, serial issuer integration
- `docs/test_cases.md` — executable test cases by role (Protocol / Shop / Buyer)
- `docs/milestones.md` — Phase A/B/C acceptance criteria
