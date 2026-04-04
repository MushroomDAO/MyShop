# 验收指南（MyShop）

本指南面向新入职的产品经理，帮助你初始化、部署并按设计验证 MyShop 的功能，所有涉及文件均要求使用 IPFS 存储。阅读本指南与链接文档后，你应能独立完成环境搭建、功能验收与问题反馈。

## 一、前置条件

- 开发环境：Node.js 18+、pnpm 8+
- 以太坊网络：本地 Anvil 或测试网（推荐 Sepolia）
- IPFS：可用的网关或 Pin 服务（例如 web3.storage、Pinata）
- 钱包：用于店主操作与买家测试的钱包（建议使用两个账户）

## 二、代码与模块

- 前端（店主控制台与买家页面）：`frontend/`
- 后端 Worker（Permit、类别与监控）：`worker/`
- 合约（商品、店铺、动作）：`contracts/`
- 设计与方案说明：[Solution.md](./Solution.md)
- 变更记录：[CHANGELOG.md](./CHANGELOG.md)

## 三、配置与环境

- 前端配置（通过页面“配置”项或环境变量）
  - `VITE_RPC_URL`、`VITE_CHAIN_ID`
  - `VITE_ITEMS_ADDRESS`、`VITE_SHOPS_ADDRESS`
  - `VITE_ITEMS_ACTION_ADDRESS`（MintERC20Action）
  - `VITE_ERC721_ACTION_ADDRESS`（MintERC721Action）
  - `VITE_ERC721_DEFAULT_TEMPLATE_ID`（默认模板 ID）
  - `VITE_WORKER_URL`（Permit 服务 base）与 `VITE_WORKER_API_URL`（查询 API base）
  - `VITE_IPFS_GATEWAY`（自定义 IPFS 网关域名，统一转换 ipfs:// 链接）

- Worker 环境变量（`worker/src/index.js`）
  - `MODE=both`（同时启动监控与 Permit 服务）
  - `DEPLOYMENT` 或 `RPC_URL`、`CHAIN_ID`、`ITEMS_ADDRESS`
  - `SERIAL_SIGNER_PRIVATE_KEY`、`RISK_SIGNER_PRIVATE_KEY`（用于签发 Permit）
  - `PORT`（Permit 端口；默认 8787）
  - `ENABLE_API=1`、`API_PORT=8788`（启用查询 API）
  - `MYSHOP_CATEGORIES_JSON`（平台类别元数据，需包含 IPFS 文档链接）

## 四、IPFS 要求

- 若使用 IPFS：`tokenURI` 与 `ItemPage.uri` 使用 `ipfs://...`；并配置 `VITE_IPFS_GATEWAY`
- 若使用中心化：`tokenURI` 可为 `http(s)://...`；无需配置网关，原有流程保持正常
- 类别元数据中的 `*Ipfs` 字段为可选；提供时将在前端展示链接，未提供则不展示

## 五、启动与基本操作

1. 启动前端
   - `pnpm -C frontend dev`（Vite 开发）
   - 打开配置页，填入上述配置；点击“Save & Apply”

2. 启动 Worker
   - `node worker/src/index.js`（读取环境变量并启动服务）
   - 验证路由：
     - `GET /health`、`GET /config`、`GET /categories`、`GET /serial-permit-demo`

3. 运行 IPFS 网关与 Cluster（参考）
   - go-ipfs：使用 Docker 或裸机部署，开启 HTTP Gateway 与本地存储目录（例如 `/var/ipfs`）
   - 负载均衡：前置 Nginx/HAProxy；健康检查后转发到多个网关节点
   - IPFS Cluster：部署 cluster-service 与 cluster-ctl，设置副本数（≥2），把关键文档 CID 加入 Pin 列表
   - 前端配置：在“配置”页填写 `IPFS_GATEWAY` 自定义域名（例如 https://gw.community.org）

3. 店主后台（Add Item 面板）
   - 使用模板按钮或“类别下拉+应用类别”快速填充字段
   - MintERC20/MintERC721 生成器生成 `actionData`
   - 必要时设置默认 `templateId` 以加速 NFT+NFT（按模板）流程
   - 验证 IPFS 网关：点击“查看文档”，确保 IPFS 链接通过自定义网关正确打开
   - 若不使用 IPFS：直接填写 `http(s)://` 的 `tokenURI` 与页面链接，流程照常

## 六、功能验收流程

