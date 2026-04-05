// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {MyShops} from "../src/MyShops.sol";
import {MyShopItems} from "../src/MyShopItems.sol";
import {MintERC20Action} from "../src/actions/MintERC20Action.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockERC20Mintable} from "../src/mocks/MockERC20Mintable.sol";
import {MockCommunityNFT} from "../src/mocks/MockCommunityNFT.sol";
import {MockERC721} from "../src/mocks/MockERC721.sol";
import {SBTHolderValidator} from "../src/validators/SBTHolderValidator.sol";
import {TokenBalanceValidator} from "../src/validators/TokenBalanceValidator.sol";

/// @notice Tests for C10 EligibilityValidator: SBTHolderValidator and TokenBalanceValidator.
contract EligibilityValidatorsTest is Test {
    bytes32 internal constant ROLE_COMMUNITY = keccak256("COMMUNITY");

    address internal platformTreasury = address(0xBEEF);
    address internal community = address(0xCAFE);
    address internal communityTreasury = address(0xC0FFEE);
    address internal buyer = address(0xB0A7);
    address internal recipient = address(0xF00D);

    MockRegistry internal registry;
    MockERC20Mintable internal apnts;
    MockERC20Mintable internal usdc;
    MockCommunityNFT internal nft;
    MockERC721 internal sbt;
    MockERC20Mintable internal govToken;
    MintERC20Action internal action;
    MyShops internal shops;
    MyShopItems internal items;

    SBTHolderValidator internal sbtValidator;
    TokenBalanceValidator internal tokenValidator;

    uint256 internal constant SHOP_ID = 1;

    function setUp() external {
        registry = new MockRegistry();
        apnts = new MockERC20Mintable("aPNTs", "aPNTs", 18);
        usdc = new MockERC20Mintable("USDC", "USDC", 6);
        nft = new MockCommunityNFT();
        sbt = new MockERC721();
        govToken = new MockERC20Mintable("GOV", "GOV", 18);
        action = new MintERC20Action();

        shops = new MyShops(address(registry), platformTreasury, address(apnts), 0, 300);
        items = new MyShopItems(address(shops), address(0x1), address(0x2));
        items.setActionAllowed(address(action), true);

        // Deploy validators and whitelist them
        sbtValidator = new SBTHolderValidator();
        tokenValidator = new TokenBalanceValidator();
        items.setValidatorAllowed(address(sbtValidator), true);
        items.setValidatorAllowed(address(tokenValidator), true);

        registry.setHasRole(ROLE_COMMUNITY, community, true);

        vm.prank(community);
        shops.registerShop(communityTreasury, bytes32(uint256(1)));

        // Fund buyer with USDC for purchases
        usdc.mint(buyer, 1_000_000_000);
        apnts.mint(community, 10_000 ether);

        vm.prank(buyer);
        usdc.approve(address(items), type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _addItemWithValidator(address validator, bytes memory validatorData)
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
            maxSupply: 0,
            perWallet: 0,
            startTime: 0,
            endTime: 0,
            eligibilityValidator: validator,
            eligibilityValidatorData: validatorData
        });
        vm.prank(community);
        itemId = items.addItem(p);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SBTHolderValidator — unit tests (direct calls)
    // ─────────────────────────────────────────────────────────────────────────

    function test_sbtValidator_eligible_whenBuyerHasEnoughTokens() external {
        sbt.mint(buyer, 1);
        bytes memory data = abi.encode(address(sbt), uint256(1));
        bool result = sbtValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertTrue(result);
    }

    function test_sbtValidator_notEligible_whenBuyerHasZeroTokens() external {
        // buyer has no SBT
        bytes memory data = abi.encode(address(sbt), uint256(1));
        bool result = sbtValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertFalse(result);
    }

    function test_sbtValidator_eligible_whenBuyerExceedsMinBalance() external {
        sbt.mint(buyer, 5);
        bytes memory data = abi.encode(address(sbt), uint256(3));
        bool result = sbtValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertTrue(result);
    }

    function test_sbtValidator_notEligible_whenBuyerBelowMinBalance() external {
        sbt.mint(buyer, 2);
        bytes memory data = abi.encode(address(sbt), uint256(3));
        bool result = sbtValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertFalse(result);
    }

    function test_sbtValidator_minBalanceZero_alwaysEligible() external {
        // minBalance=0: any holder count (including 0) satisfies the check
        bytes memory data = abi.encode(address(sbt), uint256(0));
        bool result = sbtValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertTrue(result);
    }

    function test_sbtValidator_zeroNftContract_returnsOpen() external {
        // address(0) nftContract means misconfigured = open access
        bytes memory data = abi.encode(address(0), uint256(1));
        bool result = sbtValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertTrue(result);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TokenBalanceValidator — unit tests (direct calls)
    // ─────────────────────────────────────────────────────────────────────────

    function test_tokenValidator_eligible_whenBuyerMeetsMinAmount() external {
        govToken.mint(buyer, 100 ether);
        bytes memory data = abi.encode(address(govToken), uint256(100 ether));
        bool result = tokenValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertTrue(result);
    }

    function test_tokenValidator_eligible_whenBuyerExceedsMinAmount() external {
        govToken.mint(buyer, 500 ether);
        bytes memory data = abi.encode(address(govToken), uint256(100 ether));
        bool result = tokenValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertTrue(result);
    }

    function test_tokenValidator_notEligible_whenBuyerBelowMinAmount() external {
        govToken.mint(buyer, 50 ether);
        bytes memory data = abi.encode(address(govToken), uint256(100 ether));
        bool result = tokenValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertFalse(result);
    }

    function test_tokenValidator_notEligible_whenBuyerHasNoTokens() external {
        bytes memory data = abi.encode(address(govToken), uint256(1 ether));
        bool result = tokenValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertFalse(result);
    }

    function test_tokenValidator_zeroToken_returnsOpen() external {
        bytes memory data = abi.encode(address(0), uint256(1 ether));
        bool result = tokenValidator.checkEligibility(buyer, recipient, 1, SHOP_ID, 1, data, "");
        assertTrue(result);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SBTHolderValidator — end-to-end via MyShopItems.buy()
    // ─────────────────────────────────────────────────────────────────────────

    function test_e2e_sbt_buySucceeds_whenEligible() external {
        sbt.mint(buyer, 1);
        bytes memory data = abi.encode(address(sbt), uint256(1));
        uint256 itemId = _addItemWithValidator(address(sbtValidator), data);

        vm.prank(buyer);
        items.buy(itemId, 1, recipient, "");

        assertEq(items.itemSoldCount(itemId), 1);
    }

    function test_e2e_sbt_buyReverts_whenNotEligible() external {
        // buyer has no SBT
        bytes memory data = abi.encode(address(sbt), uint256(1));
        uint256 itemId = _addItemWithValidator(address(sbtValidator), data);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.NotEligible.selector);
        items.buy(itemId, 1, recipient, "");
    }

    function test_e2e_sbt_buySucceeds_afterAcquiringSBT() external {
        bytes memory data = abi.encode(address(sbt), uint256(1));
        uint256 itemId = _addItemWithValidator(address(sbtValidator), data);

        // First attempt without SBT should fail
        vm.prank(buyer);
        vm.expectRevert(MyShopItems.NotEligible.selector);
        items.buy(itemId, 1, recipient, "");

        // Mint SBT and retry
        sbt.mint(buyer, 1);

        vm.prank(buyer);
        items.buy(itemId, 1, recipient, "");
        assertEq(items.itemSoldCount(itemId), 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TokenBalanceValidator — end-to-end via MyShopItems.buy()
    // ─────────────────────────────────────────────────────────────────────────

    function test_e2e_token_buySucceeds_whenEligible() external {
        govToken.mint(buyer, 100 ether);
        bytes memory data = abi.encode(address(govToken), uint256(100 ether));
        uint256 itemId = _addItemWithValidator(address(tokenValidator), data);

        vm.prank(buyer);
        items.buy(itemId, 1, recipient, "");

        assertEq(items.itemSoldCount(itemId), 1);
    }

    function test_e2e_token_buyReverts_whenBelowMinAmount() external {
        govToken.mint(buyer, 50 ether);
        bytes memory data = abi.encode(address(govToken), uint256(100 ether));
        uint256 itemId = _addItemWithValidator(address(tokenValidator), data);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.NotEligible.selector);
        items.buy(itemId, 1, recipient, "");
    }

    function test_e2e_token_buyReverts_whenNoTokenBalance() external {
        bytes memory data = abi.encode(address(govToken), uint256(1 ether));
        uint256 itemId = _addItemWithValidator(address(tokenValidator), data);

        vm.prank(buyer);
        vm.expectRevert(MyShopItems.NotEligible.selector);
        items.buy(itemId, 1, recipient, "");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Whitelist enforcement
    // ─────────────────────────────────────────────────────────────────────────

    function test_addItem_reverts_whenValidatorNotWhitelisted() external {
        SBTHolderValidator unwhitelisted = new SBTHolderValidator();
        bytes memory data = abi.encode(address(sbt), uint256(1));

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
            eligibilityValidator: address(unwhitelisted),
            eligibilityValidatorData: data
        });

        vm.prank(community);
        vm.expectRevert(MyShopItems.ValidatorNotAllowed.selector);
        items.addItem(p);
    }
}
