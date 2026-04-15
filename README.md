# MyShop

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
一个“链上协议 + 轻服务”的最小可用电商/门票/权益售卖系统：

- **On-chain**：`MyShops`（店铺注册与协议配置）+ `MyShopItems`（上架与原子购买 `buy()`）
- **Worker**：Purchased 监听、Permit 签名 API（SerialPermit / RiskAllowance）、Query API（shops/items/purchases + 内存索引）
- **Frontend**：广场 / aPNTs& GToken 购买页 / 风控评估 / 买家入口 / 店主后台 / 协议后台 + 诊断页

常用入口：

- 里程碑与任务：[docs/milestones.md](docs/milestones.md)
- 可执行用例清单：[docs/test_cases.md](docs/test_cases.md)
- Worker 使用说明（含 /metrics 与 /indexer）：[docs/worker.md](docs/worker.md)

## 系统架构图

```mermaid
flowchart LR
  subgraph Offchain["Off-chain"]
    UI["前端 / 脚本 / 第三方应用"]
    RiskSvc["风控签名服务<br/>(RiskAllowance)"]
    SerialSvc["串号签发/校验服务<br/>(SerialPermit)"]
    Worker["MyShop Worker<br/>- Purchased 监听<br/>- Permit 签名 API<br/>- Webhook/Telegram 通知"]
    Webhook["业务后端 Webhook"]
    Tg["Telegram"]
  end

  subgraph Onchain["On-chain (EVM)"]
    Registry["Registry<br/>(ROLE_COMMUNITY)"]
    Shops["MyShops<br/>- 注册 Shop<br/>- 协议费率/上架费"]
    Items["MyShopItems<br/>- 上架 Item<br/>- 原子购买 buy()"]
    NFT["CommunityNFT/MockCommunityNFT<br/>mint(to, uri, soulbound)"]
    Action["Action 合约<br/>(可组合能力)"]
    PayToken["ERC20 / ETH"]
  end

  UI -->|"registerShop / addItem / buy"| Onchain
  Registry --> Shops
  Shops --> Items
  Items -->|"mint"| NFT
  Items -->|"execute"| Action
  UI -->|"请求签名"| RiskSvc
  UI -->|"请求串号+签名"| SerialSvc
  Worker -->|"监听 Purchased"| Items
  Worker --> Webhook
  Worker --> Tg
  UI -->|"可选: 直接调 Worker 的 Permit API"| Worker
  PayToken --> Items
```

## 分模块架构图（合约）

```mermaid
flowchart TB
  subgraph Contracts["contracts/src"]
    Shops["MyShops"]
    Items["MyShopItems"]
    SaleA["sales/APNTsSale"]
    SaleG["sales/GTokenSale"]
    ActMint["actions/MintERC20Action"]
    ActEvent["actions/EmitEventAction"]
    MRegistry["mocks/MockRegistry"]
    MToken["mocks/MockERC20Mintable"]
    MNFT["mocks/MockCommunityNFT"]
  end

  Shops -->|"依赖 registry.hasRole"| MRegistry
  Items -->|"读取 Shop 配置"| Shops
  Items -->|"协议费/收款"| MToken
  Items -->|"mint NFT"| MNFT
  Items -->|"action 白名单 + execute"| ActMint
  Items -->|"action 白名单 + execute"| ActEvent
  SaleA --> MToken
  SaleG --> MToken
```

## 流转关系（关键流程）

### 1) 上架 addItem：默认风控 + 可选风险签名放宽上限

```mermaid
sequenceDiagram
  participant ShopOwner as Shop Owner
  participant Risk as Risk Signer
  participant Items as MyShopItems
  participant Shops as MyShops
  participant APNTs as aPNTs(ERC20)
  participant Treasury as Protocol Treasury

  Note over ShopOwner,Items: 如果该 shop item 数超过默认阈值，需要 RiskAllowance 签名
  ShopOwner->>Risk: 请求 RiskAllowance(shopOwner,maxItems,deadline,nonce)
  Risk-->>ShopOwner: signature
  ShopOwner->>APNTs: approve(MyShopItems, listingFee)
  ShopOwner->>Items: addItem(params + signature?)
  Items->>Shops: 读取协议费率/上架费配置
  Items->>APNTs: transferFrom(shopOwner, Treasury, listingFee)
  Items-->>ShopOwner: itemId
```

