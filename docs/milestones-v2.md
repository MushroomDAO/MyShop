# Redeem Counter — 里程碑规划 V2

> 日期：2026-04-04  
> 状态：规划中  
> 原则：从已完成到将来，每个里程碑有验收标准和可开发子任务

---

## 里程碑总览

| 里程碑 | 名称 | 状态 | 核心目标 |
|---|---|---|---|
| **M0** | 基础协议搭建 | ✅ 已完成 | 合约 + Worker + 前端基础结构 |
| **M1** | 基础兑换完整化 | 🔄 进行中 | 填补 M0 遗留的功能缺口，达到可用状态 |
| **M2** | Gasless + 智能钱包 | 📋 规划中 | 无 MetaMask、无 gas 感知 |
| **M3** | 忠诚积分体系 | 📋 规划中 | xPNTs 奖励 + SBT 会员 |
| **M4** | 售后仲裁 | 📋 规划中 | DisputeEscrow + 生态 JuryContract |
| **M5** | Agent + 订阅 | 📋 规划中 | Session Keys + ERC-8004 Agent |
| **M6** | 数字商品 + 支付通道 | 📋 规划中 | x402 + MicroPaymentChannel |
| **M7** | 生态完整 | 📋 规划中 | OIDC + 跨社区积分 + Agent 市场 |

---

## M0 — 基础协议搭建（已完成）

**验收标准**：三个子系统可以独立运行，基础流程可走通。

### 已实现清单

**合约层（✅）**
- MyShops.sol：shop 注册、权限管控（hasRole ROLE_COMMUNITY）、协议费率
- MyShopItems.sol：原子购买（pay → NFT mint → Action 执行）
- SerialPermit EIP-712：串号门控，nonce 防重放
- RiskAllowance EIP-712：超量风控放宽
- Action 白名单体系：MintERC20Action、MintERC721Action、EmitEventAction
- aPNTsSale.sol、GTokenSale.sol：独立售卖合约

**Worker 层（✅）**
- permitServer（8787）：SerialPermit + RiskAllowance 签名
- apiServer（8788）：Shop/Item/Purchase 查询 + 内存索引
- watchPurchased：链上事件监听 → Webhook / Telegram

**前端层（✅）**
- 广场页（#/plaza）：Shop 和 Item 列表浏览
- 买家控制台（#/buyer）：购买记录
- 店主控制台（#/shop-console）：注册 shop、上架 item
- 协议控制台（#/protocol-console）：协议级管理
- 风控页（#/risk）：RiskAllowance 测试
- 配置页（#/config）：运行时地址配置

---

## M1 — 基础兑换完整化（🔄 进行中）

**目标**：填补 M0 的功能缺口，让三个角色（运营者/买家/协议）完整闭环。  
**钱包方案**：M1 阶段前端使用 viem + privateKeyToAccount 注入测试账户，不做钱包 UI。

### 子任务列表

#### 合约子任务

| # | 任务 | 优先级 | 说明 |
|---|---|---|---|
| C1 | Item 库存约束 | P0 | `maxSupply`（总量）+ `perWallet`（每人）字段；buy() 检查并 revert |
| C2 | 时间窗口 | P0 | `startTime` / `endTime` 字段；buy() 在窗口外 revert |
| C3 | Item 级 pause | P0 | 单 item 暂停，不影响整个 shop |
| C4 | Shop pause 阻断 buy() | P0 | shop 暂停后所有 item 的 buy() revert |
| C5 | 购买计数 | P1 | 每个 item 的已售出数量 mapping，前端展示用 |
| C6 | batch quantity buy() | P1 | quantity > 1 时 Action 正确处理批量 |
| C7 | shopTreasury 提款函数 | P1 | owner 从合约累计收入提款到 treasury |
| C8 | 协议 treasury 提款 | P1 | protocol admin 提取协议费 |
| C9 | Item 字段更新 | P2 | addItem 后可修改 price / tokenURI / actionData |
| C10 | EligibilityValidator 白名单 | P2 | Protocol 维护 validator 合约白名单，shop 只能选白名单内的 |
| C11 | 兑换冷静期记录 | P2 | 记录每次购买的 timestamp，为 M4 Dispute 打基础 |

