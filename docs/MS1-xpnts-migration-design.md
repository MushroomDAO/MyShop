# MS-1 设计稿:停止自铸 GToken/aPNTs,迁移到生态 xPNTs

> 状态:**设计稿,待 jason review 后实施**。2026-07-14。
> 上游依据:Cos72 仓 `docs/MODULES_VS_INFRA_OVERLAP.md` §2(判定)、`docs/MODULES_INTEGRATION_PLAN.md` C 线 MS-1/MS-2(任务)。
> 决策基线(已拍板):MyShop 停止自铸 GToken/aPNTs → xPNTsFactory 发 xPNTs;合约留本仓改造,Cos72 重建前端。

## 1. 问题(为什么是删除级冲突,不是改造)

| 现状 | 位置 | 冲突 |
|---|---|---|
| `GTokenSale.sol` 自铸 "GToken"(CAP 21M,与 canonical **逐字节同名同参**) | `contracts/src/sales/GTokenSale.sol:194` | 冒用生态治理 token 品牌;canonical `GToken.sol` 已存在且 `onlyOwner` mint |
| `APNTsSale.sol` 自铸 "aPNTs"(**无 cap**) | `contracts/src/sales/APNTsSale.sol:191` | 最高风险:无界铸造 + 冒用稀缺 gas-credit 名;canonical aPNTs 为单例、治理设、7 天 timelock |
| `MintERC20Action` 对任意 token 调 `mint` | `contracts/src/actions/MintERC20Action.sol:18` | 指向 canonical token 会被 mint 门控挡下,实际只能铸自家未受控 clone —— 同一冲突换皮 |
| `MockERC20Mintable` mint 无权限 | `contracts/src/mocks/MockERC20Mintable.sol:41` | demo 专用,**严禁上 Sepolia** |

结论:**Sale 类合约整体退役**,不是改造——「法币/资产 → 积分」的销售在生态里已有 canonical 承接(YAA 管理 portal 的 `/sale` + SDK `TokenSaleClient`,GTokenSale bonding curve / APNTsSale 固定价 $0.02,Foundry 测试 52 个);MyShop 不应持有任何发行权。

## 2. 目标架构

```
社区 owner(ROLE_COMMUNITY,Registry 门控)
   │  xPNTsFactory.deployxPNTsToken(name, symbol, communityName, ENS, exchangeRate, paymasterAOA)
   ▼
社区 xPNTs token(SDK canonical,自带:mint=communityOwner / autoApprovedSpenders /
                  updateExchangeRate(±20%/h) / recordDebt-repayDebt 信用 / CC-28 超发熔断)
   │
   ├── 商店收款:MyShopItems.buy() 的支付 token = 社区 xPNTs
   │     └── communityOwner 调 addAutoApprovedSpender(MyShopItems)
   │         → 买家免 approve,单 op 购买(与 MyTask createTask 同款优化)
   │
   ├── 购卡赠积分(原 MintERC20Action 场景):
   │     方案 A(推荐):TransferRewardAction —— 店铺金库(communityOwner 预 mint 的
   │       xPNTs 池)transferFrom 发放;MyShop 无任何 mint 权
   │     方案 B(否决):xPNTs 给 Action 授 mint 权 —— 扩大发行权面,违背收敛原则
   │
   └── 未来信用购物(MS-5):xPNTs 自带 debts/recordDebt + SP chargeCreditForShop(E-1)
```

## 3. 迁移步骤(实施顺序)

1. **退役 Sale**:`sales/APNTsSale.sol`、`sales/GTokenSale.sol` 移入 `contracts/legacy/`(或直接删除,git 有历史);从部署脚本与前端配置移除;README 注明由生态 `/sale` portal 承接。
2. **改造 Action**:`MintERC20Action` → `TransferRewardAction`(构造传 xPNTs token + 金库地址;`execute` 做 `transferFrom(treasury, recipient, amount)`;金库对 Action `addAutoApprovedSpender` 或显式 approve)。`MintERC721Action` 保留(loyalty NFT,非冲突)。
3. **部署脚本重写**(与 MS-2 合并):`DeploySepolia.s.sol` env 驱动——`REGISTRY_ADDRESS`(canonical,替代 MockRegistry)、`XPNTS_TOKEN_ADDRESS`(社区已 deploy 的 xPNTs,不新铸)、`COMMUNITY_NFT_ADDRESS`;**不部署任何 mock token**。
4. **测试迁移**:Sales.t.sol 9 个测试随退役移除;新增 TransferRewardAction 测试(金库不足/未授权/正常发放);MyShopFlow.t.sol 的支付 token 换 xPNTs mock(带 autoApprovedSpenders 语义的 mock,或直接 fork 测)。
5. **文档**:milestones.md 标注 Sale 退役决策与替代路径。

## 4. 边界与不变量

- MyShops 注册门控 `Registry.hasRole(ROLE_COMMUNITY)` **保留**(overlap 判定 KEEP,分层正确)。
- MyShopItems 原子 buy + 分账 + Action 组合 **保留**(核心业务,infra 无等价物)。
- 本设计不动 permit/风控签名(MS-6 KMS 化单独做)、不动治理(MS-3 多签单独做)、不动库存字段(MS-4)。
- 不变量:改造后 **MyShop 全部合约无任何 `mint` 调用权**;积分发行权只存在于 xPNTsFactory/communityOwner。

## 5. 开放问题(实施前需 jason 拍板)

1. Sale 合约「移 legacy 目录」还是「直接删」?(倾向删,git 可考古)
2. `TransferRewardAction` 金库由谁运营:社区 owner 地址直接当金库,还是部署独立 Treasury 合约(可多签)?(倾向前者起步,MS-3 治理收敛时再升级)
3. buy() 支付 token 是否只允许社区 xPNTs,还是保留 supportedToken 白名单(xPNTs + USDC 等)?(倾向保留白名单,xPNTs 为默认+免 approve 优待)
