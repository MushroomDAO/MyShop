# RoyaltyPNTs Redeem Counter — Shop V2 架构设计文档

> 版本：v2.2  
> 日期：2026-04-03  
> 状态：设计阶段，不写代码  
> 核心命题：**MyShop = 合约 + 前端；前端将提炼为 SDK；MyShop 是被集成的协议**

---

## 0. 产品定位重述

### 0.1 名称与叙事

**正式名称**：`RoyaltyPNTs Redeem Counter`（积分兑换柜台）  
**简称**：Redeem Counter / 兑换柜台  
**技术代号**：MyShop（合约/代码层保留）

叙事框架：
> 社区成员通过贡献、参与和协作，积累 RoyaltyPNTs（忠诚积分）；积分可在社区兑换柜台换取数字权益——纪念 NFT、功能解锁、活动票务、社区礼物。兑换是奖励，不是消费。

这一定位规避了商业销售的合规风险（销售许可、税务），同时天然契合 Web3 DAO 的激励逻辑。

### 0.2 仓库边界：MyShop = 合约 + 前端

**MyShop 仓库的核心只有两个组件**：

```
/contracts   链上协议（Solidity + Foundry）
             永久部署在链上；合约是真正的核心产品

/frontend    参考前端（Vite + vanilla JS + viem）
             当前：直连合约，演示完整兑换流程
             未来：前端 JS 逻辑提炼为 @aastar/sdk 中的 MyShop 模块

/worker      辅助服务（非核心，可替换）
             提供 EIP-712 签名 API 和事件通知
             任何实现了相同接口的服务都可以替代 worker
```

**Worker 的定位**：Worker 是一个可替换的参考实现，不是 MyShop 协议的必要部分。协议合约只验证签名的有效性，不关心签名由谁提供。将来 AAStar SDK 可以提供对应的 server-side signer 替代 Worker。

### 0.3 架构哲学：我是协议，我被集成

**MyShop 的角色不是集成别人，而是提供一个清晰的、可被集成的协议层。**

```
上游集成方（使用 MyShop 的协议能力）
    ├── AAStar SDK（将 MyShop 的 buy() 封装为 SDK 方法）← 前端逻辑提炼后的归宿
    ├── AirAccount（用户通过智能钱包调用 buy()）
    ├── SuperPaymaster（为 buy() 赞助 gas）
    ├── 社区自定义前端（直连合约 ABI）
    └── 第三方 Agent（通过 Session Key 自动调用 buy()）

MyShop 协议本体（合约 + 参考前端）
    ├── 合约 ABIs（标准接口，任何 viem/ethers 客户端可调用）
    ├── EIP-712 Permit 接口（任何签名服务可实现，Worker 是参考实现）
    ├── Events（任何索引服务可监听，Worker API 是参考实现）
    ├── IAction 接口（任何动作模块可接入）
    └── IEligibility 接口（任何资格验证可接入）

下游被依赖的外部合约（MyShop 调用但不控制）
    ├── AAStar Registry（社区资格校验）
    ├── CommunityNFT（执行 mint，社区自部署）
    └── Action 合约（可选，社区部署）
```

**设计原则**：
- 合约只做链上可验证的事；链下能力通过标准接口（EIP-712、IAction、IEligibility）接入
- 任何外部服务（paymaster、signer、indexer）都是可替换的实现，不是硬依赖
- 前端是合约的演示和参考实现，最终被 SDK 吸收；合约才是长期产品

### 0.3 假设已被集成后的能力基线

以下能力假设已就绪（即使目前尚未实现），作为 UX 和功能设计的基础：

| 假设能力 | 提供方 | 对用户的体验 |
|---|---|---|
| 智能钱包 + passkey | AirAccount M7 | 邮箱/生物识别开户，无 MetaMask |
| Gasless 交易 | SuperPaymaster | 全程无 gas 感知 |
| xPNTs 忠诚积分 | xPNTsFactory | 兑换后自动得积分 |
| MySBT 会员身份 | SuperPaymaster MySBT | 持有身份 token，享受分级权益 |
| Jury 仲裁 | MyTask JuryContract | 纠纷可申诉，公正裁决 |
| Session Key | AirAccount SessionKeyValidator | Agent 代理，自动续兑 |
| x402 支付 | SuperPaymaster x402 | API/内容访问权限即时结算 |
| MicroPaymentChannel | SuperPaymaster | 流式付费，按量计费 |
| ERC-8004 Agent | AgentIdentityRegistry | 自动化采购，B2B 集成 |
| OIDC 统一登录 | AAStar 生态 | 一个账号，多个 DApp |

