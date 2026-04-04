# Redeem Counter — 缓存与索引体系设计

> 版本：v1.0  
> 日期：2026-04-04  
> 状态：设计讨论，不写代码

---

## 0. 问题背景

Redeem Counter 的数据来源有三层：

```
数据源                    特点
─────────────────────────────────────────────────────────────
链上合约状态             可信，但查询慢、无分页、费 RPC 配额
链上事件（Events）       可信，永久，append-only，最适合索引
IPFS 内容               内容寻址（CID 不变）= 天然可缓存；但访问速度不稳定
```

Worker 的 `apiServer` 当前做法：把链上事件 + 合约状态聚合到内存，对外提供 HTTP 查询接口。这是正确的方向，但实现上还不够健壮。

---

## 1. 整体缓存架构（四层）

```
                ┌──────────────────────────────────┐
用户/前端        │   Browser Cache（L1）             │  5min/1hr TTL
                └───────────────┬──────────────────┘
                                │ HTTP
                ┌───────────────▼──────────────────┐
Cloudflare      │   CDN Edge Cache（L2）            │  30s-60s API / ∞ IPFS
（全球部署）     │   + Cloudflare IPFS Gateway       │
                └───────────────┬──────────────────┘
                                │
                ┌───────────────▼──────────────────┐
Worker 节点     │   Node In-Memory + SQLite（L3）   │  事件索引 + RPC 结果缓存
（AAStar 节点） │   + IPFS 本地缓存                  │
                └───────────────┬──────────────────┘
                                │ RPC + IPFS HTTP
                ┌───────────────▼──────────────────┐
源数据          │   链上合约 / IPFS 网络（L4）        │  真相来源
                └──────────────────────────────────┘
```

---

## 2. L1：浏览器缓存

### 缓存策略

| 数据类型 | 缓存位置 | TTL | 理由 |
|---|---|---|---|
| IPFS 图片/元数据 | `Cache-API` / HTTP `Cache-Control` | 永久（immutable） | CID 不变，内容永远相同 |
| Shop/Item 列表 | `sessionStorage` | 5 分钟 | 用户浏览期间不刷新 |
| 我的兑换记录 | `localStorage` + ETag | 2 分钟 | 买家敏感数据，快速失效 |
| 用户余额（xPNTs 等） | 内存 | 30 秒 | 高频变化，短暂缓存减少 RPC |
| EligibilityPermit 签名 | `sessionStorage` | 至 deadline | 签名有效期内复用，避免重复请求 Worker |

### HTTP 缓存头规范

Worker apiServer 应返回标准缓存头：
```
GET /items → Cache-Control: public, max-age=30, stale-while-revalidate=60
GET /item/:id → Cache-Control: public, max-age=60, stale-while-revalidate=120
GET /ipfs/... → Cache-Control: public, max-age=31536000, immutable   ← 内容寻址，永久
GET /purchases?buyer=... → Cache-Control: private, max-age=30
```

---

## 3. L2：Cloudflare CDN 层

### 3.1 为什么用 Cloudflare

- 全球边缘节点（330+ 城市），解决亚洲/欧洲用户访问延迟
- Cloudflare Workers 可作为 API 网关（路由、限速、缓存）
- 内置 IPFS 网关（`cloudflare-ipfs.com/ipfs/{CID}`）
- R2 对象存储可作为 IPFS 内容镜像，访问速度远优于 IPFS 网络
- KV 存储适合轻量分布式状态（如 nonce 防重放、rate limit 计数）

### 3.2 部署方案

```
用户请求
  ↓
api.redeem.aastar.io（Cloudflare DNS）
  ↓
Cloudflare CDN Cache 检查
  ├── 命中 → 直接返回（延迟 <10ms）
  └── 未命中 → 回源到 Worker API（via Cloudflare Tunnel 或直接 IP）
                ↓ 写入 CDN 缓存
                返回给用户

IPFS 内容（图片/元数据）
  ipfs.aastar.io/ipfs/{CID}（自定义域名）
  ↓
Cloudflare IPFS Gateway 或 R2 Mirror
  ├── R2 中有 → 直接返回（快，且有 Cloudflare 全球加速）
  └── R2 无 → 从 IPFS 网络获取 → 异步写入 R2 → 返回
```

### 3.3 Cloudflare Cache Rules 配置（示意）

```
规则 1: IPFS 内容永久缓存
  匹配: URI 路径包含 /ipfs/
  操作: Cache Level = Cache Everything, Edge TTL = 1 year

规则 2: API 列表接口缓存
  匹配: URI 路径匹配 /shops* 或 /items*
  操作: Cache Level = Cache Everything, Edge TTL = 60s

规则 3: 买家个人数据不缓存
  匹配: URI 路径包含 /purchases 且有 buyer= 参数
  操作: Bypass Cache（个人数据不共享）

规则 4: Permit API 不缓存
  匹配: 端口 8787 或路径 /serial-permit /risk-allowance
  操作: Bypass Cache（签名是一次性的）
```

### 3.4 Cloudflare R2 作为 IPFS 镜像

