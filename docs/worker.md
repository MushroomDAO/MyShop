# Worker（监听 / 签名 / 通知）

## 作用

- 监听链上 `MyShopItems.Purchased` 事件，转发到：
  - Webhook（你的业务后端）
  - Telegram（运营/值班通知）
- 对外提供签名 API（EIP-712）：
  - `SerialPermit`：购买前的串号许可签名
  - `RiskAllowance`：上架突破默认限制的风控签名

## 目录

- 入口：[worker/src/index.js](../worker/src/index.js)
- 购买监听：[worker/src/watchPurchased.js](../worker/src/watchPurchased.js)
- Permit 服务：[worker/src/permitServer.js](../worker/src/permitServer.js)
- Query API 服务：[worker/src/apiServer.js](../worker/src/apiServer.js)

## 启动

```bash
cd worker
cp .env.example .env
pnpm install
pnpm run dev
```

## 配置项（.env）

- **链配置**
  - `RPC_URL`
  - `CHAIN_ID`
  - `ITEMS_ADDRESS`（MyShopItems 合约地址）
- **模式**
  - `MODE=watch|permit|both`
- **购买监听**
  - `POLL_INTERVAL_MS`
  - `LOOKBACK_BLOCKS`
  - `WEBHOOK_URL`（可选）
  - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（可选）
- **签名服务（permit）**
  - `PORT`
  - `SERIAL_SIGNER_PRIVATE_KEY`（用于 `/serial-permit`）
  - `SERIAL_SIGNER_PRIVATE_KEY_FILE`（推荐：从文件读取私钥）
  - `RISK_SIGNER_PRIVATE_KEY`（用于 `/risk-allowance`）
  - `RISK_SIGNER_PRIVATE_KEY_FILE`（推荐：从文件读取私钥）
  - `SERIAL_ISSUER_URL`（可选：让服务端先向外部系统申请串号/哈希，再回签）
  - `PERMIT_RATE_LIMIT=0|1`（默认开启：1）
  - `PERMIT_RATE_LIMIT_WINDOW_MS`（默认 60000）
  - `PERMIT_RATE_LIMIT_MAX`（默认 120）
  - `PERMIT_RATE_LIMIT_MAX_BUCKETS`（默认 5000）
  - `PERMIT_MAX_NONCE`（默认 1000000）
  - `PERMIT_MAX_SERIAL_LENGTH`（默认 128）
  - `PERMIT_MAX_CONTEXT_LENGTH`（默认 256）
- **聚合查询 API（可选）**
  - `ENABLE_API=1`
  - `API_PORT`（默认 8788）
  - `ENABLE_INDEXER=1`（默认开启：内存索引 Purchased）
  - `INDEXER_POLL_INTERVAL_MS`（默认 1000）
  - `INDEXER_LOOKBACK_BLOCKS`（默认 5000）
  - `INDEXER_MAX_RECORDS`（默认 5000）

## Permit API

### health

`GET /health`

### SerialPermit（购买前）

`GET /serial-permit?itemId=&buyer=&serial=&deadline=&nonce=&recipient=`

- `serial`：原始串号字符串（服务端会 `keccak256(serial)` 得到 `serialHash`）
- `deadline`：uint256 时间戳（有效期建议短，默认服务端生成 5 分钟 TTL）
- `nonce`：
  - 不填：服务端会从合约 `usedNonces(buyer, i)` 自动找一个未用的 nonce（0..999）
  - 填：用你提供的 nonce
- `recipient`（可选）：NFT 接收地址。不填默认等于 `buyer`（自购）。
  - 如需赠送/代购，明确填写不同于 buyer 的 recipient
  - **recipient 被纳入 EIP-712 签名，一旦签署不可更改**（见下方安全设计说明）

返回里会给出：

- `signature`（EIP-712 签名）
- `extraData`（已编码好的 `abi.encode(serialHash,deadline,nonce,sig)`，可直接作为 `buy(..., extraData)` 参数）