---

## 1. 用户旅程设计（假设已被完整集成）

### 1.1 成员/买家旅程（极简体验目标）

```
打开兑换广场
  ↓
我的身份自动识别（AirAccount passkey 已登录）
  ↓
看到可用余额：xPNTs ○○  aPNTs ○○  USDC ○○
  ↓
浏览兑换品（按社区/分类/热门/新上线）
  ↓
点击心仪商品 → 详情页
  ├── 名称、描述、NFT 预览
  ├── 兑换价格（支持多种支付方式）
  ├── 库存：还剩 XX 件 / 限每人 X 件
  ├── 我的资格：✅ 可兑换 / ❌ 需持有 SBT Level 2
  └── 兑换历史（最近 N 个人已兑换）
  ↓
点击"兑换"
  ├── 选择支付方式（xPNTs 优先推荐）
  ├── 显示：你将付出 500 xPNTs，得到 [权益 NFT]
  └── 生物识别/passkey 确认
  ↓
等待（通常 2-5 秒）→ 动画反馈
  ↓
兑换成功！
  ├── NFT 进入我的钱包
  ├── 奖励：+50 xPNTs
  ├── 分享按钮（可选）
  └── 查看"我的权益"
```

**UX 原则**：
- 隐藏所有 Web3 复杂性（gas、tx hash、合约地址）
- 关键信息前置：价格、库存、我的资格
- 失败也要优雅：revert 原因翻译为人话
- 加载状态精细化：提交中 → 上链中 → 确认中 → 成功

### 1.2 社区运营者/店主旅程

```
我的社区已在 AAStar Registry 注册
  ↓
进入 Shop Console → "开设兑换站"
  ├── 基本信息：名称、简介、LOGO（上传到 IPFS）
  ├── 联系方式：Telegram / 网站
  ├── 结算地址：社区金库地址
  └── 协议确认（了解 3% 协议费）
  ↓
兑换站创建成功
  ├── 系统自动：配置为 Paymaster Operator（M2 后）
  └── 进入兑换站管理面板
  ↓
上架兑换品
  ├── 选择类型：NFT 权益 / 积分包 / 活动票 / 数字商品
  ├── 填写信息：名称、描述、图片（IPFS）
  ├── 设置价格：接受哪些 token，价格是多少
  ├── 库存设置：总量、每人限量、开放时间
  ├── 购买条件：是否需要特定 SBT / 最低积分
  ├── 关联动作：购买后执行什么（发积分/发 ERC20/发自定义事件）
  └── 预览后确认上架（需支付上架费 100 aPNTs 防 spam）
  ↓
管理面板
  ├── 销售数据：成交量、收入、活跃买家
  ├── 库存监控：各 Item 剩余数量告警
  ├── 纠纷管理：待处理争议、历史仲裁记录
  └── 收益提取：从 shop treasury 提取到社区金库
```

### 1.3 Agent 购买旅程（M5+，假设已就绪）

```
Agent 已在 AgentIdentityRegistry 注册（ERC-8004）
Agent 已获得 Session Key（AirAccount + 用户授权）
  ↓
Agent 扫描兑换广场 API（Worker /items endpoint）
  ↓
满足条件的 Item → 构建 UserOp
  ├── 附带 Session Key 签名
  ├── SuperPaymaster 赞助 gas（Agent 声誉足够高）
  └── 提交到 EntryPoint
  ↓
链上执行 buy() → 成功
  ↓
Worker 通知 Agent 所有者（Webhook / Telegram）
  ↓
Agent 更新声誉记录（每次成功 +reputation）
```

### 1.4 纠纷/售后旅程（M4+）

```
兑换成功后 7 天内
  ↓
买家发现权益未兑现（如：积分未到账）
  ↓
进入"我的权益" → 找到该兑换记录 → "申请仲裁"
  ├── 描述问题（文字）
  ├── 上传证据（截图、链接 → 自动存 IPFS）
  └── 提交（链上冻结争议金额）
  ↓
店主收到通知（Telegram + 前端）→ 3 天内响应
  ├── 主动解决：处理问题 + 关闭争议 + 释放资金
  └── 提交反证 → 进入 Jury 投票
  ↓
陪审员（来自 AAStar 社区，共用 MyTask Jury）收到任务
  → 阅读双方证据 → 投票（7 天）→ 66% 共识
  ↓
自动执行裁决：退款 or 释放资金 or DAO 升级
```