1. 模板与类别
   - 点击“加载类别”，从 Worker 拉取平台类别（含 IPFS 文档链接）
   - 选择类别并“应用类别”，确认字段被锁定（不可修改，shop 继承）
   - 点击“查看文档”，确认 Docs/README/Architecture/Template 四类链接均可通过配置的网关访问
   - 在多网关场景下，确认主/备网关均可达（切换 `IPFS_GATEWAY` 测试）

2. NFT+积分卡
   - 配置 `ITEMS_ACTION_ADDRESS` 指向 `MintERC20Action`
   - 通过生成器构造 `actionData`，上架商品并购买

3. NFT+NFT（按 URI）
   - 配置 `ERC721_ACTION_ADDRESS` 指向 `MintERC721Action`
   - 使用 `tokenURI` 生成 `actionData`，购买后验证二次铸造

4. NFT+NFT（按模板）
   - 设置默认 `templateId` 或手填
   - 使用按钮“一键生成 actionData”，购买后验证二次铸造

5. 实物/电子产品（串号 Permit）
   - 在 Worker 页面 `/serial-permit-demo` 生成 `extraData`
   - 前端 Buy 栏填入 `extraData` 后购买，验证串号签名与记录

## 角色引导路径总览（按角色）

- 协议运营方（治理者）
  - 页面：`#/protocol-console`
  - 路径：读取配置（G-01）→ 修改费率/金库/上架费（G-02/G-03/G-04）→ 动作白名单 allow/deny（G-05）
  - 期望：读写成功；deny 后购买 revert，allow 后购买成功；暂停后购买失败

- 店铺运营者（Shop Owner/Operator）
  - 页面：`#/shop-console`
  - 路径：注册 Shop（S-01）→ 授权 operator（S-04）→ 上架普通 Item（I-01）→ 上架需要串号的 Item（I-02）→ 下架 Item（I-04）
  - 期望：计数与页面可见性变化正确；串号商品无 permit 购买失败；下架后购买失败

- 买家（Buyer）
  - 页面：`#/buyer`
  - 路径：ERC20 购买（B-01）→ 串号购买（B-02）→ 过期（B-03）→ 重放（B-04）→ 参数不匹配（B-05）→ 店铺暂停（B-06）→ 动作被 deny（B-07）
  - 期望：成功/失败行为与日志符合预期；Worker 查询能看到 enrich 的记录

- 运维/社区节点（IPFS 网关与 Pin 服务，选配）
  - 文档：`docs/ipfs-gateway.md`、`docs/architecture.md`
  - 路径：部署 Kubo/Cluster/Nginx/Ingress → Pin 文档 CID → 前端配置 IPFS_GATEWAY → “测试网关”探测主/备 → 类别文档链接打开验证
  - 期望：主/备网关可达；CID 能打开；回退到 http(s) 时不影响原流程

## 八、故障定位与反馈

- 前端报错：查看页面底部 `txOut` 与 `buyFlowOut`，以及浏览器 Console/Network
- Worker 报错：查看启动终端输出与 `/metrics` 指标
- 合约错误：重点关注 `ActionNotAllowed`、`SerialRequired`、`InvalidPayment` 等错误码
- 反馈格式建议：问题概述、复现步骤、期望行为、实际日志（含请求与响应片段）、环境配置（脱敏）

## 九、参考链接（IPFS/代码）