#### Worker 子任务

| # | 任务 | 优先级 | 说明 |
|---|---|---|---|
| W1 | SQLite 替换 JSON 索引 | P0 | 重启后数据不丢失；WAL 模式，事务写入 |
| W2 | nonce 持久化 | P0 | SerialPermit nonce 写 SQLite，跨重启一致 |
| W3 | 健康检查增强 | P0 | /health 返回签名服务状态；前端展示告警 |
| W4 | 购买记录聚合 API | P1 | `/purchases?buyer=` 含 Item 元数据 enrich |
| W5 | Shop 统计 API | P1 | `/shop/:id/stats`：成交量、收入、活跃用户 |
| W6 | Webhook 重试队列 | P2 | 投递失败自动重试，记录失败日志 |
| W7 | 结构化日志 | P2 | JSON 格式，方便告警系统接入 |

#### 前端子任务

| # | 任务 | 优先级 | 说明 |
|---|---|---|---|
| F1 | Item 详情页 (#/item/:id) | P0 | 图片、价格、库存、限购、资格判断、兑换历史 |
| F2 | 买家权益页 (#/my) | P0 | 我的 NFT 凭证列表，含 item 名、时间、tx hash |
| F3 | 购买状态完整状态机 | P0 | pending → 上链中 → confirmed / failed + 友好提示 |
| F4 | Revert 原因翻译 | P0 | 把合约 revert reason 翻译成用户可读文字 |
| F5 | Shop 主页 (#/shop/:id) | P1 | Shop 基本信息 + item 列表（含库存状态） |
| F6 | 收益提取 UI | P1 | 显示可提取余额，一键提款 |
| F7 | 移动端基础适配 | P2 | 响应式布局，手机可用 |
| F8 | IPFS 图片多网关 fallback | P2 | 3 个网关依次尝试，超时切换 |

**M1 验收标准**：
- 社区运营者：注册 shop → 上架 item（含库存限制）→ 查看成交 → 提取收益，全程无阻
- 买家：浏览广场 → 查看详情（含库存/资格）→ 完成兑换 → 查看"我的权益"
- Worker 重启后数据零丢失，签名不重复

---

## M2 — Gasless + 智能钱包（📋 规划中）

**目标**：买家无需持有 ETH，用 passkey 创建账户，gas 由 Shop 赞助。

### 子任务列表

#### 合约子任务

| # | 任务 | 说明 |
|---|---|---|
| C12 | buy() 支持 ERC-4337 UserOp 路径 | 通过 EntryPoint 调用，paymaster 赞助 gas |
| C13 | paymaster 参数透传 | buy() 不感知 paymaster，由 EntryPoint 处理 |

#### Worker 子任务

| # | 任务 | 说明 |
|---|---|---|
| W8 | OperatorClient 集成 | Shop 注册时调用 @aastar/operator.onboardOperator() 配置 SuperPaymaster |
| W9 | UserOp 构建辅助 | 为前端提供 UserOp 构建 API（可选，前端也可自行用 SDK 构建） |

#### 前端子任务

| # | 任务 | 说明 |
|---|---|---|
| F9 | YAAAClient 集成 | passkey 注册/登录，创建 AirAccount |
| F10 | Gasless 购买流 | 用 EndUserClient.executeGasless() 替代直接 tx |
| F11 | 账户余额展示 | 显示 AirAccount 内各 token 余额 |
| F12 | T1/T2 安全层提示 | 小额购买 T1 秒确认，大额 T2 提示需要额外确认 |

**M2 验收标准**：
- 新用户用邮箱/生物识别注册，全程零 ETH，完成第一笔兑换

---

## M3 — 忠诚积分体系（📋 规划中）

**目标**：买家通过兑换积累积分和身份，享受分级权益。

### 子任务列表

| # | 任务 | 说明 |
|---|---|---|
| C14 | EligibilityValidator 接口合约 | IEligibilityValidator 标准接口 + protocol 白名单管理 |
| C15 | SBTHolderValidator | 持有指定 SBT 的资格验证器 |
| C16 | TokenBalanceValidator | 持有 ≥ N token 的资格验证器 |
| W10 | xPNTs 购后奖励 | 监听 Purchased → 调用 xPNTsFactory 发奖励积分 |
| W11 | EligibilityPermit 签名 | Worker 聚合资格判断 → 签发 EligibilityPermit（EIP-712）|
| F13 | xPNTs 余额展示 | 前端显示各社区专属积分余额 |
| F14 | SBT 等级展示 | 显示用户持有的 MySBT 及等级 |
| F15 | 资格状态可视化 | Item 详情页展示兑换条件达成情况 |
| W12 | EligibilityPermit Proof 机制（预留） | Worker 未来 stake 后可引入 ZK/可验证证明，防止签名说谎 |

**M3 注记**：Worker 签发 EligibilityPermit 的权威性来自于：
- M3 阶段：Worker 由社区运营者控制，社区对其信任
- M5+ 阶段：Worker（节点服务）需要质押，不诚实签名会被 slash
- 长期：引入 ZK Proof 或 TEE Attestation，实现无信任证明

**M3 验收标准**：
- 买家兑换后自动收到 xPNTs 奖励
- SBT 门控的 item 在没有 SBT 时正确拒绝购买

---

## M4 — 售后仲裁（📋 规划中）

**目标**：纠纷可链上申诉，去中心化陪审团裁决，资金自动释放。

**前提**：生态 JuryContract 完成通用化改造（见 `docs/jury-contract-redesign.md`）

### 子任务列表

| # | 任务 | 说明 |
|---|---|---|
| C17 | JuryContract 通用化改造 | 添加 contextId + callback 机制（协调生态侧） |
| C18 | ITaskCallback 接口发布 | 生态标准接口 |
| C19 | DisputeEscrow.sol | 争议资金托管 + ITaskCallback 实现 |
| C20 | 7 天冷静期检查 | openDispute() 校验 purchaseId 的 timestamp |
| C21 | 证据 IPFS 上传辅助 | Worker /dispute/evidence 端点，帮助上传到 IPFS + Pin |
| W13 | 争议事件监听 | 监听 DisputeOpened → 通知买卖双方 |
| W14 | 陪审员通知 | Jury 任务创建后广播给活跃陪审员 |
| F16 | 争议发起 UI | 买家：描述问题 + 上传证据 → 发起争议 |
| F17 | 卖家响应 UI | 店主：查看争议 + 提交反证 |
| F18 | 争议状态追踪 | 双方可看到当前进度（冷静期/举证期/投票期/已裁决）|

**M4 验收标准**：
- 买家发起争议 → 7 天内陪审员投票 → 资金自动释放或退款
- 全流程链上可追溯，争议证据永久存于 IPFS

---

## M5 — Agent + 订阅（📋 规划中）

**目标**：支持自动化兑换，Agent 代理采购，订阅类权益。

### 子任务列表

| # | 任务 | 说明 |
|---|---|---|
| C22 | SubscriptionAction | buy() 时颁发 AirAccount Session Key，定期自动续兑 |
| C23 | Agent 资格 EligibilityValidator | 验证 ERC-8004 Agent 身份，白名单制 |
| W15 | Agent 购买 API | Worker 提供 Agent 专用的无人工确认购买端点 |
| W16 | Session Key 管理 | 颁发和撤销 Session Key 的 Worker 辅助服务 |
| F19 | 订阅管理 UI | 查看/管理已订阅的 item，手动续订或取消 |
| F20 | Agent 注册引导 UI | 引导 Agent 注册到 AgentIdentityRegistry |

---

## M6 — 数字商品 + 支付通道（📋 规划中）

**目标**：支持 API 访问权、内容订阅等真正数字商品。

### 子任务列表

| # | 任务 | 说明 |
|---|---|---|
| C24 | X402Action | buy() 后生成 EIP-3009 访问授权 |
| C25 | MicroPaymentAction | 订阅 item 通过 MicroPaymentChannel 流式扣减 |
| W17 | x402 Facilitator 端点 | Worker 新增 /x402 支付结算端点 |
| W18 | 流式支付监控 | 监控 MicroPaymentChannel 余额，不足时通知 |
| F21 | 数字内容解锁 UI | 购买后展示访问凭证，一键访问受保护内容 |

---

## M7 — 生态完整（📋 规划中）

**目标**：OIDC 统一登录、跨社区积分、Agent 市场。

### 子任务列表（粗略）

| # | 任务 | 说明 |
|---|---|---|
| C26 | 跨社区 xPNTs 桥接合约 | 不同社区积分互换比率 |
| W19 | OIDC Provider 集成 | AAStar 统一账号体系对接 |
| F22 | Agent 市场页面 | 发现、评估、授权 Agent 代理兑换 |
| F23 | 声誉面板 | 陪审、兑换、贡献的综合声誉展示 |

---

## 附录：Worker 三个子服务的必要性说明

### watchPurchased — 事件监听服务

**必要性**：链上事件是 append-only 的历史日志，前端无法高效订阅（WebSocket 不稳定、无分页）。  
**价值**：由服务端单点监听，推送给所有需要通知的订阅方（Webhook、Telegram、内部索引），每个客户端不需要各自连接 RPC。

### apiServer — 查询 API 服务

**必要性**：链上合约没有"分页查询所有 Shop"的能力——合约只提供按 ID 读取的点查接口。扫描所有事件构建列表的操作需要大量 RPC 调用，不适合放在前端。  
**价值**：汇聚链上事件索引 + IPFS 元数据，提供 `/shops?page=1&limit=20` 这样的高效 HTTP 接口，前端只需消费数据。

### permitServer — EIP-712 签名服务

**为什么必须在后端，不能在前端？**

这是理解最关键的一点：

1. **私钥安全**：签名服务持有 `SERIAL_SIGNER_PRIVATE_KEY`。若在前端运行，私钥暴露在浏览器 JS 环境中，任何人可提取并伪造无限量的 SerialPermit，完全绕过门控。

2. **业务规则不可绕过**：permitServer 在签名前执行业务校验（rate limit、序列号唯一性、库存预检等）。若在前端，用户可以修改 JS 绕过这些校验，直接调用签名逻辑。

3. **链下状态需要权威方维护**：SerialPermit 的 nonce 需要持久化，防止同一个 serial 被签名两次（replay attack）。这个状态必须在后端可信环境中维护，前端无法提供这种保证。

4. **未来可扩展信任**：Worker（节点服务）将来需要质押（stake），成为链上可验证的可信签名方。质押和声誉机制对前端无意义，只对后端节点有意义。

5. **与外部系统集成**：许多串号场景需要调用外部 API（库存系统、CRM、第三方序列号服务）。这些调用包含 API 密钥，必须在后端执行。

**简洁表达**：permitServer 的信任根（trust root）是"合约上配置的已知签名地址"。这个地址对应一个后端持有的私钥。让前端持有这个私钥等同于让用户持有它，信任根就消失了。

---

## 附录：里程碑依赖关系

```
M0（已完成）
  ↓
M1（补全基础，必须完成才能推进其他）
  ↓
M2（Gasless）← 依赖：SuperPaymaster + AirAccount M7
  ↓
M3（忠诚体系）← 依赖：M2，xPNTsFactory，MySBT
  ↓
M4（仲裁）← 依赖：M1（冷静期记录），生态 JuryContract 改造
  ↓
M5（Agent）← 依赖：M2（Session Keys），ERC-8004 Registry
  ↓
M6（数字商品）← 依赖：M2（AirAccount），SuperPaymaster x402
  ↓
M7（完整生态）← 依赖：M3-M6 稳定
```