---

## 2. 完整功能清单

### 2.1 核心兑换功能

| 功能 | 描述 | 里程碑 |
|---|---|---|
| 浏览兑换广场 | 按社区/类型/热度浏览全部兑换品 | M1 |
| Item 详情页 | 完整信息、库存、资格判断、兑换历史 | M1 |
| 原子兑换 buy() | 付款+NFT+Action 一笔 tx | M1 |
| 多种支付 token | xPNTs、aPNTs、USDC、ETH、WBTC | M1 |
| SerialPermit 门控 | 序列号管控，防双花 | M1 |
| 库存/限购 | maxSupply + perWallet + 时间窗口 | M1 |
| 兑换记录 | 买家查看自己的 NFT 凭证 | M1 |
| Shop 主页 | 按 Shop 聚合的兑换品展示 | M1 |
| 购买状态追踪 | pending→confirmed→failed 完整状态机 | M1 |
| 收益提取 | shop owner 从 treasury 提款 | M1 |

### 2.2 智能钱包 + Gasless（M2）

| 功能 | 描述 | 里程碑 |
|---|---|---|
| Passkey 开户 | 邮箱/生物识别创建 AirAccount | M2 |
| MetaMask 回退 | 兼容传统 EOA 用户 | M2 |
| Gasless 兑换 | SuperPaymaster 赞助 gas | M2 |
| Shop Paymaster 配置 | 店主注册为 Paymaster Operator | M2 |
| T1/T2/T3 安全分层 | 按兑换金额自动选择签名安全级别 | M2 |

### 2.3 忠诚体系（M3）

| 功能 | 描述 | 里程碑 |
|---|---|---|
| xPNTs 奖励 | 兑换后自动发放社区专属积分 | M3 |
| MySBT 会员卡 | 兑换积累 SBT 等级徽章 | M3 |
| SBT 门控 Item | 持有特定 SBT 才能兑换的专属品 | M3 |
| 积分兑换 Gas | xPNTs 用于支付自己的 gas 费 | M3 |
| 会员专属折扣 | SBT 等级越高，兑换比例越优惠 | M3 |

### 2.4 售后仲裁（M4）

| 功能 | 描述 | 里程碑 |
|---|---|---|
| 兑换取消窗口 | 7 天内可发起争议 | M4 |
| 争议托管 Escrow | 冻结争议金额直至裁决 | M4 |
| Jury 仲裁（共用 MyTask） | 去中心化陪审员投票 | M4 |
| 证据 IPFS 存储 | 双方证据链上不可篡改 | M4 |
| 自动裁决执行 | Jury 结果直接触发资金释放 | M4 |

### 2.5 Agent + 订阅（M5）

| 功能 | 描述 | 里程碑 |
|---|---|---|
| Session Key 兑换 | 时限 + 范围限制的自动化授权 | M5 |
| ERC-8004 Agent 注册 | Agent 身份 + 声誉积累 | M5 |
| Agent 自动兑换 | 无人工确认的条件触发兑换 | M5 |
| 订阅类 Item | 定期自动续兑，支付流式扣减 | M5 |
| Agent 赞助策略 | 高声誉 Agent 免 gas | M5 |

### 2.6 数字商品 + 支付通道（M6）

| 功能 | 描述 | 里程碑 |
|---|---|---|
| x402 API 访问权限 | buy() 后获得 EIP-3009 访问授权 | M6 |
| MicroPaymentChannel | 流式付费，按量/时长扣减 | M6 |
| x402 Facilitator | Worker 作为支付结算节点 | M6 |
| 数字内容解锁 | 购买后解密访问内容 | M6 |

### 2.7 统一登录 + 完整生态（M7）

| 功能 | 描述 | 里程碑 |
|---|---|---|
| OIDC 统一登录 | 一个 AAStar 账号，全生态通用 | M7 |
| 跨社区 xPNTs 桥接 | 不同社区积分互换 | M7 |
| Agent 市场 | Agent 注册、发现、评级 | M7 |
| 声誉经济 | 陪审、兑换、贡献综合声誉系统 | M7 |

---

## 3. 外部合约与依赖清单