> **安全设计（Option B）**：`recipient` 字段被包含在 EIP-712 `SerialPermit` 结构体中，合约验签时会校验传入的 `recipient` 是否与签名内容一致。任何人持有 permit 但将 `recipient` 改为其他地址，签名验证都会失败（`InvalidSignature`）。这从根本上杜绝了"nonce 劫持"攻击（见下方威胁模型）。

#### 限流

对 `/serial-permit` 与 `/risk-allowance` 默认启用按 `IP + 路径` 的滑动窗口限流，触发时：

- HTTP 429（`errorCode=rate_limited`）
- `Retry-After` 响应头（秒）
- 返回 JSON 带 `retryAfterMs`

#### 外部串号签发（可选）

如果配置了 `SERIAL_ISSUER_URL`，则 `/serial-permit` 可以不传 `serial/serialHash`，服务端会先 `POST SERIAL_ISSUER_URL`：

```json
{ "buyer": "0x...", "itemId": "123", "context": "..." }
```

外部服务返回 `{"serial":"..."}`
或 `{"serialHash":"0x..."}` 均可，然后 Worker 会基于返回值回签 `SerialPermit`。

### RiskAllowance（上架前）

`GET /risk-allowance?shopOwner=&maxItems=&deadline=&nonce=`

返回 `signature`（用于 `addItem` 的 `signature` 字段）。

## 签名密钥治理（B5）

这两个 signer key 的共同特点：**不直接持有资金**，但会对业务风险与数据完整性产生决定性影响（例如放行购买串号、放大店铺可上架数量），所以仍需要“托管 / 轮换 / 审计 / 隔离”。

### Key 分类与职责

- **Serial Signer（SERIAL_SIGNER_PRIVATE_KEY）**
  - 只用于 `SerialPermit`：把 `serialHash/deadline/nonce` 绑定到 buyer + itemId
  - 目标：防止串号被伪造、复用或跨链/跨合约滥用
- **Risk Signer（RISK_SIGNER_PRIVATE_KEY）**
  - 只用于 `RiskAllowance`：允许 shopOwner 突破默认限制（如 maxItems）
  - 目标：把“提升限制”变成显式、可审计的风控授权

强烈建议两把 key **严格隔离**：不同机器/不同 Secret/不同权限的运维角色；若条件允许，拆成两个独立进程/容器分别提供 `/serial-permit` 与 `/risk-allowance`。

### 托管（Storage）

- 本地开发：可以直接用 `*_PRIVATE_KEY` 环境变量
- 生产环境：不要把私钥直接写进环境变量，优先使用 `*_PRIVATE_KEY_FILE` 以便：
  - Kubernetes Secret / Docker secret 以文件挂载
  - 权限可控（文件权限、只读挂载）
  - 轮换时只替换 secret 文件并滚动重启

### 轮换（Rotation）

由于签名验证发生在合约侧，轮换需要链上配合（典型做法是合约里有 signer 地址的可更新配置）。

推荐流程（最小可行）：

1. 生成新 key（离线或 KMS），拿到新 signer 地址
2. 在低峰期把合约 signer 地址更新为新地址（协议 owner 执行）：
   - `MyShopItems.setSerialSigner(newSigner)`
   - `MyShopItems.setRiskSigner(newSigner)`
3. 部署/滚动重启 Worker，让它开始用新 key 签名
4. 观察 `permit /metrics` 与业务交易成功率，确认新签名已生效
5. 回收旧 key（撤销访问、销毁旧 secret、留存审计记录）

如果要做到“无缝切换”，合约侧需要支持“双 signer 过渡期”（old/new 同时有效），再在稳定后下线 old。

### 审计（Audit）

- 建议在 Worker 的请求日志与 metrics 里持续观察：
  - permit 请求量、错误量、限流量、内部异常量
- 推荐把以下信息写入业务侧审计日志（不要记录私钥）：
  - signer 地址（可从私钥推导或在配置里显式标注）
  - 请求参数摘要（buyer/itemId/deadline/nonce 等），以及签名结果的 hash
  - 请求来源（IP / user-agent / trace-id）

### 最小权限与隔离（Least Privilege）