NFT 元数据和图片上传到 IPFS 时，同时写一份到 R2：
```
上架流程：
  店主上传图片/元数据
    → Worker 上传到 IPFS（获得 CID）
    → Worker 同步写入 Cloudflare R2（路径：r2://myshop-assets/ipfs/{CID}）
    → R2 通过 Cloudflare CDN 全球加速访问
    → 前端优先用 R2 URL（快），IPFS URL 作为去中心化备份
```

### 3.5 Cloudflare KV 用途

| 用途 | Key 格式 | TTL |
|---|---|---|
| SerialPermit nonce 记录 | `nonce:{itemId}:{buyer}:{nonce}` | 永久（防重放） |
| Rate limiting 计数 | `rate:{ip}:{endpoint}` | 60s |
| 签名服务熔断状态 | `circuit:{service}` | 30s |
| 最新区块高度缓存 | `indexer:latest-block:{chain}` | 10s |

---

## 4. L3：Worker 节点本地缓存

### 4.1 当前问题

- 内存索引：重启丢失
- JSON 文件：写入可靠性差，无事务，并发危险
- 无 RPC 结果缓存：每次查询都调用 RPC

### 4.2 改进方案：SQLite as 持久化引擎

**为什么 SQLite**：
- 无需外部服务（Redis/PostgreSQL）
- 文件即数据库，Worker 进程内嵌
- 支持 WAL 模式（写不阻塞读）
- 适合单节点部署，集成到统一节点时可替换为共享 DB

```
数据表设计（简化）：

purchases (id, shop_id, item_id, buyer, recipient, token_id, 
           serial_hash, quantity, block_number, tx_hash, timestamp)

shops (id, owner, community, name, metadata_uri, fee_bps, 
       treasury, paused, block_number)

items (id, shop_id, pay_token, unit_price, nft_contract,
       token_uri, action, max_supply, per_wallet, 
       start_time, end_time, sold_count, paused)

indexer_state (chain_id, last_indexed_block, last_updated)
```

**性能**：SQLite WAL 模式在单节点场景下读取 QPS > 50,000，完全满足需求。

### 4.3 RPC 调用缓存（内存 LRU）

```
缓存 RPC 结果以减少节点负担：

链上状态（短 TTL，数据可变）：
  getItemDetails(itemId)     → 缓存 30s
  getShopDetails(shopId)     → 缓存 60s
  tokenBalance(addr, token)  → 缓存 15s

事件数据（不过期，写入 SQLite）：
  Purchased events           → 永久（写 SQLite）
  ItemAdded events           → 永久（写 SQLite）
  ShopRegistered events      → 永久（写 SQLite）
```

### 4.4 IPFS 内容本地缓存

Worker 节点维护一个本地 IPFS 元数据缓存（content-addressed，永不过期）：
```
缓存目录结构：
  .cache/ipfs/
    ├── {CID-1}.json   NFT metadata
    ├── {CID-2}.json   Shop metadata
    └── ...

读取策略：
  1. 检查本地缓存（命中 → 立即返回）
  2. 检查 Cloudflare R2（快）
  3. 尝试 Cloudflare IPFS Gateway
  4. 尝试 ipfs.io / pinata gateway
  5. 写入本地缓存
```

---

## 5. 链上事件索引方案

### 5.1 短期：Worker 自建索引（M1-M3）

Worker 的 `indexer` 模块已经实现了基础事件轮询。改进点：
- 从 JSON 文件迁移到 SQLite
- 支持分页和复杂过滤（按 shopId、buyer、时间范围）
- 索引状态持久化（最后处理区块号写 SQLite，重启可续扫）
- 多链支持（chain_id 字段隔离）

### 5.2 中期：The Graph 子图（M4+）

为什么在 M4+ 引入 The Graph：
- 纠纷仲裁需要更复杂的事件关联查询
- 社区可以自己运行 Graph 节点，去中心化
- GraphQL 接口更灵活

```
子图监听的事件：
  MyShopItems:
    - Purchased(shopId, itemId, buyer, recipient, tokenId, ...)
    - ItemAdded, ItemUpdated, ItemPaused
    - DisputeOpened, DisputeResolved（M4）
    
  MyShops:
    - ShopRegistered, ShopUpdated, ShopPaused

实体：
  Shop, Item, Purchase, Dispute, Buyer（聚合统计）
```

### 5.3 商业托管索引选项（备选）

| 服务 | 优势 | 劣势 | 适用场景 |
|---|---|---|---|
| Goldsky | 快速部署，管理简单 | 中心化，收费 | 早期快速上线 |
| Envio | 高性能，低延迟 | 较新，社区较小 | 高 TPS 场景 |
| Subsquid | 去中心化，数据主权 | 部署复杂 | 去中心化优先 |
| The Graph（托管） | 成熟，有社区 | 托管版逐步退出 | 过渡方案 |
| The Graph（去中心化网络） | 完全去中心化 | 需要支付 GRT | 长期目标 |

---

## 6. IPFS 网关策略

### 6.1 网关优先级顺序