MyShop 合约在运行时依赖以下外部合约。这些合约由 MyShop **读取或调用**，但不由 MyShop 部署或控制。

### 3.1 强依赖（部署时必须配置）

| 合约 | 来源 | 调用方式 | 用途 | 接口要求 |
|---|---|---|---|---|
| **AAStar Registry** | AAStar 生态 | 只读 | `hasRole(ROLE_COMMUNITY, addr)` 校验开店资格 | `IRegistry.hasRole(bytes32, address) → bool` |
| **CommunityNFT** | 社区自部署 | 写（调用 mint） | 购买时 mint NFT 凭证给买家 | `ICommunityNFT.mint(address to, string uri, bool soulbound) → uint256 tokenId` |
| **ERC-20 支付 Token** | 各 Token 合约 | 只读 + transferFrom | 接收买家付款（xPNTs / aPNTs / USDC 等） | 标准 `IERC20`（transferFrom + balanceOf） |

**Registry 地址**（Sepolia）：`0xD88CF5316c64f753d024fcd665E69789b33A5EB6`

### 3.2 弱依赖（可选，配置后启用）

| 合约 | 来源 | 调用方式 | 用途 | 何时需要 |
|---|---|---|---|---|
| **Action 合约** | 社区 / 协议部署，需白名单 | 外部调用 execute() | 购买后执行附加动作（发积分、触发事件等） | Item 配置了 `action` 字段时 |
| **EligibilityValidator** | 社区部署，需白名单 | 只读 validate() | 校验买家是否有购买资格（SBT 门控、声誉门控等）| M3+ Item 设置了资格门槛时 |
| **JuryAdapter → MyTask JuryContract** | MyTask 生态 | 写 | 争议仲裁任务创建和裁决回调 | M4 售后仲裁启用后 |

### 3.3 EIP-712 签名依赖（链下服务，合约只验签）

合约只验证签名的 **有效性和 nonce**，不关心签名由谁提供。以下是签名类型和参考实现：

| 签名类型 | 参考实现 | 合约验证内容 |
|---|---|---|
| **SerialPermit** | Worker `permitServer` | itemId + buyer + serialHash + nonce + deadline |
| **RiskAllowance** | Worker `permitServer` | shopOwner + maxItems + nonce + deadline |
| **EligibilityPermit**（M3+） | Worker 或 AAStar SDK server | buyer + itemId + conditions[] + nonce + deadline |

签名者地址在 MyShopItems 部署时配置（或 Shop 级别单独配置）。Worker 是参考实现，AAStar SDK 将来也可以提供同等能力的 server-side signer。

### 3.4 前端运行时的外部依赖

| 依赖 | 版本 | 用途 |
|---|---|---|
| `viem` | ^2.23.2 | 合约交互、EIP-712 签名构造、钱包连接 |
| `window.ethereum` | — | MetaMask / 注入式钱包（当前唯一登录入口） |
| Worker `permitServer` | 8787 | 获取 SerialPermit / RiskAllowance 签名 |
| Worker `apiServer` | 8788 | 查询 Shop / Item / Purchase 数据 |
| IPFS 网关 | 运行时配置 | NFT metadata 和图片加载 |

**前端 → SDK 的提炼路径**（未来方向）：
```
当前：frontend/src/main.js
    大型单文件，viem 直连合约，包含全部 UI + 合约调用逻辑

提炼后：@aastar/sdk 新增 MyShop 子包
    createMyShopClient(config)
        → buyItem(itemId, quantity, options)
        → listShops(filter)
        → listItems(shopId, filter)
        → getMyPurchases(buyer)
        → getItemEligibility(buyer, itemId)

前端 UI 继续存在，改为调用 SDK，不直接用 viem 构造合约调用
```

---

## 4. MyShop 对外提供的集成接口

**这是 MyShop 作为被集成方最核心的设计。**

### 3.1 合约接口层

```
IMyShopItems（核心 buy 接口）
  buy(itemId, quantity, recipient, extraData) → tokenId
  addItem(params) → itemId
  updateItem(itemId, params)
  pauseItem(itemId)

IMyShops（店铺注册接口）
  registerShop(params) → shopId
  updateShop(shopId, params)
  setFeeRate(shopId, bps)

IAction（动作模块标准接口——被 Action 实现）
  execute(buyer, recipient, itemId, shopId, quantity, extraData)

IEligibility（资格验证标准接口——被验证器实现）
  validate(buyer, itemId, shopId, quantity, extraData) → bool

ISerialSigner（串号签名标准接口——被 Worker 实现）
  signSerialPermit(itemId, buyer, serial) → (serialHash, signature)

IJuryAdapter（仲裁适配接口——对接 MyTask JuryContract）
  openDispute(purchaseId, evidenceUri) → disputeId
  resolveDispute(disputeId) ← 由 JuryContract 回调
```