### 2) 购买 buy：串号签名（Mode A）+ 原子收款/分润/NFT/Action

```mermaid
sequenceDiagram
  participant Buyer as Buyer
  participant Serial as Serial Signer
  participant Items as MyShopItems
  participant Shops as MyShops
  participant Pay as PayToken(ERC20/ETH)
  participant ShopTreasury as Shop Treasury
  participant Treasury as Protocol Treasury
  participant NFT as CommunityNFT
  participant Action as Action Contract

  Note over Buyer,Serial: requiresSerial=true 时必须提供 SerialPermit
  Buyer->>Serial: 请求 SerialPermit(itemId,buyer,serialHash,deadline,nonce)
  Serial-->>Buyer: signature
  Buyer->>Pay: approve(MyShopItems, amount)
  Buyer->>Items: buy(itemId,qty,recipient, extraData(serialHash,deadline,nonce,signature))
  Items->>Items: 校验 SerialPermit + nonce 未使用
  Items->>Shops: 读取 feeBps / treasury
  Items->>Pay: transferFrom(buyer, Treasury, protocolFee)
  Items->>Pay: transferFrom(buyer, ShopTreasury, netAmount)
  Items->>NFT: mint(recipient, tokenURI, soulbound)
  Items->>Action: execute(buyer,recipient,itemId,shopId,qty,actionData,extraData)
  Items-->>Buyer: firstTokenId
```

## 文档

- 架构与流程说明：[docs/architecture.md](docs/architecture.md)
- 五步走规划与进度：[Solution.md](Solution.md)
- 里程碑与任务（从 Demo 到可上线）：[docs/milestones.md](docs/milestones.md)
- 可执行测试用例清单（E2E）：[docs/test_cases.md](docs/test_cases.md)
- Shop 管理模块设计：[docs/shop_management.md](docs/shop_management.md)
- Worker（监听/签名/通知）使用说明：[docs/worker.md](docs/worker.md)
- 本地一键演示：[docs/demo_local.md](docs/demo_local.md)
- 前端最小闭环：[frontend/README.md](frontend/README.md)
- Worker 快速说明：[worker/README.md](worker/README.md)
- 合约开发（Foundry）：[contracts/README.md](contracts/README.md)
- Demo 脚本入口：[scripts/demo_local.sh](scripts/demo_local.sh)
- Reference（对齐用）：[reference/](reference/)

## IPFS 网关与 Pin 服务（去中心化）

- 目标：为 `ipfs://...` 内容提供长期稳定的访问；多方共同维护副本与带宽
- 架构建议：
  - 多节点网关：运行 `go-ipfs` 开启 HTTP Gateway，前置 Nginx/HAProxy 做健康检查与负载
  - Pin 编排：使用 IPFS Cluster，设置副本数（≥2），平台/社区/店主各自运行 peer
  - 监控与审计：Prometheus+Grafana 监控节点与响应；定期校验关键 CID 的可达性与哈希一致性
- 项目集成：
  - 前端运行时配置：`VITE_IPFS_GATEWAY` 指定自定义网关域名
  - 类别元数据：在 `/categories` 中维护 `docsIpfs/readmeIpfs/architectureIpfs/templateIpfs`
  - 验收：店主后台“查看文档”按钮会使用配置的网关打开 IPFS 链接
 - 运行指南：详见 [docs/architecture.md](docs/architecture.md) 的“网关与节点运行（参考方案）”
- 独立设计文档：[docs/ipfs-gateway.md](docs/ipfs-gateway.md)

## ENS 集成（社区与店铺）

- 命名策略：平台基域（例如 `aastar.eth`）下为社区与店铺分配子域
- 解析策略：resolver `contenthash` 指向 IPFS 页面；可额外记录 `text` 字段（shopId/workerUrl 等）
- 前端嵌入：展示并可跳转 ENS 名称；解析 `contenthash` 打开 IPFS 页面
- 详细设计：见 [docs/Solution.md](docs/Solution.md) 的“ENS 设计与嵌入”
- 独立设计文档：[docs/ens.md](docs/ens.md)
 - 可选性：不配置 ENS 时，使用常规域名与路径，原有流程照常运行

## 快速上手（按角色）