- Worker 运行账户不应具备任何链上资产权限（不持有资金、不做链上写操作）
- 不要复用“部署者/管理员”私钥作为 signer key
- Risk signer 应更严格（更少人可接触、更严格的审批流程）

### 事故响应（Incident Response）

如果怀疑 signer key 泄露或被滥用：

1. 立即在合约侧切换 signer 地址到新地址（或切到空地址/冻结策略，视业务容忍度）
2. 立即停止旧 Worker 实例并吊销旧 secret 的访问（KMS/Secret Manager/文件挂载权限）
3. 复盘影响范围：
   - SerialPermit：是否出现异常串号签名/重复 nonce/异常 buyer 来源
   - RiskAllowance：是否出现异常 maxItems 放行
4. 补齐审计与告警阈值：异常请求量、429、签名失败率、外部 issuer 错误率等

## Query API（聚合查询）

默认不开启，设置 `ENABLE_API=1` 后启用。

### 一条命令启动（示例）

```bash
MODE=both ENABLE_API=1 RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337 ITEMS_ADDRESS=0x... PORT=8787 API_PORT=8788 pnpm run dev
```

### health

`GET /health`

### config

`GET /config`

返回 `chainId / itemsAddress / shopsAddress` 等基础信息。

### indexer

`GET /indexer`

查看索引状态与可观测指标（如 `lastIndexedBlock` / `lagBlocks` / `consecutiveErrors` / `lastError` / `lastErrorKind` / `totalBackoffs` / `lastRecoveryAtMs` / `cachedPurchases` 等）。

### shop

`GET /shop?shopId=`

### shops

`GET /shops?cursor=&limit=`

### item

`GET /item?itemId=`

### items

`GET /items?cursor=&limit=`

### purchases

`GET /purchases?fromBlock=&toBlock=&buyer=&shopId=&itemId=&limit=&include=&source=`

- `fromBlock/toBlock`：不填会默认查询最近一段区间
- `buyer/shopId/itemId`：按 indexed 字段过滤
- `include`：默认包含 `enrich`（会额外返回 `item/shop` 链上读取结果），传 `include=` 可关闭 enrich
- `source`：`index`（默认）或 `chain`（强制走链上 getLogs）

## Keeper（定时任务指南）

**职责**

- 价格/风险相关的周期性维护（例如刷新外部价格缓存、归档购买索引）
- 健康检查与告警（监控 `/health`、`/indexer`、`/metrics` 输出）
- 数据持久化与轮转（将 in-memory 索引周期落盘，或同步到外部持久化存储）

**触发方式（示例）**

- 以 cron/定时器调用：
  - 每 1 分钟：GET `/health` 与 `/indexer`，记录延迟与错误计数
  - 每 5 分钟：GET `/purchases?source=chain&limit=2000`，与 index 差异做抽样比对
  - 每 10 分钟：将当前 indexer 状态写入持久化（如 JSON/kv/sqlite）
- 若需要外部价格缓存（可选）：调用外部 keeper 刷新价格，再由前端/业务读取

**环境建议**

- 生产环境开启 `ENABLE_API=1` 以便 keeper 读取状态
- 通过 `INDEXER_*` 配置合理的窗口与上限（避免过大内存）
- 日志与指标建议接入统一观测平台（含错误率阈值与告警）

**注意事项**

- Keeper 不应持有资金权限；仅读 API/指标或调用外部只读服务
- 与签名服务（permit）隔离部署与权限，避免互相影响

### 常用请求（curl）

```bash
curl -s http://127.0.0.1:8788/config
curl -s http://127.0.0.1:8788/indexer
curl -s "http://127.0.0.1:8788/shops?cursor=1&limit=20"
curl -s "http://127.0.0.1:8788/items?cursor=1&limit=20"
curl -s "http://127.0.0.1:8788/purchases?limit=50"
curl -s "http://127.0.0.1:8788/purchases?buyer=0x...&limit=50"
curl -s "http://127.0.0.1:8788/purchases?source=chain&fromBlock=0"
```
