pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {MyShops, IRegistryHasRole} from "../src/MyShops.sol";
import {MyShopItems} from "../src/MyShopItems.sol";
import {TransferRewardAction} from "../src/actions/TransferRewardAction.sol";

// MyShop → Sepolia deploy (MS-2)。Env 驱动、零硬编码私钥(对照 DeployDemo.s.sol
// 的本地 demo 版:那份会部署 MockRegistry/Mock token,本脚本【禁止部署任何 mock】,
// 全部接生态真实合约)。
// 
// 部署序(MS-1 后合约面:无 Sale,奖励走 TransferRewardAction transferFrom 金库):
//   MyShops(接 canonical Registry) -> MyShopItems(接 MyShops)
//   -> TransferRewardAction(xPNTs, treasury, SHOP_ID)
//   -> items.setActionAllowed(action, true)
//   -> [deployer 有 ROLE_COMMUNITY 时] shops.registerShop(treasury, metadataHash),
//      并断言返回 shopId == SHOP_ID(action.allowedShopId 是 immutable,错配无法修复)
//   -> [treasury == deployer 时] action.setItems(items)(setItems 仅 treasury 可调,
//      one-shot;treasury 是外部地址时脚本只打印手动步骤,绝不代调)
// 
// Env(source SuperPaymaster/.env.sepolia):
//   DEPLOYER_PRIVATE_KEY      必填
//   REGISTRY_ADDRESS          可选 — 默认生态 canonical Registry(Sepolia)。
//                             来源:@aastar/sdk v0.42.0 CANONICAL_ADDRESSES[11155111].registry
//                             = 0xf5Bf37ca83AfdAab73691bA7eCcDfA69b8708E71。
//                             其 hasRole(bytes32,address) / ROLE_COMMUNITY=keccak256("COMMUNITY")
//                             与 MyShops.IRegistryHasRole 对齐。绝不部署 MockRegistry。
//   COMMUNITY_NFT_ADDRESS     必填 — 社区已部署的真实 CommunityNFT(商品 addItem 时作
//                             nftContract;需给 MyShopItems mint 权,见部署后手动步骤)
//   XPNTS_TOKEN_ADDRESS       必填 — 社区已发行的 xPNTs(xPNTsFactory 铸的),不新铸
//   TREASURY_ADDRESS          可选 — 默认 deployer。同时用作 MyShops.platformTreasury
//                             与 TransferRewardAction.treasury(社区奖励金库)
//   SHOP_ID                   可选 — 默认 1(全新 MyShops 上第一个 registerShop 必得 1)。
//                             部署后注册店铺用;action.allowedShopId 构造期即绑定此值
//   RISK_SIGNER_ADDRESS       可选 — 默认 deployer(RiskAllowance EIP-712 签名者)
//   SERIAL_SIGNER_ADDRESS     可选 — 默认 deployer(SerialPermit EIP-712 签名者)
//   LISTING_FEE_TOKEN_ADDRESS 可选 — 默认 = XPNTS_TOKEN_ADDRESS(MyShops 构造要求非零)
//   LISTING_FEE_AMOUNT        可选 — 默认 0(测试网不收上架费)
//   PLATFORM_FEE_BPS          可选 — 默认 300(3%,合约上限 2000)
//   SHOP_METADATA_HASH        可选 — 默认 bytes32(0),registerShop 用
// 
// 注:MyShopItems 没有 payToken 白名单——payToken 是 addItem 时按商品逐个指定的
// (xPNTs 作为支付币在上架商品时传入 AddItemParams.payToken),链上无全局白名单可设。
contract DeploySepolia is Script {
    bytes32 internal constant ROLE_COMMUNITY = keccak256("COMMUNITY");

    // 生态 canonical Registry(Sepolia)。来源:`@aastar/sdk` v0.42.0
    // dist/addresses(CANONICAL_ADDRESSES[11155111].registry)。
    address internal constant SEPOLIA_CANONICAL_REGISTRY = 0xf5Bf37ca83AfdAab73691bA7eCcDfA69b8708E71;

    struct DeployParams {
        address executor; // 实际发交易的地址(脚本 = deployer;测试 = test 合约)
        address registry;
        address communityNft;
        address xpntsToken;
        address treasury;
        address riskSigner;
        address serialSigner;
        address listingFeeToken;
        uint256 listingFeeAmount;
        uint16 platformFeeBps;
        uint256 shopId;
        bytes32 shopMetadataHash;
    }

    struct Deployment {
        MyShops shops;
        MyShopItems items;
        TransferRewardAction action;
        bool shopRegistered; // executor 有 ROLE_COMMUNITY 时脚本内完成注册
        bool itemsBound; // treasury == executor 时脚本内完成 action.setItems
    }

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address xpnts = vm.envAddress("XPNTS_TOKEN_ADDRESS");

        DeployParams memory p = DeployParams({
            executor: deployer,
            registry: vm.envOr("REGISTRY_ADDRESS", SEPOLIA_CANONICAL_REGISTRY),
            communityNft: vm.envAddress("COMMUNITY_NFT_ADDRESS"),
            xpntsToken: xpnts,
            treasury: vm.envOr("TREASURY_ADDRESS", deployer),
            riskSigner: vm.envOr("RISK_SIGNER_ADDRESS", deployer),
            serialSigner: vm.envOr("SERIAL_SIGNER_ADDRESS", deployer),
            listingFeeToken: vm.envOr("LISTING_FEE_TOKEN_ADDRESS", xpnts),
            listingFeeAmount: vm.envOr("LISTING_FEE_AMOUNT", uint256(0)),
            platformFeeBps: _toBps(vm.envOr("PLATFORM_FEE_BPS", uint256(300))),
            shopId: vm.envOr("SHOP_ID", uint256(1)),
            shopMetadataHash: vm.envOr("SHOP_METADATA_HASH", bytes32(0))
        });

        vm.startBroadcast(deployerPk);
        Deployment memory d = deployCore(p);
        vm.stopBroadcast();

        _printSummary(p, d);
    }

    /// 核心部署逻辑,与 env 解析解耦以便 forge test 传 mock 依赖直接调用。
    /// 只做部署 + 幂等安全的初始配置;任何需要第三方身份(外部 treasury、
    /// 无 ROLE_COMMUNITY)的步骤一律留给 _printSummary 的手动清单。
    function deployCore(DeployParams memory p) internal returns (Deployment memory d) {
        require(p.registry != address(0), "REGISTRY_ADDRESS must not be zero");
        // 防接错网络/填错地址:codeless registry 会让 registerShop 永久 revert
        // (且 hasRole 探测的 extcodesize 检查发生在 try/catch 之外,兜不住)
        require(p.registry.code.length > 0, "REGISTRY_ADDRESS has no code (wrong network?)");
        require(p.communityNft != address(0), "COMMUNITY_NFT_ADDRESS must not be zero");
        require(p.xpntsToken != address(0), "XPNTS_TOKEN_ADDRESS must not be zero");
        require(p.treasury != address(0), "TREASURY_ADDRESS must not be zero");
        require(p.shopId != 0, "SHOP_ID must not be zero");

        // 1. MyShops — 接生态 canonical Registry(registerShop 靠它做 ROLE_COMMUNITY 门控)
        d.shops = new MyShops(p.registry, p.treasury, p.listingFeeToken, p.listingFeeAmount, p.platformFeeBps);

        // 2. MyShopItems — 接 MyShops
        d.items = new MyShopItems(address(d.shops), p.riskSigner, p.serialSigner);

        // 3. TransferRewardAction — 无 mint 权,奖励 transferFrom(treasury) 发放;
        //    allowedShopId immutable,构造期即绑 SHOP_ID
        d.action = new TransferRewardAction(p.xpntsToken, p.treasury, p.shopId);

        // 4. 全局 action allowlist(items.owner == executor,脚本内可直接调)
        d.items.setActionAllowed(address(d.action), true);

        // 5. registerShop:需要 executor 在 Registry 有 ROLE_COMMUNITY。
        //    try/catch 包住 view 探测——registry 接口不兼容(hasRole revert)或
        //    无角色都降级为手动步骤(codeless 已在入口 require 挡掉)。
        try IRegistryHasRole(p.registry).hasRole(ROLE_COMMUNITY, p.executor) returns (bool isCommunity) {
            if (isCommunity) {
                uint256 gotShopId = d.shops.registerShop(p.treasury, p.shopMetadataHash);
                // action.allowedShopId 无法事后修改,错配必须在部署期炸掉
                require(gotShopId == p.shopId, "registered shopId != SHOP_ID (action.allowedShopId is immutable)");
                d.shopRegistered = true;
            }
        } catch {}

        // 6. action.setItems 只有 treasury 能调(one-shot)。treasury 是外部地址
        //    (多签/社区 owner)时绝不代调,由 _printSummary 输出手动步骤。
        if (p.executor == p.treasury) {
            d.action.setItems(address(d.items));
            d.itemsBound = true;
        }
    }

    function _toBps(uint256 raw) internal pure returns (uint16) {
        require(raw <= 2000, "PLATFORM_FEE_BPS exceeds contract cap 2000");
        return uint16(raw);
    }

    function _printSummary(DeployParams memory p, Deployment memory d) internal view {
        console2.log("=== MyShop Sepolia deploy (MS-2) ===");
        console2.log("deployer:            ", p.executor);
        console2.log("Registry (canonical):", p.registry);
        console2.log("CommunityNFT:        ", p.communityNft);
        console2.log("xPNTs:               ", p.xpntsToken);
        console2.log("treasury:            ", p.treasury);
        console2.log("MyShops:             ", address(d.shops));
        console2.log("MyShopItems:         ", address(d.items));
        console2.log("TransferRewardAction:", address(d.action));
        console2.log("SHOP_ID:             ", p.shopId);

        console2.log("--- env lines (for frontend/.env) ---");
        console2.log(string.concat("NEXT_PUBLIC_MYSHOPS_ADDRESS=", vm.toString(address(d.shops))));
        console2.log(string.concat("NEXT_PUBLIC_MYSHOP_ITEMS_ADDRESS=", vm.toString(address(d.items))));
        console2.log(string.concat("NEXT_PUBLIC_REWARD_ACTION_ADDRESS=", vm.toString(address(d.action))));
        console2.log(string.concat("NEXT_PUBLIC_XPNTS_TOKEN_ADDRESS=", vm.toString(p.xpntsToken)));
        console2.log(string.concat("NEXT_PUBLIC_COMMUNITY_NFT_ADDRESS=", vm.toString(p.communityNft)));
        console2.log(string.concat("NEXT_PUBLIC_REGISTRY_ADDRESS=", vm.toString(p.registry)));
        console2.log(string.concat("NEXT_PUBLIC_SHOP_ID=", vm.toString(p.shopId)));

        console2.log("--- manual steps remaining ---");
        if (!d.shopRegistered) {
            console2.log("[1] deployer lacks ROLE_COMMUNITY on Registry (or hasRole probe failed):");
            console2.log("    community owner must call MyShops.registerShop(treasury, metadataHash)");
            console2.log("    !! resulting shopId MUST equal SHOP_ID above (action.allowedShopId is immutable)");
        }
        if (!d.itemsBound) {
            console2.log("[2] treasury != deployer: treasury must call action.setItems(items) (one-shot):");
            console2.log(string.concat("    action.setItems(", vm.toString(address(d.items)), ")"));
        }
        console2.log("[3] treasury must approve action to spend xPNTs reward pool:");
        console2.log(string.concat("    xPNTs.approve(", vm.toString(address(d.action)), ", <rewardBudget>)"));
        console2.log("    (or xPNTs addAutoApprovedSpender on token side)");
        console2.log("[4] CommunityNFT must grant mint permission to MyShopItems:");
        console2.log(string.concat("    allow minter ", vm.toString(address(d.items))));
        console2.log("[5] addItem: payToken (e.g. xPNTs) is set per-item via AddItemParams.payToken;");
        console2.log("    attach action + actionData=abi.encode(amountPerUnit) to pay rewards on purchase.");
    }
}