### 3.2 事件层（被任何索引服务监听）

```
MyShopItems Events:
  Purchased(shopId, itemId, buyer, recipient, tokenId, serialHash, quantity, timestamp)
  ItemAdded(shopId, itemId, params)
  ItemUpdated(shopId, itemId, params)
  ItemPaused(shopId, itemId)
  DisputeOpened(purchaseId, buyer, evidenceUri)     ← M4
  DisputeResolved(purchaseId, decision, amount)      ← M4

MyShops Events:
  ShopRegistered(shopId, owner, communityAddress)
  ShopUpdated(shopId, params)
  ShopPaused(shopId)
```

### 3.3 Worker API 层（被前端/SDK/Agent 调用）

```
Permit Server（8787）— 任何服务可替换实现
  GET  /health
  GET  /serial-permit?itemId=&buyer=&serial=&deadline=&nonce=
  GET  /risk-allowance?shopOwner=&maxItems=&deadline=&nonce=
  POST /eligibility-permit（M3+）       ← 资格聚合签名

Query API（8788）— 被 SDK 和前端调用
  GET  /shops?page=&limit=&community=
  GET  /items?shopId=&category=&page=
  GET  /purchases?buyer=&shopId=&page=
  GET  /item/:itemId                     ← 含库存、兑换计数
  GET  /shop/:shopId                     ← 含统计数据
  GET  /buyer/:address/eligibility       ← M3+ 资格状态
  GET  /indexer                          ← 健康状态
  GET  /metrics
```

### 3.4 EIP-712 域（被任何 EIP-712 兼容 signer 实现）

```
Domain: { name: "MyShopItems", version: "1", chainId, verifyingContract }

Types:
  SerialPermit    { itemId, buyer, serialHash, nonce, deadline }
  RiskAllowance   { shopOwner, maxItems, nonce, deadline }
  EligibilityPermit（M3+）{ buyer, itemId, shopId, conditions[], nonce, deadline }
  DisputeEvidence（M4+）  { purchaseId, submitter, evidenceUri, timestamp }
```

---

## 4. 支付方式全覆盖设计

### 4.1 支付方式矩阵

| 支付方式 | 技术实现 | 适用场景 | 里程碑 |
|---|---|---|---|
| **xPNTs（社区专属积分）** | ERC-20 transferFrom | 主要兑换媒介 | M1 |
| **aPNTs（协议 utility token）** | ERC-20 transferFrom | 跨社区通用 | M1 |
| **USDC / USDT** | ERC-20 / EIP-3009 | 稳定价值商品 | M1 |
| **ETH（原生）** | msg.value | 通用兜底 | M1 |
| **WBTC / TBTC** | ERC-20 transferFrom | 高价值商品 | M1 |
| **Gasless（sponsored）** | SuperPaymaster | 用户无 gas 感知 | M2 |
| **EIP-3009 签名授权** | USDC permit | 无 approve 交互 | M2 |
| **x402 HTTP 支付** | SuperPaymaster x402 | API/内容访问 | M6 |
| **MicroPaymentChannel** | 链下 voucher + 链上结算 | 流式/订阅 | M6 |
| **跨链 USDC（CCTP）** | Chainlink CCTP | 多链用户 | M7 |

### 4.2 前端支付选择 UX

```
选择支付方式时，自动排序：
  1. 首选：xPNTs（如果余额足够）→ "用社区积分，推荐"
  2. 次选：aPNTs（如果 xPNTs 不足）→ "用协议积分"
  3. 其他：USDC > ETH > WBTC（按余额从多到少排）
  4. Gasless 标记：若 Shop 开启了 Paymaster，全程标注 "无手续费"
```

---

## 5. M1 当前功能完善清单

### 5.1 合约层改进（按优先级）

