# 架构与模块说明

## 目标

MyShop 把“链下风控/串号/通知”等能力拆成可替换的模块，同时把“收款、分润、发 NFT、执行动作(Action)”收敛为链上一次原子交易完成。

## 模块边界

### On-chain（合约）

- **Registry**：社区准入来源（`ROLE_COMMUNITY`）。
- **MyShops**：Shop 注册与协议级配置（上架费、协议费率、协议金库）。
- **MyShopItems**：商品上架与购买原子执行中心；包含风控签名与串号签名校验；包含 Action 白名单。
- **CommunityNFT**：实际发券（SBT/Transferable/Hybrid 由 NFT 合约自己实现；MyShop 只调用 mint）。
- **Action 合约**：购买时执行的可组合能力（例如送积分、发事件等）。

### Off-chain（服务/应用）

- **风控签名服务（RiskAllowance）**：用于在链上默认限制之外，按风控策略放宽某 shop 的 item 上限。
- **串号签名服务（SerialPermit）**：用于“先产生串号/订单，再允许购买”的 Mode A 流程。
- **MyShop Worker**：监听购买事件 → 通知（Webhook/Telegram）；也可承载签名 API（Permit Server）。

## 数据流与控制流

### addItem（上架）

1. Shop owner 准备 `AddItemParams`。
2. 若要突破默认 item 上限：链下风控签名服务签 `RiskAllowance`。
3. 上架时合约收取上架费（ERC20），转入协议金库。

### buy（普通购买）

1. Buyer 先准备 `extraData`：
   - requiresSerial=true 时：需要链下串号服务签 `SerialPermit`，并把 `(serialHash,deadline,nonce,signature)` ABI 编码进 `extraData`。
   - `SerialPermit` EIP-712 结构体包含 `recipient` 字段，签名时锁定 NFT 接收地址。
2. 合约校验 permit + nonce 未使用。
3. 合约按 `platformFeeBps` 拆分协议费与店铺收入并转账。
4. 合约 mint NFT；再调用 action 合约 `execute(...)` 完成可组合逻辑。

### buyGasless（ERC-4337 AA 购买）

适用于 AA 钱包（账户抽象）场景：`msg.sender` 是 Bundler/EntryPoint 或智能钱包，实际经济主体（EOA）通过 `payer` 参数标识。

```
buyGasless(itemId, quantity, recipient, payer, extraData)
```

- `payer = address(0)`：等效于普通 buy，`msg.sender` 既是付款人也是身份
- `payer != address(0)`：`payer` 作为 SerialPermit 的 buyer 身份；付款来自 `msg.sender`（AA 钱包）
- `recipient`：NFT 接收地址（必须与 SerialPermit 签名中的 `recipient` 一致）

> **安全设计**：见 [gasless 与 SerialPermit 安全设计](gasless-and-serial-permit.md)

## Event 作为 Shop Item（活动门票 / 报名凭证）

把“活动发布 / 参与报名 / 发入场凭证”视为一类标准商品，直接映射为：

- **一个活动（Event）= 一个 Shop**
  - 由活动所属社区/主办方注册 shop，并把 shop 的 metadataHash / off-chain 页面作为活动主页索引。
- **一个票种/报名档位 = 一个 Item**
  - item 的 `unitPrice + payToken` 表达“用什么资产购买/报名”。
  - item 的 `tokenURI` 表达“活动票/报名凭证的元数据入口”（可指向活动页、票种页、IPFS 元数据等）。
  - item 的 “说明页版本化” 可把活动页当作可迭代、可追溯的展示页面（见 shop_management.md 的 Item Page 章节）。

这样，购买即完成：

- 费用拆分与结算（协议费/店铺收入）
- 发放门票 NFT（SBT/普通 NFT/混合模式由 NFT 合约实现）
- 执行扩展动作（例如发积分、发事件、触发链下派发）

## 社区自部署 NFT 合约接入（每个社区一个或多个 NFT 合约）

当前 MyShopItems 对 NFT 合约的集成方式是“面向最小 mint 接口”：

- 每个 item 通过 `nftContract` 指向任意 NFT 合约地址（可以是社区自己部署的合约）。
- MyShop 在购买时只调用 `mint(to, uri, soulbound) -> tokenId`，不假设它是 ERC721/1155 的哪一种实现。

因此：

- **支持 shop item 发 NFT**：上架时配置 `nftContract/tokenURI/soulbound`。
- **支持 event NFT**：event 本质是 item；event 页面用 `tokenURI` 与 item page 机制表达；buy() 时 mint 即发票。
- **SBT / 纯 NFT / 混合模式**：
  - `soulbound` 标记会被传给 NFT 合约，是否“真的不可转让”由 NFT 合约自身 enforce。
  - “混合模式”可理解为：mint NFT 的同时再执行 action（例如送 ERC20、发事件、触发链下凭证发放）。

## 购买资格/Attestation 扩展（可插拔验证，可多重组合）

IFT 是 NFT 的 typo；若把“是否允许购买某活动票/报名”看作 Eligibility（资格校验），推荐把它设计成可插拔模块，并支持多重校验组合，例如：

- 必须是 endorser（或持有某角色）
- 必须社区 reputation ≥ 阈值
- 必须 global reputation ≥ 阈值
- 必须通过某外部 attestation 合约的验证函数

建议落两种可并行的扩展路径：

### 路径 A：On-chain 外部验证器（强一致，配置灵活）

- 定义一个标准接口（示意）：
  - `validate(buyer, recipient, itemId, shopId, quantity, extraData) -> (bool)` 或直接 `revert` 表示失败
