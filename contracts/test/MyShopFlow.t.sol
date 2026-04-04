pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {MyShops} from "../src/MyShops.sol";
import {MyShopItems} from "../src/MyShopItems.sol";
import {MintERC20Action} from "../src/actions/MintERC20Action.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockERC20Mintable} from "../src/mocks/MockERC20Mintable.sol";
import {MockCommunityNFT} from "../src/mocks/MockCommunityNFT.sol";
import {MockMintTokenAction} from "../src/mocks/MockMintTokenAction.sol";

contract MyShopFlowTest is Test {
    bytes32 internal constant ROLE_COMMUNITY = keccak256("COMMUNITY");

    uint256 internal constant RISK_PK = 0xA11CE;
    uint256 internal constant SERIAL_PK = 0xB0B;

    address internal riskSigner;
    address internal serialSigner;

    address internal platformTreasury = address(0xBEEF);

    address internal community = address(0xCAFE);
    address internal communityTreasury = address(0xC0FFEE);

    address internal buyer = address(0xB0A7);
    address internal recipient = address(0xF00D);

    MockRegistry internal registry;
    MockERC20Mintable internal apnts;
    MockERC20Mintable internal usdc;
    MockERC20Mintable internal wbtc;
    MockCommunityNFT internal nft;
    MintERC20Action internal action;
    MyShops internal shops;
    MyShopItems internal items;

    function setUp() external {
        riskSigner = vm.addr(RISK_PK);
        serialSigner = vm.addr(SERIAL_PK);

        registry = new MockRegistry();
        apnts = new MockERC20Mintable("aPNTs", "aPNTs", 18);
        usdc = new MockERC20Mintable("USDC", "USDC", 6);
        wbtc = new MockERC20Mintable("WBTC", "WBTC", 8);
        nft = new MockCommunityNFT();
        action = new MintERC20Action();

        shops = new MyShops(address(registry), platformTreasury, address(apnts), 100 ether, 300);
        items = new MyShopItems(address(shops), riskSigner, serialSigner);
        items.setActionAllowed(address(action), true);

        registry.setHasRole(ROLE_COMMUNITY, community, true);

        vm.prank(community);
        shops.registerShop(communityTreasury, bytes32(uint256(1)));

        apnts.mint(community, 10_000 ether);
        apnts.mint(buyer, 10_000 ether);

        usdc.mint(buyer, 1_000_000_000);
        wbtc.mint(buyer, 10_000_000_000);

        vm.prank(community);
        apnts.approve(address(items), type(uint256).max);

        vm.prank(buyer);
        usdc.approve(address(items), type(uint256).max);
    }

    function _addItem(bool requiresSerial, uint256 maxItems, uint256 deadline, uint256 nonce, bytes memory signature)
        internal
        returns (uint256 itemId)
    {
        MyShopItems.AddItemParams memory p = MyShopItems.AddItemParams({
            shopId: 1,
            payToken: address(usdc),
            unitPrice: 1000,
            nftContract: address(nft),
            soulbound: true,
            tokenURI: "ipfs://token",
            action: address(action),
            actionData: abi.encode(address(apnts), 50 ether),
            requiresSerial: requiresSerial,
            maxItems: maxItems,
            deadline: deadline,
            nonce: nonce,
            signature: signature,
            maxSupply: 0,
            perWallet: 0,
            startTime: 0,
            endTime: 0
        });
        itemId = items.addItem(p);
    }

    function test_registerShop_requiresCommunityRole() external {
        vm.prank(address(0x1234));
        vm.expectRevert(MyShops.NotCommunity.selector);
        shops.registerShop(address(0x9999), bytes32(uint256(2)));
    }

    function test_addItem_defaultMax5_enforced() external {
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(community);
            _addItem(false, 0, 0, 0, bytes(""));
        }

        vm.prank(community);
        vm.expectRevert(MyShopItems.MaxItemsReached.selector);
        _addItem(false, 0, 0, 0, bytes(""));
    }

    function test_addItem_withRiskSignature_allowsMoreThanDefault() external {
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(community);
            _addItem(false, 0, 0, 0, bytes(""));
        }

        uint256 maxItems = 6;
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 1;

        bytes memory sig = _signRiskAllowance(community, maxItems, deadline, nonce);

        vm.prank(community);
        _addItem(false, maxItems, deadline, nonce, sig);
    }

    function test_addItem_reverts_whenActionNotAllowed() external {
        MockMintTokenAction otherAction = new MockMintTokenAction();
        MyShopItems.AddItemParams memory p = MyShopItems.AddItemParams({
            shopId: 1,
            payToken: address(usdc),
            unitPrice: 1000,
            nftContract: address(nft),
            soulbound: true,
            tokenURI: "ipfs://token",
            action: address(otherAction),
            actionData: abi.encode(address(apnts), 50 ether),
            requiresSerial: false,
            maxItems: 0,
            deadline: 0,
            nonce: 0,
            signature: bytes(""),
            maxSupply: 0,
            perWallet: 0,
            startTime: 0,
            endTime: 0
        });

        vm.prank(community);
        vm.expectRevert(MyShopItems.ActionNotAllowed.selector);
        items.addItem(p);
    }

    function test_buy_atomic_mintsNftAndTokens_andSplitsFees() external {
        vm.prank(community);
        uint256 itemId = _addItem(false, 0, 0, 0, bytes(""));

        uint256 platformBefore = usdc.balanceOf(platformTreasury);
        uint256 shopBefore = usdc.balanceOf(communityTreasury);
        uint256 apntsBefore = apnts.balanceOf(recipient);

        vm.prank(buyer);
        uint256 firstTokenId = items.buy(itemId, 1, recipient, "");

        assertEq(firstTokenId, 1);
        assertEq(nft.ownerOf(1), recipient);

        uint256 platformAfter = usdc.balanceOf(platformTreasury);
        uint256 shopAfter = usdc.balanceOf(communityTreasury);
        assertEq(platformAfter - platformBefore, 30);
        assertEq(shopAfter - shopBefore, 970);

        uint256 apntsAfter = apnts.balanceOf(recipient);
        assertEq(apntsAfter - apntsBefore, 50 ether);
    }

    function test_buy_requiresSerial_whenItemConfigured() external {
        vm.prank(community);
        uint256 itemId = _addItem(true, 0, 0, 0, bytes(""));

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.SerialRequired.selector);
        items.buy(itemId, 1, recipient, "");
    }

    function test_buy_withSerialSignature_succeeds() external {
        vm.prank(community);
        uint256 itemId = _addItem(true, 0, 0, 0, bytes(""));

        bytes32 serialHash = keccak256(abi.encodePacked("SERIAL-001"));
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 42;
        bytes memory sig = _signSerialPermit(itemId, buyer, serialHash, deadline, nonce);
        bytes memory extra = abi.encode(serialHash, deadline, nonce, sig);

        vm.prank(buyer);
        uint256 firstTokenId = items.buy(itemId, 1, recipient, extra);

        assertEq(firstTokenId, 1);
        assertEq(nft.ownerOf(1), recipient);
    }

    function test_shopOperator_canManageItems_andPages() external {
        address operator = address(0x0B0B);

        vm.startPrank(community);
        uint8 roles = shops.ROLE_ITEM_EDITOR() | shops.ROLE_ITEM_MAINTAINER() | shops.ROLE_ITEM_ACTION_EDITOR();
        shops.setShopRoles(1, operator, roles);
        vm.stopPrank();

        apnts.mint(operator, 10_000 ether);
        vm.prank(operator);
        apnts.approve(address(items), type(uint256).max);

        vm.prank(operator);
        uint256 itemId = _addItem(false, 0, 0, 0, bytes(""));

        vm.prank(operator);
        items.setItemActive(itemId, false);
        bool activeAfter = items.getItem(itemId).active;
        assertEq(activeAfter, false);

        vm.prank(operator);
        items.setItemActive(itemId, true);

        vm.prank(operator);
        uint256 v1 = items.addItemPageVersion(itemId, "https://example.com/v1", bytes32(uint256(1)));
        assertEq(v1, 1);
        assertEq(items.itemDefaultPageVersion(itemId), 1);

        vm.prank(operator);
        uint256 v2 = items.addItemPageVersion(itemId, "https://example.com/v2", bytes32(uint256(2)));
        assertEq(v2, 2);
        assertEq(items.itemDefaultPageVersion(itemId), 2);

        (bytes32 h, string memory uri) = items.getItemPage(itemId, 1);
        assertEq(h, bytes32(uint256(1)));
        assertEq(uri, "https://example.com/v1");

        vm.prank(operator);
        items.setItemDefaultPageVersion(itemId, 1);
        assertEq(items.itemDefaultPageVersion(itemId), 1);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MyShop")),
                keccak256(bytes("1")),
                block.chainid,
                address(items)
            )
        );
    }

    function _signRiskAllowance(address shopOwner, uint256 maxItems, uint256 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("RiskAllowance(address shopOwner,uint256 maxItems,uint256 deadline,uint256 nonce)"),
                shopOwner,
                maxItems,
                deadline,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RISK_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signSerialPermit(uint256 itemId, address buyer_, bytes32 serialHash, uint256 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "SerialPermit(uint256 itemId,address buyer,bytes32 serialHash,uint256 deadline,uint256 nonce)"
                ),
                itemId,
                buyer_,
                serialHash,
                deadline,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SERIAL_PK, digest);
        return abi.encodePacked(r, s, v);
    }
}