```
前端/Worker 访问 IPFS 内容时，按优先级尝试：

1. Cloudflare R2 Mirror（最快，全球 CDN 加速）
   https://assets.aastar.io/ipfs/{CID}
   
2. Cloudflare IPFS Gateway
   https://cloudflare-ipfs.com/ipfs/{CID}
   
3. Worker 本地缓存（如果是 Worker 侧访问）
   file://.cache/ipfs/{CID}
   
4. Pinata Gateway（备用）
   https://gateway.pinata.cloud/ipfs/{CID}
   
5. IPFS 公共网关（最后手段）
   https://ipfs.io/ipfs/{CID}
   
6. 社区节点网关（M4+ 引入）
   https://node1.community.aastar.io/ipfs/{CID}
```

### 6.2 IPFS 内容 Pin 责任

| 内容类型 | Pin 责任方 | Pin 服务 |
|---|---|---|
| NFT 元数据（tokenURI） | Shop owner 上架时 + Worker 辅助 | Pinata / web3.storage |
| Shop 元数据（metadataHash） | Shop owner 注册时 | Pinata |
| 协议文档 / 类目数据 | 协议方（AAStar） | Pinata + 社区 IPFS Cluster |
| 争议证据（M4+） | 争议发起方 | Worker 辅助 Pin |

**Worker 的 Pin 辅助**：当 Item 上架时，Worker 监听到 `ItemAdded` 事件，自动对 `tokenURI` 对应的 CID 发起 Pin（调用 Pinata API 或自建 IPFS Cluster）。这样即使 shop owner 离线，内容也不会丢失。

---

## 7. 从 Cloudflare 向社区节点迁移

### 7.1 迁移路径

```
阶段 1（现在）：Cloudflare 主导
  API    → Cloudflare CDN → Worker 节点（1-2 个）
  IPFS   → Cloudflare IPFS Gateway + R2 Mirror
  
阶段 2（M4+）：社区节点加入
  部分社区运行 AAStar 统一节点（包含 MyShop Worker）
  社区节点加入 IPFS Cluster，增加副本
  前端 IPFS 网关列表增加社区节点
  
阶段 3（M7+）：社区为主
  The Graph 去中心化子图（社区 Indexer 节点参与）
  IPFS 社区 Cluster 副本数达到阈值，Cloudflare 降为备用
  API 负载均衡到多个社区节点
  
Cloudflare 永远保留为：
  全球 CDN 加速层（HTTPS 终止、DDoS 防护）
  紧急备用（社区节点全挂时）
```

### 7.2 社区节点运行要求

统一节点包含 MyShop Worker 后，社区节点需要：
- 稳定带宽（上行 ≥ 10Mbps）
- 存储（≥ 50GB，随 NFT 数量增长）
- 内存（≥ 2GB，SQLite + 内存索引）
- 运行 IPFS Cluster peer（副本贡献）

**激励机制**：运行节点的社区可以获得协议手续费分成（待设计）。

---

## 8. 缓存一致性问题

### 8.1 Item 库存实时性

兑换广场最敏感的数据是**库存剩余数量**。Cloudflare 缓存 60s 意味着用户看到的库存可能滞后。

解决方案：
- 前端乐观更新（用户点"兑换"后立即减 1 显示）
- 兑换失败时（库存耗尽 revert）前端重新获取最新状态
- 对于"秒杀型"（热门有限量）商品，跳过 CDN 缓存直接查 Worker（增加 `Cache-Control: no-cache` header 的特殊端点）

### 8.2 链上状态 vs 索引延迟

Worker 索引有区块延迟（1-3 区块，约 3-15 秒）。

策略：
- 前端提交 tx 后，用 tx hash 轮询 RPC 确认状态（不依赖索引）
- 索引数据用于"历史查询"，不用于"当前状态"的关键判断
- 买家"我的兑换记录"允许有 15 秒延迟

### 8.3 IPFS 内容可用性

CID 不变，但 IPFS 节点可能下线导致内容不可用。

策略：
- R2 Mirror 保证 HTTP 访问永远可用（Cloudflare SLA）
- Worker 监听 `ItemAdded` 事件后立即 Pin
- 前端多网关 fallback（3 个网关失败才显示加载失败）

---

## 9. 监控与告警

| 指标 | 告警条件 | 处理方式 |
|---|---|---|
| Cloudflare 缓存命中率 | < 70% | 检查 Cache Rules 配置 |
| Worker API P99 延迟 | > 500ms | 排查 RPC 节点或索引性能 |
| IPFS 内容不可用率 | > 1% | 触发重新 Pin，检查 R2 同步 |
| 索引落后区块数 | > 20 blocks | 检查 RPC 连接，Worker 是否存活 |
| SQLite 写入失败率 | > 0 | 立即告警，防止数据丢失 |

Cloudflare 提供内置的 Analytics 和 Alerts；Worker 节点侧使用 Prometheus + Grafana。

---

*下一步：M1 阶段先完成 SQLite 替换 JSON 文件的持久化改造，其他层在对应里程碑中推进。*