**P0 — 核心正确性**
- [ ] **库存/限购**：maxSupply（总量上限）+ perWallet（每人上限）+ startTime/endTime
- [ ] **Item 级 pause**：单个商品下架，不影响整个 shop
- [ ] **Shop pause 阻断 buy()**：shop 暂停后所有 Item 的 buy() 应 revert
- [ ] **quantity 批量购买的 Action 处理**：当前 Action.execute() 未处理 quantity > 1

**P1 — 功能完整性**
- [ ] **取消/退款窗口**：buy() 后 N 小时内可无条件取消（为 M4 Jury 打地基）
- [ ] **Shop treasury 提款函数**：owner 从合约 treasury 提取累计收入
- [ ] **协议 treasury 提款**：protocol admin 提取协议费
- [ ] **Item 编辑**：上架后可修改 price/tokenURI/actionData（但不能改 shopId/nftContract）
- [ ] **批量上架**：一次 tx 上架多个 Item（节省 gas）

**P2 — 可观测性**
- [ ] **购买计数**：每个 Item 的已兑换数量（链上 mapping，方便前端展示）
- [ ] **Shop 统计**：总成交额、总成交数（链上聚合或 Worker 索引）

### 5.2 Worker 层改进

**P0 — 可靠性**
- [ ] **indexer 持久化可靠性验证**：模拟重启，确认数据零丢失
- [ ] **nonce 持久化**：SerialPermit nonce 跨重启一致（写入 levelDB 或 SQLite，不只是 JSON）
- [ ] **签名服务不可用告警**：前端 /health 检查失败时展示友好提示

**P1 — 功能完整性**
- [ ] **购买记录聚合 API**：`/purchases?buyer=` 按买家查询，含 Item 元数据 enrich
- [ ] **Shop 统计 API**：`/shop/:id/stats` 成交量、收入、活跃用户数
- [ ] **Webhook 重试队列**：投递失败自动重试，记录失败日志
- [ ] **多 Shop 独立签名配置**：不同 shop 可以有不同的 serial signer

**P2 — 运维**
- [ ] **Metrics 丰富化**：请求量、签名延迟、索引延迟（Prometheus 格式）
- [ ] **日志结构化**：JSON 格式日志，方便接入告警系统

### 5.3 前端层改进

**P0 — 缺失的核心页面**

- [ ] **Item 详情页**（`#/item/:itemId`）
  - NFT 图片/元数据预览
  - 价格 + 支持的支付方式
  - 库存：剩余 XX / 总量 XX
  - 限购：我已兑换 X / 限 X 件
  - 购买资格：绿色✅ 可兑换 / 红色❌ 原因说明
  - 最近兑换记录（地址 + 时间）
  - 兑换按钮 + 支付选择

- [ ] **买家"我的权益"页**（`#/my`）
  - 我持有的全部 NFT 凭证（来自 Purchased 事件）
  - 按 Shop / 时间排序
  - 每条记录：Item 名、时间、tx hash、当前状态
  - M4 后：纠纷入口

- [ ] **Shop 主页**（`#/shop/:shopId`）
  - Shop 基本信息（名称、简介、社区）
  - Item 列表（带库存状态）
  - Shop 统计（成交量等）

**P0 — 购买流程体验**

- [ ] **购买状态完整状态机**
  ```
  初始 → 检查余额/资格 → 请求 SerialPermit → approve ERC20 → 提交 tx
    → 等待上链（pending + tx hash 展示）
    → 确认（成功动画 + 得到的 NFT 展示）
    / 失败（revert 原因翻译 + 建议操作）
  ```
- [ ] **Revert 原因友好翻译**
  - `InsufficientBalance` → "余额不足，需要 500 xPNTs"
  - `ExceedsPerWallet` → "已达到个人兑换上限"
  - `ItemPaused` → "该兑换品暂时下架"
  - `ShopPaused` → "该兑换站暂时关闭"

**P1 — 体验优化**

- [ ] **加载骨架屏**：数据加载时的占位动画
- [ ] **网络状态提示**：Worker 不可用时前端友好提示
- [ ] **移动端响应式布局**：兑换场景多在手机
- [ ] **IPFS 图片加载优化**：多网关 fallback，超时切换
- [ ] **深色模式**
- [ ] **兑换成功分享卡片**：分享到社交媒体

**P2 — 管理员体验**

- [ ] **店主数据看板**：成交量图表、收入趋势、热门 Item
- [ ] **Item 批量操作**：批量上下架、批量改价
- [ ] **收益提取 UI**：显示可提取余额，一键提取

---

## 6. M4 售后仲裁详细设计