- 协议运营方（治理者）：[角色路径与期望](file:///Users/jason/Dev/crypto-projects/MyShop/docs/ACCEPTANCE.md#L95-L99)
- 店铺运营者（Shop Owner/Operator）：[角色路径与期望](file:///Users/jason/Dev/crypto-projects/MyShop/docs/ACCEPTANCE.md#L100-L104)
- 买家（Buyer）：[角色路径与期望](file:///Users/jason/Dev/crypto-projects/MyShop/docs/ACCEPTANCE.md#L105-L109)
- 运维/社区节点（IPFS，选配）：部署与验证见 [docs/ipfs-gateway.md](file:///Users/jason/Dev/crypto-projects/MyShop/docs/ipfs-gateway.md)、[docs/architecture.md](file:///Users/jason/Dev/crypto-projects/MyShop/docs/architecture.md)
- 全量可执行用例与命令模板：见 [docs/test_cases.md](file:///Users/jason/Dev/crypto-projects/MyShop/docs/test_cases.md)
## 回归与测试（统一入口）

```bash
# 合约 build + test
./build-test-contracts.sh

# Worker 冒烟（不含前端）
./smoke.sh

# 本地一键回归（含前端 E2E）
./flow-test.sh
```

## 完整本地回归与分模块测试

### 快速跑完整本地回归

```bash
./flow-test.sh
```

等价于：

```bash
RUN_E2E=1 bash scripts/regression_local.sh
```

仅跑后端回归（不跑前端 E2E）：

```bash
bash scripts/regression_local.sh
```

### 回归脚本参数与上下文

`scripts/regression_local.sh` 会自动完成以下步骤：

- 启动 anvil
- 部署 demo 合约与基础数据
- 启动 worker（permit + api + watch）
- 运行成功与失败用例（串号购买、nonce 重放、deadline 过期、权限不足、暂停/下架）
- 可选运行前端 E2E（当 `RUN_E2E=1`）

脚本依赖工具：

- anvil / forge / cast / node / pnpm / nc / curl

常用参数与环境变量：

- `ANVIL_PORT`：anvil 起始端口，脚本会自动找可用端口
- `WORKER_PORT` / `API_PORT`：worker 与 api 起始端口，脚本会自动找可用端口
- `DEPLOYER_PK` / `BUYER_PK`：演示部署与购买账户私钥
- `RISK_SIGNER_PK` / `SERIAL_SIGNER_PK`：Risk/Serial 签名账户私钥
- `RUN_E2E=1`：启用前端 E2E

前端 E2E 会自动注入的上下文变量：

- `RPC_URL` / `CHAIN_ID`
- `ITEMS_ADDRESS` / `SHOPS_ADDRESS`
- `WORKER_URL` / `WORKER_API_URL`
- `ITEM_ID`

回归输出位置：

- `demo/demo.json`：部署与测试上下文
- `demo/worker.log`：worker 运行日志
- `demo/indexer_state.json`：indexer 持久化状态

### 分模块测试命令

合约（Foundry）：

```bash
./build-test-contracts.sh
```

Worker：

```bash
pnpm -C worker check
pnpm -C worker test
pnpm -C worker regression:worker
```

Frontend：

```bash
pnpm -C frontend check
pnpm -C frontend typecheck
pnpm -C frontend build
pnpm -C frontend test:e2e
pnpm -C frontend regression
```

## 功能列表（feat）

- **Shop**
  - 社区注册 Shop（依赖 `Registry.hasRole(ROLE_COMMUNITY)`）
  - Shop 更新与暂停（owner/协议治理权限）
- **Item（上架/管理）**
  - ShopOwner 上架商品（listing fee 可配置）
  - 默认风控：单店默认最多 5 个 item；可用 `RiskAllowance` 签名放宽上限
  - Item 上下架（active 开关）
  - Action 白名单：协议治理者 允许/禁止可执行的 action 合约
- **购买（原子闭环）**
  - `buy()` 原子完成：收款 + 协议费分润 + mint NFT + execute action
  - 可选串号校验：`requiresSerial=true` 时必须提供 `SerialPermit`（EIP-712 + nonce + deadline）
- **售卖合约（独立模块）**
  - aPNTsSale / GTokenSale：支持 cap/limits、可暂停、事件上报
- **Off-chain Worker**
  - Purchased 事件监听与 payload enrich（补充 item/shop 链上信息）
  - Webhook 转发（可选）与 Telegram 通知（可选）
  - Permit 服务：`/serial-permit` 与 `/risk-allowance`
  - Query API：`/shops` `/items` `/purchases` + 内存索引（可配置 `source=index|chain`）

### Worker 三大功能（带全流程示例）

Worker 的主要作用可以归成 3 类（对应你现在这套“链上协议 + 轻服务”架构）：

- 购买事件监听与通知（Watcher）：持续监听 Purchased 等链上事件，把原始 event 补全成可读 payload（例如解析 item/shop、金额、serialHash 等），然后按需触发 Webhook/Telegram，方便“成交通知/落库/后续发货或权益发放”。
- 签名/Permit 服务（Permit Server）：为链上可验证的 off-chain 逻辑提供 EIP-712 签名（例如 SerialPermit、RiskAllowance），把“串号发放/风控放行”等逻辑从合约里抽出来，但仍保持链上校验与可追溯。
- 查询 API + 轻索引（Query API/Indexer）：提供 /shops /items /purchases 这类聚合读取接口；可用内存索引加速查询，同时保留链上读取回退路径，给前端/SDK 一个稳定的数据入口。

1. Purchased 监听（watch）

- 目标：持续监听 `MyShopItems.Purchased` 事件，并把链上基础字段 + enrich 后的 shop/item 一起输出到 stdout / Webhook / Telegram。
- 代码入口：[watchPurchased.js](./worker/src/watchPurchased.js)

示例输出（关键字段）：

```json
{
  "chainId": 31337,
  "txHash": "0x...",
  "blockNumber": 123,
  "itemId": "1",
  "shopId": "1",
  "buyer": "0x...",
  "recipient": "0x...",
  "quantity": "1",
  "payToken": "0x...",
  "payAmount": "1000",
  "platformFeeAmount": "30",
  "serialHash": "0x...",
  "firstTokenId": "1",
  "item": {
    "tokenURI": "ipfs://...",
    "action": "0x...",
    "requiresSerial": true,
    "active": true
  },
  "shop": { "owner": "0x...", "treasury": "0x...", "paused": false }
}
```

2. Permit 签名 API（permit）

- 目标：给前端/第三方应用提供 EIP-712 签名，链上可验证，避免在前端持有签名私钥。
- 代码入口：[permitServer.js](./worker/src/permitServer.js)

串号签名（SerialPermit → extraData，供 `buy()` 直接传入）：

```bash
curl "http://localhost:8787/serial-permit?buyer=0xBuyer&itemId=1&serial=SERIAL-001&deadline=1730000000"
```

返回：

- `serialHash, nonce, signature, extraData`（extraData 为 ABI 编码后的 bytes）

风险放宽签名（RiskAllowance，供 `addItem()` 在超过默认上架阈值时传入）：

```bash
curl "http://localhost:8787/risk-allowance?shopOwner=0xShopOwner&maxItems=10&deadline=1730000000"
```

3. Query API + 内存索引（api）

- 目标：给广场/列表页提供快速查询：shops/items/purchases；优先走内存索引（快），必要时回退链上读取（全）。
- 代码入口：[apiServer.js](./worker/src/apiServer.js)

示例：

```bash
curl "http://localhost:8788/shops?cursor=1&limit=20"
curl "http://localhost:8788/items?cursor=1&limit=50"
curl "http://localhost:8788/purchases?itemId=1&limit=20&include=enrich"
```

前端对接（Plaza/Buyer/后台）：

- [main.js](./frontend/src/main.js) 支持两个 URL：
  - `WORKER_URL`：Permit（/serial-permit, /risk-allowance）
  - `WORKER_API_URL`：Query（/shops, /items, /purchases），失败时自动回退链上读取
- **一键演示 & 最小前端**
  - 一条命令本地部署 + 购买 + 输出 Purchased payload（可选附带 Query API 校验）
  - Vite 最小前端：直连合约完成 registerShop / addItem / buy（可选对接 Worker）

## License

Licensed under the [Apache License, Version 2.0](https://opensource.org/licenses/Apache-2.0). See [LICENSE](./LICENSE) for details.