- 合约与前端关键代码：
  - 前端配置与模板：[main.js](file:///Users/jason/Dev/crypto-projects/MyShop/frontend/src/main.js)
  - 前端环境读取：[config.js](file:///Users/jason/Dev/crypto-projects/MyShop/frontend/src/config.js)
  - Worker 启动与路由：[index.js](file:///Users/jason/Dev/crypto-projects/MyShop/worker/src/index.js)、[permitServer.js](file:///Users/jason/Dev/crypto-projects/MyShop/worker/src/permitServer.js)
  - 商品合约（Item/页面/购买）：[MyShopItems.sol](file:///Users/jason/Dev/crypto-projects/MyShop/contracts/src/MyShopItems.sol)
  - 动作合约（ERC721）：[MintERC721Action.sol](file:///Users/jason/Dev/crypto-projects/MyShop/contracts/src/actions/MintERC721Action.sol)

- 文档与方案：
  - 方案说明：[Solution.md](file:///Users/jason/Dev/crypto-projects/MyShop/docs/Solution.md)
  - 变更记录：[CHANGELOG.md](file:///Users/jason/Dev/crypto-projects/MyShop/docs/CHANGELOG.md)

> 注意：请将本验收文档与关联的 README/Architecture 文档上传至 IPFS，并在 `MYSHOP_CATEGORIES_JSON` 中配置对应的 `docsIpfs/readmeIpfs/architectureIpfs`，以供前端/运营人员统一访问。

## 十、测试用例与回归入口

- 完整用例与命令模板：[test_cases.md](file:///Users/jason/Dev/crypto-projects/MyShop/docs/test_cases.md)
- 一键本地回归（部署 + Worker + 购买 + 查询 + 前端 E2E）：
  - `pnpm -C worker regression`
  - 或 `./flow-test.sh`
- 仅前端构建与 E2E：`pnpm -C frontend regression`

## 十一、常见错误与排查速查表

- 前端页面
  - 症状：无法购买、按钮不可用、页面报错
  - 检查：`#/config` 是否完整；钱包是否连接；角色是否匹配（建议先在 `#/roles` 做 Access Check）
  - 购买失败常见错误码：`ActionNotAllowed`、`SerialRequired`、`InvalidPayment`、`Paused`
  - 浏览器 Console/Network：确认请求地址与链 ID；用“测试网关”按钮验证 IPFS 主/备可达性
  - 参考：前端配置与模板逻辑 [main.js](file:///Users/jason/Dev/crypto-projects/MyShop/frontend/src/main.js)、环境读取 [config.js](file:///Users/jason/Dev/crypto-projects/MyShop/frontend/src/config.js)

- Worker/API
  - 症状：/health 或 /config 不通、/serial-permit-demo 报错
  - 检查：环境变量是否正确（`MODE`、`RPC_URL`、`CHAIN_ID`、`ITEMS_ADDRESS`、`ENABLE_API`）；端口占用；私钥是否存在且权限安全
  - 命令：`curl -sS "$WORKER_URL/health"`、`curl -sS "$WORKER_API_URL/config"`
  - 类别文档：`MYSHOP_CATEGORIES_JSON` 是否包含 IPFS 链接（可选）；缺省时前端不展示链接
  - 参考：启动与路由 [index.js](file:///Users/jason/Dev/crypto-projects/MyShop/worker/src/index.js)、[permitServer.js](file:///Users/jason/Dev/crypto-projects/MyShop/worker/src/permitServer.js)

- 合约与链
  - 症状：交易 revert 或读不到配置
  - 检查：链 ID 与 RPC 是否一致；部署输出地址是否写入前端配置；角色/白名单是否正确
  - 命令：`cast call --rpc-url "$RPC_URL" "$SHOPS_ADDRESS" "owner()(address)"`、`shopCount()`、`itemCount()`
  - 购买错误常见原因：店铺暂停、Action 不在白名单、付款资产/数量错误、串号签名参数不匹配/过期/重放

- IPFS 网关/Pin
  - 症状：ipfs:// 链接无法打开、部分网关超时
  - 检查：`VITE_IPFS_GATEWAY` 是否配置；点击“测试网关”查看可达性；确认 CID 已 Pin（Cluster `status`）
  - CORS/TLS：反向代理需开启 80/443；Ingress/Nginx 超时需增大；证书有效期与域名匹配
  - 回退策略：不使用 IPFS 时改用 http(s)；流程照常运行
  - 参考：IPFS 独立文档与部署示例 [ipfs-gateway.md](file:///Users/jason/Dev/crypto-projects/MyShop/docs/ipfs-gateway.md)、架构模板 [architecture.md](file:///Users/jason/Dev/crypto-projects/MyShop/docs/architecture.md)

- ENS（可选，加分项）
  - 症状：域名打不开或未解析到内容
  - 检查：resolver 与 `contenthash` 是否设置；发布页面后是否更新到最新 CID；等待解析生效
  - 回退策略：未配置 ENS 时使用常规域名与路径
  - 参考：ENS 独立文档 [ens.md](file:///Users/jason/Dev/crypto-projects/MyShop/docs/ens.md)

---

# M1 里程碑验收用例（v0.2.0-M1，按角色）

> 本节为 M1（C1–C11 / W1–W7 / F1–F8）的完整角色化验收指导。  
> 每个角色提供：前置条件、验收步骤、预期结果。  
> 基础环境已在"前置条件"一节说明（Anvil 本地 + 已部署合约 + Worker 运行）。

---

## 角色一：协议管理员（Protocol Admin / Protocol Owner）

**身份**：`MyShopItems.owner` 与 `MyShops.owner`，合约部署者。  
**入口页面**：`#/protocol-console`

### P-01 — 查看协议配置

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 打开 `#/protocol-console`，点击"Read Protocol Config" | 显示 platformTreasury、platformFeeBps（默认 300）、listingFee（0 或已设值）、riskSigner、serialSigner |

### P-02 — 修改平台费率

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 在"Set Protocol Fee"填入 `200`（即 2%），点击 Set | 交易成功，再次 Read Config 显示 200 |
| 2 | 重新购买一次商品 | 手续费按 2% 计算，shopTreasury 收到 98%，platformTreasury 收到 2% |

### P-03 — 动作白名单管理（setActionAllowed）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 将某 action 地址设置为 `allowed=false` | 对该 action 上架新 item 时报 `ActionNotAllowed` |
| 2 | 重新设置为 `allowed=true` | 可正常上架 |

### P-04 — 资质验证器白名单（setValidatorAllowed，C10）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 部署一个实现 `IEligibilityValidator` 接口的合约 | 合约部署成功 |
| 2 | 调用 `setValidatorAllowed(addr, true)` | 交易成功 |
| 3 | 创建一个 eligibilityValidator=addr 的 item | 成功 |
| 4 | 创建 eligibilityValidator=未白名单addr 的 item | 报 `ValidatorNotAllowed` |

### P-05 — 协议资金救援（rescueETH / rescueERC20，C8）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 向合约发送少量 ETH（测试用） | 合约余额增加 |
| 2 | 调用 `rescueETH(to=owner)` | ETH 转出，合约余额归零 |
| 3 | 向合约发送 ERC20（测试 token） | 合约 token 余额增加 |
| 4 | 调用 `rescueERC20(token, to=owner)` | ERC20 转出 |

### P-06 — 提取 Shop 余额（withdrawShopBalance，C7）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 用协议管理员钱包调用 `withdrawShopBalance(shopId=1, token=USDC)` | 合约中该 token 全额转入 shopTreasury，emit ShopBalanceWithdrawn |
| 2 | 用非 owner 地址调用同函数 | 报 `NotShopOwner`（owner-only） |

### P-07 — 兑换冷静期配置（setDisputeWindowSeconds，C11）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 调用 `setDisputeWindowSeconds(3 days)` | 成功 |
| 2 | 调用 `setDisputeWindowSeconds(91 days)` | 报错（超过 MAX_DISPUTE_WINDOW=90 days） |
| 3 | 购买一个 item，查询 `isInDisputeWindow(purchaseId)` | 在 3 天内返回 true；warp 3 天后返回 false |

---

## 角色二：社区 Admin（Community Admin）

**身份**：在 AAStar Registry 持有 `ROLE_COMMUNITY` 角色，可注册 Shop。  
**入口页面**：`#/shop-console`（注册后）

### C-01 — 注册 Shop

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 打开 `#/shop-console`，填入 treasury 地址与 metadataHash，点击 Register | 交易成功，shopCount 加 1 |
| 2 | 用非 ROLE_COMMUNITY 地址注册 | 报 `NotCommunity` |

### C-02 — 设置 Shop Roles（授权 operator）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 填入 operator 地址，勾选 itemEditor + itemMaintainer + itemActionEditor，点击 Set Roles | 成功 |
| 2 | 切换到 operator 钱包，进入 `#/shop-console`，点击 Check Access | 显示 rolesMask 非零，有对应角色位 |

### C-03 — 暂停/恢复 Shop（C4）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 调用 `setShopPaused(shopId, true)` | Shop 暂停 |
| 2 | 买家尝试购买该 Shop 的 item | 报 `ShopPaused` |
| 3 | 调用 `setShopPaused(shopId, false)` | 购买恢复正常 |
| 4 | 暂停后尝试 addItem | 报 `ShopPaused` |

---

## 角色三：Shop 店主（Shop Owner / Operator）

**身份**：已注册 Shop 的 community 地址，或被授权 ROLE_ITEM_EDITOR 的 operator。  
**入口页面**：`#/shop-console`

### S-01 — 上架普通 Item（无约束）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 填写 payToken=USDC、unitPrice=1000、nftContract、tokenURI、maxSupply=0、perWallet=0 | 成功，itemCount 加 1 |
| 2 | 买家购买 3 次 | 均成功（无限量） |

### S-02 — 上架限量 Item（C1 maxSupply）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 上架 maxSupply=3 的 item | 成功 |
| 2 | 买家购买 3 次 | 成功，soldCount=3 |
| 3 | 买家再购买 1 次 | 报 `ExceedsMaxSupply` |

### S-03 — 上架限钱包 Item（C1 perWallet）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 上架 perWallet=2 的 item | 成功 |
| 2 | buyer 购买 recipient=A 2次 | 成功，walletPurchaseCount[A]=2 |
| 3 | buyer 再购买 recipient=A 1次 | 报 `ExceedsPerWallet` |
| 4 | buyer 购买 recipient=B 2次 | 成功（B 独立计数） |

### S-04 — 上架时间窗口 Item（C2）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 上架 startTime=now+1h，endTime=now+2d | 成功 |
| 2 | 立即购买 | 报 `NotYetAvailable` |
| 3 | warp 1h 后购买 | 成功 |
| 4 | warp 2d 后购买 | 报 `SaleEnded` |

### S-05 — Item 级暂停（C3）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 调用 `pauseItem(itemId, true)` | Item paused=true，emit ItemPaused |
| 2 | 买家购买 | 报 `ItemPausedError` |
| 3 | 调用 `pauseItem(itemId, false)` | 购买恢复 |
| 4 | 非 shopOwner 调用 pauseItem | 报 `NotShopOwner` |

### S-06 — 更新 Item（C9）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 修改 unitPrice、tokenURI、maxSupply（不低于已售量） | 成功，getItem 读出新值 |
| 2 | 设置 maxSupply 低于 soldCount | 报 `ExceedsMaxSupply` |

### S-07 — 版本化 ItemPage

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | addItemPageVersion(itemId, uri_v1, hash_v1) | version=1，defaultPageVersion=1 |
| 2 | addItemPageVersion(itemId, uri_v2, hash_v2) | version=2，defaultPageVersion=2 |
| 3 | setItemDefaultPageVersion(itemId, 1) | defaultPageVersion=1 |
| 4 | getItemPage(itemId, 1) | 返回 (hash_v1, uri_v1) |

### S-08 — 提取 Shop 余额（F6 UI）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 打开 `#/shop-console`，找到"Withdraw Shop Balance"区域 | 显示 shopId、token 输入框 |
| 2 | 填入 shopId 与 token 地址，点击"Withdraw to Treasury" | 协议管理员（owner）操作成功，余额转入 shopTreasury |
| 3 | 非 owner 点击"Withdraw to Treasury" | 报 `NotShopOwner`（合约 owner-only） |

### S-09 — Shop 统计（W5 + F5）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 打开 `#/shop/:id`，页面展示 Shop 信息与统计 | 显示 totalPurchases、totalRevenue、uniqueBuyers、itemCount |
| 2 | 调用 Worker `/shop-stats?shopId=1` | 返回 source=db 或 source=index 的统计数据，金额无精度丢失 |

---

## 角色四：买家（Buyer）

**身份**：任意持有 payToken 的地址。  
**入口页面**：`#/buyer`、`#/plaza`、`#/item/:id`

### B-01 — 标准购买（ERC20）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | approve USDC 给 itemsContract | 成功 |
| 2 | 购买 1 个 item（quantity=1，recipient=self） | NFT 铸造成功，USDC 分配：platformTreasury 3%，shopTreasury 97% |
| 3 | 在 `#/my` 查看购买记录 | 显示该笔购买的 itemId、tokenId、时间 |

### B-02 — 批量购买（C6 batch）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 购买 quantity=3 的 item（action=MintERC20） | 3 个 NFT 铸造，action 执行 3 次，totalCost=unitPrice×3 |
| 2 | 查看 soldCount 与 walletPurchaseCount | 均加 3 |

### B-03 — 串号购买（SerialPermit，B-04 重放保护）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 从 Worker `/serial-permit` 请求一个 permit | 返回 serialHash + EIP-712 签名 |
| 2 | 用 extraData 包含该 permit 调用 buy() | 成功，NFT 铸造 |
| 3 | 重放同一 permit 再次购买 | 报 `NonceUsed` |
| 4 | 不带 permit 购买 requiresSerial=true 的 item | 报 `SerialRequired` |

### B-04 — 资质验证（C10 eligibilityValidator）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 购买有 eligibilityValidator 的 item，买家满足条件 | 成功 |
| 2 | 买家不满足条件（validator 返回 false） | 报 `NotEligible` |

### B-05 — 查看 Item 详情（F1 + IPFS）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 打开 `#/item/1` | 显示 shopId、payToken、unitPrice、action、paused、maxSupply、soldCount、perWallet |
| 2 | tokenURI=ipfs://... 时，图片/媒体通过多网关 fallback 加载（F8） | 主网关超时后自动切换备用网关，最终显示成功 |

### B-06 — 购买状态机（F3 + F4 错误翻译）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 购买 Shop 已暂停的 item | `buyFlowOut` 显示"ShopPaused"并有中文/英文解释 |
| 2 | 购买已超卖的 item | 显示"ExceedsMaxSupply"并有提示 |
| 3 | 购买时间窗口外的 item | 显示"NotYetAvailable"或"SaleEnded" |

### B-07 — 历史记录查询（F2 + W4）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 打开 `#/my`，连接钱包 | 显示该钱包的历史购买，包含 item/shop enrich |
| 2 | 调用 Worker `/purchases?buyer=0x...` | 返回该买家的购买列表，包含 item 名称、shopId、金额 |
| 3 | 调用 `/purchases?source=db&buyer=0x...` | 从 SQLite 返回完整历史（不限 in-memory 窗口） |

---

## 角色五：陪审团 / 仲裁员（Jury / Arbitrator）

**身份**：M4 DisputeModule 尚未部署；M1 阶段仅验证冷静期数据记录正确性。  
**入口**：链上只读调用（cast call 或 ethers.js）

### J-01 — 购买时间戳记录（C11）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 购买 1 个 item，取得 tx receipt 中的 firstTokenId | 例如 firstTokenId=1 |
| 2 | 计算 purchaseId = keccak256(abi.encode(itemId, firstTokenId, buyer, block.timestamp)) | - |
| 3 | 调用 `purchaseTimestamps(purchaseId)` | 返回购买时的 block.timestamp（非零） |
| 4 | 调用 `isInDisputeWindow(purchaseId)` | 在 disputeWindowSeconds 内返回 true |
| 5 | 链上 warp 超过 disputeWindowSeconds 后再查 | 返回 false |

### J-02 — 冷静期配置（协议管理员配合）

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 协议管理员设置 `disputeWindowSeconds = 1 days` | 成功 |
| 2 | 购买后 25 小时，查 isInDisputeWindow | 返回 false |
| 3 | 协议管理员尝试设置 91 days | 报错，MAX_DISPUTE_WINDOW=90 days 上限保护 |

### J-03 — 未来 DisputeModule 接入准备

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 确认 purchaseTimestamps mapping 为 public | 可直接读取，无需额外授权 |
| 2 | 确认 isInDisputeWindow() 为纯 view | 可以被 DisputeModule 合约安全调用，无状态副作用 |

---

## 附录：Worker API 验收速查

| 接口 | 方法 | 验收要点 |
|------|------|---------|
| `/health` | GET | 返回 `{ok:true, services:{apiServer,indexer,db}}` |
| `/config` | GET | 返回合约地址、链 ID、索引状态 |
| `/purchases?buyer=0x...` | GET | 列出该买家购买记录，支持 shopId/itemId/source 过滤 |
| `/purchases?source=db` | GET | 从 SQLite 返回历史记录（不限内存） |
| `/shop-stats?shopId=1` | GET | 返回 totalPurchases/totalRevenue/uniqueBuyers，金额为字符串（BigInt 精度） |
| `/serial-permit` | POST | 返回 EIP-712 SerialPermit；同 nonce 重复请求返回 409 |
| `/risk-allowance` | POST | 返回 RiskAllowance；允许 shop 超过默认 item 上限 |
| `/metrics` | GET | Prometheus 格式，含 indexer 指标 |

---

## 附录：本地回归一键验证

```bash
# 启动 anvil + 部署 + Worker + 购买流程
./flow-test.sh

# 含前端 E2E（需 Playwright）
RUN_E2E=1 ./flow-test.sh

# 仅合约测试（47 cases，含 C1–C11）
cd contracts && forge test

# Worker smoke tests
cd worker && pnpm smoke:all
```

> **标签**：本节对应 git tag `v0.2.0-M1`，分支 `check-acceptance`。