### 6.1 与 MyTask JuryContract 的关系

**原则：共用 MyTask JuryContract，MyShop 只做 Adapter。**

```
MyShop 侧（新增）:
  DisputeEscrow.sol       管理争议资金的托管与释放
  JuryAdapter.sol         桥接 MyShopItems 和 MyTask JuryContract

MyTask 侧（直接复用，不 fork）:
  JuryContract.sol        陪审员注册、投票、共识计算、奖励分配
  ERC-8004 Registry       陪审员声誉积累
```

### 6.2 争议金额模型

```
兑换成功时：
  shopTreasury += (amount - protocolFee)
  protocolTreasury += protocolFee

争议发起时：
  DisputeEscrow.lock(purchaseId, amount)
  ← 从 shopTreasury 临时扣除 amount（不动 protocolFee）

裁决为支持买家时：
  退还 buyer: amount × 90%（扣除 10% 作为陪审员奖励池）
  陪审员奖励池: amount × 10%（由 JuryContract 按投票权重分配）
  protocolFee: 不退（服务已提供）

裁决为支持店主时：
  释放给 shopTreasury: amount（全额恢复）
  陪审员奖励池: 从协议费中拨出（激励陪审积极性）
```

### 6.3 需要与 MyTask 协调的接口问题

MyTask JuryContract 当前设计是针对"任务验证"的，用于兑换纠纷需要确认：
- 是否支持"通用仲裁"任务类型（不绑定 agentId）
- JuryAdapter 的 `resolveDispute()` 回调接口是否标准化
- 陪审员奖励 token 是否统一使用 xPNTs / aPNTs

---

## 7. 可观测性设计

### 7.1 关键指标

| 指标 | 类型 | 告警阈值 |
|---|---|---|
| 兑换成功率 | 业务 | < 95% 告警 |
| SerialPermit 响应时间 | 性能 | > 500ms P99 |
| Worker API 响应时间 | 性能 | > 200ms P99 |
| 索引延迟（区块 lag） | 可靠性 | > 10 blocks |
| 签名服务可用性 | 可靠性 | < 99.9% 告警 |
| 每日兑换量 | 业务 | —（趋势监控） |
| 争议率 | 业务 | > 5% 告警 |

### 7.2 事件追踪

每笔兑换应生成完整的事件链：
```
purchaseId → {
  initTime: 用户点击兑换时间
  permitTime: SerialPermit 获取时间
  submitTime: tx 提交时间
  confirmTime: tx 确认时间
  totalDuration: 全程耗时
  gasCost: 实际 gas（M2 后对用户不可见）
  result: success/failed/disputed
}
```

---

## 8. 开放问题（待决策）

1. **兑换冷静期时长**：7 天？3 天？需要平衡买家保护 vs 店主资金流转
2. **JuryContract 接口协调**：需要与 MyTask 确认通用仲裁接口设计
3. **陪审员最低质押量**：统一参数还是 Shop 级别可配置
4. **M1 与 M2 合约接口兼容**：buy() 增加 paymaster 路径时，是新增函数还是重载参数
5. **前端架构**：main.js 是否现在拆分，还是在 M2 重构时一起做
6. **IPFS Pin 责任**：Shop 上架的 NFT 元数据，由 Protocol、Shop 还是专用 Pin 服务负责持久化
7. **多链部署策略**：先 Sepolia → OP Sepolia → OP Mainnet，还是直接主网

---

## 9. 里程碑总览

| 里程碑 | 核心目标 | 验收标准 |
|---|---|---|
| **M1（当前）** | 基础兑换完整可靠 | 三角色完整闭环；Worker 重启数据不丢失 |
| **M2** | Gasless + 智能钱包 | 新用户无 MetaMask 无 ETH 完成第一笔兑换 |
| **M3** | 忠诚体系 | 兑换后自动得积分；SBT 门控专属品 |
| **M4** | 售后仲裁 | 争议全程链上可追溯；7 天内自动裁决 |
| **M5** | Agent + 订阅 | Agent 自动执行兑换；订阅类 Item 自动续兑 |
| **M6** | 数字商品 + 支付通道 | x402 API 访问权限；流式付费 Item |
| **M7** | 完全生态 | OIDC 登录；跨社区积分；Agent 市场 |

---

*下一步：先按 M1 完善清单逐项实现，所有 P0 项完成后再推进 M2 设计详化。*
