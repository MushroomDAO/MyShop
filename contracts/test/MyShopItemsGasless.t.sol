// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {MyShops} from "../src/MyShops.sol";
import {MyShopItems} from "../src/MyShopItems.sol";
import {MintERC20Action} from "../src/actions/MintERC20Action.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockERC20Mintable} from "../src/mocks/MockERC20Mintable.sol";
import {MockCommunityNFT} from "../src/mocks/MockCommunityNFT.sol";

/// @title MyShopItemsGaslessTest
/// @notice Tests for C12: buyGasless() ERC-4337 compatible purchase path.
///         buyGasless() accepts an explicit `payer` address separate from msg.sender,
///         so that when an AA wallet (msg.sender) calls on behalf of an EOA (payer),
///         the SerialPermit and nonce verification use the EOA identity.
contract MyShopItemsGaslessTest is Test {
    bytes32 internal constant ROLE_COMMUNITY = keccak256("COMMUNITY");

    uint256 internal constant RISK_PK = 0xA11CE;
    uint256 internal constant SERIAL_PK = 0xB0B;

    address internal riskSigner;
    address internal serialSigner;

    address internal platformTreasury = address(0xBEEF);
    address internal community = address(0xCAFE);
    address internal communityTreasury = address(0xC0FFEE);

    // In a gasless flow: aaWallet is msg.sender (the smart wallet / EntryPoint caller),
    // eoa is the actual economic actor whose permit was signed.
    address internal eoa = address(0xE0A);
    address internal aaWallet = address(0xAA07);
    address internal recipient = address(0xF00D);

    MockRegistry internal registry;
    MockERC20Mintable internal apnts;
    MockERC20Mintable internal usdc;
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
        nft = new MockCommunityNFT();
        action = new MintERC20Action();

        shops = new MyShops(address(registry), platformTreasury, address(apnts), 100 ether, 300);
        items = new MyShopItems(address(shops), riskSigner, serialSigner);
        items.setActionAllowed(address(action), true);

        registry.setHasRole(ROLE_COMMUNITY, community, true);

        vm.prank(community);
        shops.registerShop(communityTreasury, bytes32(uint256(1)));

        apnts.mint(community, 10_000 ether);

        // The AA wallet holds USDC and approves the items contract — in a real UserOp
        // the paymaster would front the gas; the token payment still comes from the wallet.
        usdc.mint(aaWallet, 1_000_000_000);
        vm.prank(aaWallet);
        usdc.approve(address(items), type(uint256).max);

        vm.prank(community);
        apnts.approve(address(items), type(uint256).max);
    }

    // ----------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------

    function _addItem(bool requiresSerial) internal returns (uint256 itemId) {
        MyShopItems.AddItemParams memory p = MyShopItems.AddItemParams({
            shopId: 1,
            payToken: address(usdc),
            unitPrice: 1000,
            nftContract: address(nft),
            soulbound: false,
            tokenURI: "ipfs://token",
            action: address(action),
            actionData: abi.encode(address(apnts), 50 ether),
            requiresSerial: requiresSerial,
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
        itemId = items.addItem(p);
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

    // ----------------------------------------------------------------
    // test_BuyGasless_SameAsRegularBuy
    // When payer == address(0), buyGasless falls back to msg.sender
    // and the result is identical to calling buy() directly.
    // ----------------------------------------------------------------
    function test_BuyGasless_SameAsRegularBuy() external {
        uint256 itemId = _addItem(false);

        uint256 platformBefore = usdc.balanceOf(platformTreasury);
        uint256 shopBefore = usdc.balanceOf(communityTreasury);

        // aaWallet calls buyGasless with payer == address(0) → effectivePayer = aaWallet
        vm.prank(aaWallet);
        uint256 firstTokenId = items.buyGasless(itemId, 1, recipient, address(0), "");

        assertEq(firstTokenId, 1);
        assertEq(nft.ownerOf(1), recipient);

        // Fee split must be identical to a normal buy()
        assertEq(usdc.balanceOf(platformTreasury) - platformBefore, 30);  // 3% of 1000
        assertEq(usdc.balanceOf(communityTreasury) - shopBefore, 970);
    }

    // ----------------------------------------------------------------
    // test_BuyGasless_ExplicitPayer
    // When payer != address(0), the explicit payer address is used for
    // SerialPermit verification (permit must be signed for payer, not aaWallet).
    // ----------------------------------------------------------------
    function test_BuyGasless_ExplicitPayer() external {
        uint256 itemId = _addItem(true); // requiresSerial = true

        // Sign the SerialPermit for the EOA (payer), NOT the aaWallet
        bytes32 serialHash = keccak256(abi.encodePacked("GASLESS-SERIAL-001"));
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = 0;
        bytes memory sig = _signSerialPermit(itemId, eoa, serialHash, deadline, nonce);
        bytes memory extraData = abi.encode(serialHash, deadline, nonce, sig);

        uint256 platformBefore = usdc.balanceOf(platformTreasury);
        uint256 shopBefore = usdc.balanceOf(communityTreasury);

        // aaWallet acts as caller (EntryPoint / Paymaster submits the UserOp),
        // but the permit was issued to eoa → pass eoa as explicit payer.
        vm.prank(aaWallet);
        uint256 firstTokenId = items.buyGasless(itemId, 1, recipient, eoa, extraData);

        assertEq(firstTokenId, 1);
        assertEq(nft.ownerOf(1), recipient);
        assertEq(usdc.balanceOf(platformTreasury) - platformBefore, 30);
        assertEq(usdc.balanceOf(communityTreasury) - shopBefore, 970);

        // The nonce should be consumed against the EOA's account, not the aaWallet's
        assertTrue(items.usedNonces(eoa, nonce));
        assertFalse(items.usedNonces(aaWallet, nonce));
    }

    // ----------------------------------------------------------------
    // test_BuyGasless_ExplicitPayer_WrongPermitSigner_Reverts
    // If the serial permit is signed for aaWallet but payer=eoa is passed,
    // the contract must reject it (buyer mismatch in EIP-712 struct).
    // ----------------------------------------------------------------
    function test_BuyGasless_ExplicitPayer_WrongPermitSigner_Reverts() external {
        uint256 itemId = _addItem(true);

        // Sign the permit for aaWallet, NOT for eoa
        bytes32 serialHash = keccak256(abi.encodePacked("WRONG-SERIAL"));
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = 0;
        bytes memory sig = _signSerialPermit(itemId, aaWallet, serialHash, deadline, nonce);
        bytes memory extraData = abi.encode(serialHash, deadline, nonce, sig);

        vm.prank(aaWallet);
        vm.expectRevert(MyShopItems.InvalidSignature.selector);
        items.buyGasless(itemId, 1, recipient, eoa, extraData);
    }

    // ----------------------------------------------------------------
    // test_BuyGasless_ReplayProtection
    // The nonce used via buyGasless cannot be replayed.
    // ----------------------------------------------------------------
    function test_BuyGasless_ReplayProtection() external {
        uint256 itemId = _addItem(true);

        bytes32 serialHash = keccak256(abi.encodePacked("REPLAY-SERIAL"));
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = 0;
        bytes memory sig = _signSerialPermit(itemId, eoa, serialHash, deadline, nonce);
        bytes memory extraData = abi.encode(serialHash, deadline, nonce, sig);

        // Give aaWallet extra USDC for the second call attempt
        usdc.mint(aaWallet, 1_000_000_000);

        vm.prank(aaWallet);
        items.buyGasless(itemId, 1, recipient, eoa, extraData);

        // Second call with the same nonce must fail
        vm.prank(aaWallet);
        vm.expectRevert(MyShopItems.NonceUsed.selector);
        items.buyGasless(itemId, 1, recipient, eoa, extraData);
    }

    // ----------------------------------------------------------------
    // test_BuyGasless_PayerNonceConsumption
    //
    // DESIGN TRADE-OFF (known limitation):
    //   buyGasless() accepts an arbitrary `payer` address from msg.sender.
    //   A malicious relayer/attacker who holds a valid signed SerialPermit
    //   for a victim (e.g. obtained off-chain) can call buyGasless with
    //   payer=victim, consuming the victim's nonce and forcing the victim's
    //   permit to be spent.
    //
    //   MITIGATION (off-chain / worker layer):
    //     - The permit server (worker) only issues SerialPermits to
    //       trusted relayers identified by allowlist or HMAC session tokens.
    //     - Permit payloads are single-use and short-lived (deadline << 1 hr).
    //     - The worker records issued permits and can detect reuse attempts.
    //   This trade-off is acceptable because on-chain identity binding would
    //   require msg.sender == payer, defeating the purpose of AA relaying.
    // ----------------------------------------------------------------
    function test_BuyGasless_PayerNonceConsumption() external {
        // Attacker obtains a permit signed for `eoa` (the victim). In practice
        // this could happen if a relay leaks the signed permit off-chain.
        uint256 itemId = _addItem(true);

        bytes32 serialHash = keccak256(abi.encodePacked("VICTIM-SERIAL-001"));
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = 42; // arbitrary nonce that has not been used yet
        bytes memory sig = _signSerialPermit(itemId, eoa, serialHash, deadline, nonce);
        bytes memory extraData = abi.encode(serialHash, deadline, nonce, sig);

        // Attacker is a different address that holds USDC and is not eoa.
        address attacker = address(0xA77AC4);
        usdc.mint(attacker, 1_000_000_000);
        vm.prank(attacker);
        usdc.approve(address(items), type(uint256).max);

        // Attacker calls buyGasless, setting payer=eoa (the victim).
        // The call succeeds because the contract only verifies the permit's
        // signature against the stated payer — it does NOT require msg.sender == payer.
        vm.prank(attacker);
        items.buyGasless(itemId, 1, attacker, eoa, extraData);

        // The victim's nonce is now consumed even though the victim did not call.
        assertTrue(items.usedNonces(eoa, nonce), "victim nonce consumed by attacker call");
        assertFalse(items.usedNonces(attacker, nonce), "attacker nonce unaffected");

        // A subsequent attempt to use the same permit (e.g. by the real relayer) fails.
        vm.prank(aaWallet);
        vm.expectRevert(MyShopItems.NonceUsed.selector);
        items.buyGasless(itemId, 1, recipient, eoa, extraData);
    }
}