- 在 MyShopItems 中为 shop 或 item 维护 `validators[]`（可多个），buy() 时逐个调用验证器。

特点：

- 优点：资格判断 100% 链上可复现，可插拔/可组合/可审计。
- 缺点：每次购买会有额外外部调用，gas 成本更高；验证器设计需谨慎避免重入/状态污染。

### 路径 B：Off-chain 聚合证明（省 gas，适合复杂策略）

- 由“资格服务/策略引擎”对多规则（endorse、reputation、外部 attestation）做聚合判断后，签一个 EIP-712 的 `EligibilityPermit`。
- buy() 时只验证该签名（类似现有的 SerialPermit/RiskAllowance 模式）。

特点：

- 优点：链上只做签名验证，gas 稳定；复杂策略可以快速迭代。
- 缺点：信任边界在签名者；需要治理/审计签名者的权限与策略。

## 推荐的演进路线

- **短期**：先用 Worker 提供 Permit API + 通知能力，快速把“购买后通知/落库/发串号”闭环跑通。
- **中期**：把 Risk/Serial 的签名端拆成独立服务，Worker 只负责监听与转发。
- **长期**：把 Action 的类型扩展为更多标准模块（积分、白名单门票、订阅、权益领取等）。
- **扩展**：引入 Eligibility（资格）模块，支持 Event 门票的多重门槛与可配置策略。

## IPFS 网关与 Pin 服务（去中心化设计）

- 目标：长期稳定可用的内容寻址能力，支持多方共同维护与冗余备份
- 架构建议：
  - 网关：多节点 `go-ipfs` 开启 HTTP Gateway；前置 Nginx/HAProxy 做健康检查与负载均衡
  - Pin 编排：使用 IPFS Cluster，设置副本数（Replication Factor ≥ 2），多维护者各自运行 Cluster peer
  - 存储：允许挂载本地磁盘与对象存储（S3 兼容），按类别与项目分命名空间
  - 监控：Prometheus + Grafana（节点可用性、Pinned 对象数量、网关响应延迟、错误率）
  - 审计：定期对关键 CID 执行可达性与完整性验证（对比多网关返回大小与哈希）
- 前端集成：
  - 运行时配置 `IPFS_GATEWAY`（支持自定义域），统一把 `ipfs://` 转换为 `https://<gateway>/ipfs/...`
  - 类别元数据中存放 `*Ipfs` 链接；前端“查看文档”按钮直接打开
- 运维分工：
  - 平台：维护 Cluster 管理与核心节点
  - 社区/店主：各自运行 peer，提供额外副本与带宽
  - CI：新文档发布自动 Pin 指定 CID，并写入环境覆盖 `MYSHOP_CATEGORIES_JSON`

### 网关与节点运行（参考方案）

- 基础要求：
  - 服务器：2 核 CPU / 4GB+ 内存 / 200GB+ SSD（按文档体量扩容）
  - 网络：稳定的上行/下行带宽，开放网关端口（默认 8080/5001 可自定义）
  - 存储：本地挂载数据目录（如 `/var/ipfs`），备份到对象存储（可选）
- 运行 go-ipfs（Docker 简例）：
  - 拉取镜像并初始化：`ipfs init`（容器内）或挂载已有仓库
  - 开启网关：设置 `Gateway.Enabled=true` 与 `Gateway.PublicGateways`（支持多域名）
  - 反向代理：Nginx/HAProxy 健康检查，转发到多个 IPFS 网关节点
- 运行 IPFS Cluster（多节点）：
  - 部署 cluster-service 与 cluster-ctl，指定 peers 列表与 `replication_factor_min/max`
  - 将核心文档与页面 CID 加入 Pin 列表；社区与店主节点加入后自动副本扩展
  - 定期执行 `cluster-ctl status <CID>` 验证副本状态

> 注意：我们把网关/Cluster 方案作为独立运维组件，MyShop 前端只依赖其可用性（运行时配置网关域名），不耦合具体实现。你可以选择裸机、Docker 或 Kubernetes 部署。

### Docker Compose（Kubo + Cluster + Nginx/HAProxy）

```yaml
version: "3.8"
services:
  ipfs:
    image: ipfs/kubo:latest
    restart: unless-stopped
    volumes:
      - ./data/ipfs:/data/ipfs
    ports:
      - "5001:5001" # API
      - "4001:4001" # Swarm
      - "8080:8080" # Gateway (内部使用)
    environment:
      - IPFS_PROFILE=server

  cluster:
    image: ipfs/ipfs-cluster:latest
    restart: unless-stopped
    depends_on:
      - ipfs
    volumes:
      - ./data/cluster:/data/ipfs-cluster
    environment:
      - CLUSTER_PEERNAME=node1
      - CLUSTER_SECRET=<shared-secret>
      - CLUSTER_IPFSHTTP_NODEMULTIADDRESS=/ip4/ipfs/tcp/5001
      - CLUSTER_REPLICATIONFACTORMIN=2
      - CLUSTER_REPLICATIONFACTORMAX=4
    ports:
      - "9094:9094" # API

  gateway:
    image: nginx:stable
    restart: unless-stopped
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - ipfs
    # nginx.conf 反向代理到多个 ipfs 节点的 8080 端口，并带健康检查
```

> 提示：生产环境建议多机部署，`gateway` 反向代理到多个 `ipfs`/`cluster` 实例；将证书与密钥、安全配置移出 Compose，并启用监控与审计。
