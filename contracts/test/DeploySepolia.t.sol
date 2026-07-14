pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {DeploySepolia} from "../script/DeploySepolia.s.sol";
import {MyShops} from "../src/MyShops.sol";
import {MyShopItems} from "../src/MyShopItems.sol";
import {TransferRewardAction} from "../src/actions/TransferRewardAction.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockCommunityNFT} from "../src/mocks/MockCommunityNFT.sol";
import {MockERC20Mintable} from "./mocks/MockERC20Mintable.sol";

/// MS-2 部署脚本冒烟测试:不 fork Sepolia,本地用 test/mocks 依赖直接驱动
/// 脚本抽出的 deployCore(env 解析留在 run(),此处不触碰 env / broadcast)。
/// 脚本本身在 Sepolia 上【禁止部署 mock】;mock 只作为测试注入的外部依赖存在。
contract DeploySepoliaSmokeTest is Test, DeploySepolia {
    bytes32 internal constant TEST_METADATA_HASH = bytes32(uint256(42));

    address internal riskSigner = address(0xA11CE);
    address internal serialSigner = address(0xB0B);
    address internal buyer = address(0xB0A7);
    address internal externalTreasury = address(0xC0FFEE);

    MockRegistry internal registry;
    MockERC20Mintable internal xpnts;
    MockCommunityNFT internal nft;

    function setUp() external {
        registry = new MockRegistry();
        xpnts = new MockERC20Mintable("xPNTs", "xPNTs", 18);
        nft = new MockCommunityNFT();
    }

    /// expectRevert 只对外部调用生效,包一层外部入口给 revert 用例。
    function deployCoreExternal(DeployParams memory p) external returns (Deployment memory) {
        return deployCore(p);
    }

    function _params() internal view returns (DeployParams memory p) {
        p = DeployParams({
            executor: address(this),
            registry: address(registry),
            communityNft: address(nft),
            xpntsToken: address(xpnts),
            treasury: address(this),
            riskSigner: riskSigner,
            serialSigner: serialSigner,
            listingFeeToken: address(xpnts),
            listingFeeAmount: 0,
            platformFeeBps: 300,
            shopId: 1,
            shopMetadataHash: TEST_METADATA_HASH
        });
    }

    function _grantCommunity(address who) internal {
        registry.setHasRole(ROLE_COMMUNITY, who, true);
    }

    function test_DeployCore_WiresCoreContracts() external {
        _grantCommunity(address(this));
        Deployment memory d = deployCore(_params());

        assertEq(d.shops.registry(), address(registry), "shops.registry");
        assertEq(d.shops.platformTreasury(), address(this), "platformTreasury");
        assertEq(d.shops.listingFeeToken(), address(xpnts), "listingFeeToken");
        assertEq(d.shops.listingFeeAmount(), 0, "listingFeeAmount");
        assertEq(d.shops.platformFeeBps(), 300, "platformFeeBps");

        assertEq(address(d.items.shops()), address(d.shops), "items.shops");
        assertEq(d.items.riskSigner(), riskSigner, "riskSigner");
        assertEq(d.items.serialSigner(), serialSigner, "serialSigner");

        assertEq(address(d.action.token()), address(xpnts), "action.token");
        assertEq(d.action.treasury(), address(this), "action.treasury");
        assertEq(d.action.allowedShopId(), 1, "action.allowedShopId");
        assertTrue(d.items.allowedActions(address(d.action)), "action allowlisted");
    }

    function test_DeployCore_RegistersShopWhenCommunity() external {
        _grantCommunity(address(this));
        Deployment memory d = deployCore(_params());

        assertTrue(d.shopRegistered, "shopRegistered");
        assertEq(d.shops.shopCount(), 1, "shopCount");
        (address shopOwner, address shopTreasury, bytes32 metadataHash, bool paused) = d.shops.shops(1);
        assertEq(shopOwner, address(this), "shop.owner");
        assertEq(shopTreasury, address(this), "shop.treasury");
        assertEq(metadataHash, TEST_METADATA_HASH, "shop.metadataHash");
        assertFalse(paused, "shop.paused");
    }

    function test_DeployCore_SkipsShopWithoutCommunityRole() external {
        Deployment memory d = deployCore(_params());

        assertFalse(d.shopRegistered, "shopRegistered must be false");
        assertEq(d.shops.shopCount(), 0, "no shop registered");
        // action 照常部署并预绑 SHOP_ID,等社区 owner 手动 registerShop 补齐
        assertEq(d.action.allowedShopId(), 1, "allowedShopId prebound");
    }

    function test_DeployCore_BindsItemsWhenTreasuryIsExecutor() external {
        _grantCommunity(address(this));
        Deployment memory d = deployCore(_params());

        assertTrue(d.itemsBound, "itemsBound");
        assertEq(d.action.items(), address(d.items), "action.items one-shot bound");
    }

    function test_DeployCore_SkipsSetItemsForExternalTreasury() external {
        _grantCommunity(address(this));
        DeployParams memory p = _params();
        p.treasury = externalTreasury;
        Deployment memory d = deployCore(p);

        assertFalse(d.itemsBound, "itemsBound must be false");
        assertEq(d.action.items(), address(0), "setItems left for treasury");
        assertEq(d.action.treasury(), externalTreasury, "action.treasury");
        assertEq(d.shops.platformTreasury(), externalTreasury, "platformTreasury");
        // treasury 事后仍可自行 one-shot 绑定
        vm.prank(externalTreasury);
        d.action.setItems(address(d.items));
        assertEq(d.action.items(), address(d.items), "treasury binds later");
    }

    function test_DeployCore_RevertsOnShopIdMismatch() external {
        _grantCommunity(address(this));
        DeployParams memory p = _params();
        p.shopId = 2; // 全新 MyShops 首个 registerShop 必返回 1

        vm.expectRevert(bytes("registered shopId != SHOP_ID (action.allowedShopId is immutable)"));
        this.deployCoreExternal(p);
    }

    function test_DeployCore_RevertsOnCodelessRegistry() external {
        DeployParams memory p = _params();
        p.registry = address(0xDEAD); // EOA/接错网络:无代码
        vm.expectRevert(bytes("REGISTRY_ADDRESS has no code (wrong network?)"));
        this.deployCoreExternal(p);
    }

    function test_DeployCore_RevertsOnZeroRequiredParams() external {
        DeployParams memory p = _params();

        p.registry = address(0);
        vm.expectRevert(bytes("REGISTRY_ADDRESS must not be zero"));
        this.deployCoreExternal(p);

        p = _params();
        p.communityNft = address(0);
        vm.expectRevert(bytes("COMMUNITY_NFT_ADDRESS must not be zero"));
        this.deployCoreExternal(p);

        p = _params();
        p.xpntsToken = address(0);
        vm.expectRevert(bytes("XPNTS_TOKEN_ADDRESS must not be zero"));
        this.deployCoreExternal(p);

        p = _params();
        p.treasury = address(0);
        vm.expectRevert(bytes("TREASURY_ADDRESS must not be zero"));
        this.deployCoreExternal(p);

        p = _params();
        p.shopId = 0;
        vm.expectRevert(bytes("SHOP_ID must not be zero"));
        this.deployCoreExternal(p);
    }

    function test_DeployCore_EndToEndPurchaseSmoke() external {
        _grantCommunity(address(this));
        Deployment memory d = deployCore(_params());

        // 部署后手动步骤(此处 treasury == executor == this,模拟社区 owner 操作):
        // 金库注资 + 授权 action 从金库发奖励
        xpnts.mint(address(this), 1000 ether);
        xpnts.approve(address(d.action), type(uint256).max);

        // 上架:payToken 即 xPNTs(逐商品指定,无全局白名单),挂 action 发奖励
        uint256 itemId = d.items.addItem(
            MyShopItems.AddItemParams({
                shopId: 1,
                payToken: address(xpnts),
                unitPrice: 10 ether,
                nftContract: address(nft),
                soulbound: false,
                tokenURI: "ipfs://item",
                action: address(d.action),
                actionData: abi.encode(uint256(5 ether)),
                requiresSerial: false,
                maxItems: 0,
                deadline: 0,
                nonce: 0,
                signature: bytes("")
            })
        );

        // 买家用 xPNTs 购买 2 件
        xpnts.mint(buyer, 100 ether);
        vm.prank(buyer);
        xpnts.approve(address(d.items), type(uint256).max);
        vm.prank(buyer);
        uint256 firstTokenId = d.items.buy(itemId, 2, buyer, "");

        // NFT 铸给买家
        assertEq(firstTokenId, 1, "firstTokenId");
        assertEq(nft.ownerOf(1), buyer, "nft #1");
        assertEq(nft.ownerOf(2), buyer, "nft #2");

        // 资金流:付 20,奖励回 5*2=10 => 买家净 90;金库(=平台库=店铺库)收 20 付 10
        assertEq(xpnts.balanceOf(buyer), 90 ether, "buyer balance");
        assertEq(xpnts.balanceOf(address(this)), 1010 ether, "treasury balance");
    }
}
