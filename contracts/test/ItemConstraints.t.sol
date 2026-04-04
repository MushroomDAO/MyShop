pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {MyShops} from "../src/MyShops.sol";
import {MyShopItems} from "../src/MyShopItems.sol";
import {MintERC20Action} from "../src/actions/MintERC20Action.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockERC20Mintable} from "../src/mocks/MockERC20Mintable.sol";
import {MockCommunityNFT} from "../src/mocks/MockCommunityNFT.sol";

/// @notice Tests for C1 (maxSupply/perWallet), C2 (time window), C3 (item pause), C4 (shop pause)
contract ItemConstraintsTest is Test {
    bytes32 internal constant ROLE_COMMUNITY = keccak256("COMMUNITY");

    address internal platformTreasury = address(0xBEEF);
    address internal community = address(0xCAFE);
    address internal communityTreasury = address(0xC0FFEE);
    address internal buyer = address(0xB0A7);
    address internal buyer2 = address(0xB0A8);
    address internal recipient = address(0xF00D);
    address internal recipient2 = address(0xF00E);

    MockRegistry internal registry;
    MockERC20Mintable internal apnts;
    MockERC20Mintable internal usdc;
    MockCommunityNFT internal nft;
    MintERC20Action internal action;
    MyShops internal shops;
    MyShopItems internal items;

    uint256 internal constant SHOP_ID = 1;

    function setUp() external {
        registry = new MockRegistry();
        apnts = new MockERC20Mintable("aPNTs", "aPNTs", 18);
        usdc = new MockERC20Mintable("USDC", "USDC", 6);
        nft = new MockCommunityNFT();
        action = new MintERC20Action();

        shops = new MyShops(address(registry), platformTreasury, address(apnts), 0, 300);
        items = new MyShopItems(address(shops), address(0x1), address(0x2));
        items.setActionAllowed(address(action), true);

        registry.setHasRole(ROLE_COMMUNITY, community, true);

        vm.prank(community);
        shops.registerShop(communityTreasury, bytes32(uint256(1)));

        usdc.mint(buyer, 1_000_000_000);
        usdc.mint(buyer2, 1_000_000_000);
        apnts.mint(community, 10_000 ether);

        vm.prank(buyer);
        usdc.approve(address(items), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(items), type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _addItemWith(uint256 maxSupply, uint32 perWallet, uint64 startTime, uint64 endTime)
        internal
        returns (uint256 itemId)
    {
        MyShopItems.AddItemParams memory p = MyShopItems.AddItemParams({
            shopId: SHOP_ID,
            payToken: address(usdc),
            unitPrice: 1000,
            nftContract: address(nft),
            soulbound: false,
            tokenURI: "ipfs://token",
            action: address(0),
            actionData: bytes(""),
            requiresSerial: false,
            maxItems: 0,
            deadline: 0,
            nonce: 0,
            signature: bytes(""),
            maxSupply: maxSupply,
            perWallet: perWallet,
            startTime: startTime,
            endTime: endTime,
            eligibilityValidator: address(0),
            eligibilityValidatorData: ""
        });
        vm.prank(community);
        itemId = items.addItem(p);
    }

    function _buy(address _buyer, uint256 itemId, uint256 quantity, address _recipient) internal {
        vm.prank(_buyer);
        items.buy(itemId, quantity, _recipient, "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C1: maxSupply enforcement
    // ─────────────────────────────────────────────────────────────────────────

    function test_maxSupply_zero_meansUnlimited() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);
        // Buy many times without hitting any limit
        for (uint256 i = 0; i < 10; i++) {
            _buy(buyer, itemId, 1, recipient);
        }
        assertEq(items.itemSoldCount(itemId), 10);
    }

    function test_maxSupply_enforced_exactLimit() external {
        uint256 itemId = _addItemWith(3, 0, 0, 0);
        _buy(buyer, itemId, 3, recipient);
        assertEq(items.itemSoldCount(itemId), 3);
    }

    function test_maxSupply_reverts_whenExceeded() external {
        uint256 itemId = _addItemWith(3, 0, 0, 0);
        _buy(buyer, itemId, 2, recipient);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.ExceedsMaxSupply.selector);
        items.buy(itemId, 2, recipient, "");
    }

    function test_maxSupply_reverts_singlePurchaseOverLimit() external {
        uint256 itemId = _addItemWith(2, 0, 0, 0);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.ExceedsMaxSupply.selector);
        items.buy(itemId, 3, recipient, "");
    }

    function test_maxSupply_counter_incrementsCorrectly() external {
        uint256 itemId = _addItemWith(10, 0, 0, 0);
        _buy(buyer, itemId, 4, recipient);
        _buy(buyer2, itemId, 3, recipient2);
        assertEq(items.itemSoldCount(itemId), 7);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C1: perWallet enforcement
    // ─────────────────────────────────────────────────────────────────────────

    function test_perWallet_zero_meansUnlimited() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);
        _buy(buyer, itemId, 5, recipient);
        _buy(buyer, itemId, 5, recipient);
        assertEq(items.walletPurchaseCount(itemId, recipient), 10);
    }

    function test_perWallet_enforced_exactLimit() external {
        uint256 itemId = _addItemWith(0, 2, 0, 0);
        _buy(buyer, itemId, 2, recipient);
        assertEq(items.walletPurchaseCount(itemId, recipient), 2);
    }

    function test_perWallet_reverts_whenExceeded() external {
        uint256 itemId = _addItemWith(0, 2, 0, 0);
        _buy(buyer, itemId, 1, recipient);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.ExceedsPerWallet.selector);
        items.buy(itemId, 2, recipient, "");
    }

    function test_perWallet_perRecipient_notPerBuyer() external {
        // perWallet is keyed by recipient; different recipients are independent
        uint256 itemId = _addItemWith(0, 2, 0, 0);
        _buy(buyer, itemId, 2, recipient);
        // Different recipient — should succeed
        _buy(buyer, itemId, 2, recipient2);
        assertEq(items.walletPurchaseCount(itemId, recipient), 2);
        assertEq(items.walletPurchaseCount(itemId, recipient2), 2);
    }

    function test_perWallet_reverts_singlePurchaseOverLimit() external {
        uint256 itemId = _addItemWith(0, 1, 0, 0);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.ExceedsPerWallet.selector);
        items.buy(itemId, 2, recipient, "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C2: time window
    // ─────────────────────────────────────────────────────────────────────────

    function test_startTime_zero_noRestriction() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);
        _buy(buyer, itemId, 1, recipient);
    }

    function test_startTime_notYetAvailable_reverts() external {
        uint64 start = uint64(block.timestamp + 1 days);
        uint256 itemId = _addItemWith(0, 0, start, 0);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.NotYetAvailable.selector);
        items.buy(itemId, 1, recipient, "");
    }

    function test_startTime_available_afterStart() external {
        uint64 start = uint64(block.timestamp + 1 days);
        uint256 itemId = _addItemWith(0, 0, start, 0);

        vm.warp(block.timestamp + 1 days);
        _buy(buyer, itemId, 1, recipient);
    }

    function test_endTime_zero_noRestriction() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);
        vm.warp(block.timestamp + 365 days);
        _buy(buyer, itemId, 1, recipient);
    }

    function test_endTime_saleEnded_reverts() external {
        uint64 end = uint64(block.timestamp + 1 days);
        uint256 itemId = _addItemWith(0, 0, 0, end);

        vm.warp(block.timestamp + 2 days);
        vm.prank(buyer);
        vm.expectRevert(MyShopItems.SaleEnded.selector);
        items.buy(itemId, 1, recipient, "");
    }

    function test_endTime_exactBoundary_succeeds() external {
        uint64 end = uint64(block.timestamp + 1 days);
        uint256 itemId = _addItemWith(0, 0, 0, end);

        vm.warp(end);
        _buy(buyer, itemId, 1, recipient);
    }

    function test_timeWindow_bothSet_insideWindow_succeeds() external {
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 2 days);
        uint256 itemId = _addItemWith(0, 0, start, end);

        vm.warp(block.timestamp + 12 hours);
        _buy(buyer, itemId, 1, recipient);
    }

    function test_timeWindow_bothSet_beforeStart_reverts() external {
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 2 days);
        uint256 itemId = _addItemWith(0, 0, start, end);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.NotYetAvailable.selector);
        items.buy(itemId, 1, recipient, "");
    }

    function test_timeWindow_bothSet_afterEnd_reverts() external {
        uint64 start = uint64(block.timestamp + 1 hours);
        uint64 end = uint64(block.timestamp + 2 days);
        uint256 itemId = _addItemWith(0, 0, start, end);

        vm.warp(block.timestamp + 3 days);
        vm.prank(buyer);
        vm.expectRevert(MyShopItems.SaleEnded.selector);
        items.buy(itemId, 1, recipient, "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C3: item-level pause
    // ─────────────────────────────────────────────────────────────────────────

    function test_itemPause_notPaused_canBuy() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);
        _buy(buyer, itemId, 1, recipient);
    }

    function test_itemPause_blocks_buy() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);

        vm.prank(community);
        items.pauseItem(itemId, true);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.ItemPausedError.selector);
        items.buy(itemId, 1, recipient, "");
    }

    function test_itemPause_unpaused_canBuyAgain() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);

        vm.prank(community);
        items.pauseItem(itemId, true);

        vm.prank(community);
        items.pauseItem(itemId, false);

        _buy(buyer, itemId, 1, recipient);
    }

    function test_itemPause_emitsEvent() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);

        vm.prank(community);
        vm.expectEmit(true, false, false, true);
        emit MyShopItems.ItemPaused(itemId, true);
        items.pauseItem(itemId, true);
    }

    function test_itemPause_onlyShopOwner() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.NotShopOwner.selector);
        items.pauseItem(itemId, true);
    }

    function test_itemPause_stateStoredInItem() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);
        assertEq(items.getItem(itemId).paused, false);

        vm.prank(community);
        items.pauseItem(itemId, true);
        assertEq(items.getItem(itemId).paused, true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C4: shop pause blocks buy()
    // ─────────────────────────────────────────────────────────────────────────

    function test_shopPause_blocks_buy() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);

        vm.prank(community);
        shops.setShopPaused(SHOP_ID, true);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.ShopPaused.selector);
        items.buy(itemId, 1, recipient, "");
    }

    function test_shopPause_unpaused_canBuy() external {
        uint256 itemId = _addItemWith(0, 0, 0, 0);

        vm.prank(community);
        shops.setShopPaused(SHOP_ID, true);

        vm.prank(community);
        shops.setShopPaused(SHOP_ID, false);

        _buy(buyer, itemId, 1, recipient);
    }

    function test_shopPause_blocks_addItem() external {
        vm.prank(community);
        shops.setShopPaused(SHOP_ID, true);

        MyShopItems.AddItemParams memory p = MyShopItems.AddItemParams({
            shopId: SHOP_ID,
            payToken: address(usdc),
            unitPrice: 1000,
            nftContract: address(nft),
            soulbound: false,
            tokenURI: "ipfs://token",
            action: address(0),
            actionData: bytes(""),
            requiresSerial: false,
            maxItems: 0,
            deadline: 0,
            nonce: 0,
            signature: bytes(""),
            maxSupply: 0,
            perWallet: 0,
            startTime: 0,
            endTime: 0,
            eligibilityValidator: address(0),
            eligibilityValidatorData: ""
        });

        vm.prank(community);
        vm.expectRevert(MyShopItems.ShopPaused.selector);
        items.addItem(p);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Combined: all constraints can coexist
    // ─────────────────────────────────────────────────────────────────────────

    function test_combined_allConstraints_passesWhenValid() external {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 7 days);
        uint256 itemId = _addItemWith(10, 3, start, end);

        _buy(buyer, itemId, 3, recipient);
        assertEq(items.itemSoldCount(itemId), 3);
        assertEq(items.walletPurchaseCount(itemId, recipient), 3);
    }

    function test_combined_maxSupplyThenPerWallet_bothEnforced() external {
        // maxSupply=5, perWallet=3 — buyer can't exceed 3, and global can't exceed 5
        uint256 itemId = _addItemWith(5, 3, 0, 0);

        _buy(buyer, itemId, 3, recipient);
        // Now 3/5 sold, recipient at 3/3 — another buy by same recipient should fail
        vm.prank(buyer);
        vm.expectRevert(MyShopItems.ExceedsPerWallet.selector);
        items.buy(itemId, 1, recipient, "");

        // Different recipient can still buy up to remaining supply
        _buy(buyer2, itemId, 2, recipient2);
        assertEq(items.itemSoldCount(itemId), 5);

        // Now supply exhausted
        vm.prank(buyer2);
        vm.expectRevert(MyShopItems.ExceedsMaxSupply.selector);
        items.buy(itemId, 1, recipient2, "");
    }
}
