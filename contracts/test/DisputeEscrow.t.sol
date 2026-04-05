// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

import {Test} from "forge-std/Test.sol";

import {DisputeEscrow} from "../src/DisputeEscrow.sol";
import {IMyShopItems} from "../src/interfaces/IMyShopItems.sol";
import {IJuryCallback} from "../src/interfaces/IJuryCallback.sol";
import {MockERC20Mintable} from "../src/mocks/MockERC20Mintable.sol";

/// @dev Minimal mock for IMyShopItems — controls dispute window externally
contract MockMyShopItems is IMyShopItems {
    mapping(bytes32 => bool) public windowOpen;
    mapping(bytes32 => uint256) public purchaseTimestamps;

    function setWindowOpen(bytes32 purchaseId, bool open) external {
        windowOpen[purchaseId] = open;
    }

    function setPurchaseTimestamp(bytes32 purchaseId, uint256 ts) external {
        purchaseTimestamps[purchaseId] = ts;
    }

    function isInDisputeWindow(bytes32 purchaseId) external view returns (bool) {
        return windowOpen[purchaseId];
    }
}

contract DisputeEscrowTest is Test {
    DisputeEscrow internal escrow;
    MockMyShopItems internal mockItems;
    MockERC20Mintable internal usdc;

    address internal owner = address(this);
    address internal buyer = address(0xB0A7);
    address internal shopTreasury = address(0xC0FFEE);
    address internal juryAddr = address(0x1234);

    bytes32 internal constant PURCHASE_ID = keccak256("purchase1");
    uint256 internal constant AMOUNT = 1000e6; // 1000 USDC
    string internal constant EVIDENCE = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    function setUp() external {
        mockItems = new MockMyShopItems();
        usdc = new MockERC20Mintable("USDC", "USDC", 6);
        escrow = new DisputeEscrow(address(mockItems), juryAddr);

        // Fund buyer and approve escrow
        usdc.mint(buyer, 10_000e6);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);

        // Default: purchase is within dispute window
        mockItems.setWindowOpen(PURCHASE_ID, true);
    }

    // -----------------------------------------------------------------------
    // openDispute — happy path
    // -----------------------------------------------------------------------

    function test_openDispute_success() external {
        vm.prank(buyer);
        bytes32 disputeId = escrow.openDispute(PURCHASE_ID, address(usdc), AMOUNT, shopTreasury, EVIDENCE);

        // Funds escrowed
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdc.balanceOf(buyer), 10_000e6 - AMOUNT);

        // Dispute recorded correctly
        (
            address dBuyer,
            address dTreasury,
            address dToken,
            uint256 dAmount,
            bytes32 dPurchaseId,
            ,
            DisputeEscrow.DisputeStatus dStatus
        ) = escrow.disputes(disputeId);

        assertEq(dBuyer, buyer);
        assertEq(dTreasury, shopTreasury);
        assertEq(dToken, address(usdc));
        assertEq(dAmount, AMOUNT);
        assertEq(dPurchaseId, PURCHASE_ID);
        assertEq(uint8(dStatus), uint8(DisputeEscrow.DisputeStatus.Open));

        // purchaseDisputed flag set
        assertTrue(escrow.purchaseDisputed(PURCHASE_ID));
    }

    // -----------------------------------------------------------------------
    // openDispute — revert after window closed
    // -----------------------------------------------------------------------

    function test_openDispute_reverts_afterWindow() external {
        mockItems.setWindowOpen(PURCHASE_ID, false);

        vm.prank(buyer);
        vm.expectRevert(DisputeEscrow.PurchaseNotInDisputeWindow.selector);
        escrow.openDispute(PURCHASE_ID, address(usdc), AMOUNT, shopTreasury, EVIDENCE);
    }

    // -----------------------------------------------------------------------
    // openDispute — revert if already open for same purchaseId
    // -----------------------------------------------------------------------

    function test_openDispute_reverts_alreadyOpen() external {
        vm.prank(buyer);
        escrow.openDispute(PURCHASE_ID, address(usdc), AMOUNT, shopTreasury, EVIDENCE);

        vm.prank(buyer);
        vm.expectRevert(DisputeEscrow.DisputeAlreadyOpen.selector);
        escrow.openDispute(PURCHASE_ID, address(usdc), AMOUNT, shopTreasury, EVIDENCE);
    }

    // -----------------------------------------------------------------------
    // onTaskFinalized — buyer wins → buyer refunded
    // -----------------------------------------------------------------------

    function test_onTaskFinalized_buyerWins() external {
        vm.prank(buyer);
        bytes32 disputeId = escrow.openDispute(PURCHASE_ID, address(usdc), AMOUNT, shopTreasury, EVIDENCE);

        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(juryAddr);
        escrow.onTaskFinalized(disputeId, 80, true); // score 80, buyer wins

        // Buyer gets funds back
        assertEq(usdc.balanceOf(buyer), buyerBefore + AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        // Status = Resolved
        (,,,,, , DisputeEscrow.DisputeStatus status) = escrow.disputes(disputeId);
        assertEq(uint8(status), uint8(DisputeEscrow.DisputeStatus.Resolved));
    }

    // -----------------------------------------------------------------------
    // onTaskFinalized — shop wins → shopTreasury gets funds
    // -----------------------------------------------------------------------

    function test_onTaskFinalized_shopWins() external {
        vm.prank(buyer);
        bytes32 disputeId = escrow.openDispute(PURCHASE_ID, address(usdc), AMOUNT, shopTreasury, EVIDENCE);

        uint256 shopBefore = usdc.balanceOf(shopTreasury);

        vm.prank(juryAddr);
        escrow.onTaskFinalized(disputeId, 20, false); // score 20, shop wins

        // Shop treasury gets the funds
        assertEq(usdc.balanceOf(shopTreasury), shopBefore + AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        // Status = Resolved
        (,,,,, , DisputeEscrow.DisputeStatus status) = escrow.disputes(disputeId);
        assertEq(uint8(status), uint8(DisputeEscrow.DisputeStatus.Resolved));
    }

    // -----------------------------------------------------------------------
    // onTaskFinalized — non-jury caller reverts
    // -----------------------------------------------------------------------

    function test_onTaskFinalized_reverts_notJury() external {
        vm.prank(buyer);
        bytes32 disputeId = escrow.openDispute(PURCHASE_ID, address(usdc), AMOUNT, shopTreasury, EVIDENCE);

        vm.prank(address(0xBAD));
        vm.expectRevert(DisputeEscrow.NotJuryContract.selector);
        escrow.onTaskFinalized(disputeId, 80, true);
    }

    // -----------------------------------------------------------------------
    // cancelDispute — owner cancels, buyer refunded
    // -----------------------------------------------------------------------

    function test_cancelDispute_returnsTobuyer() external {
        vm.prank(buyer);
        bytes32 disputeId = escrow.openDispute(PURCHASE_ID, address(usdc), AMOUNT, shopTreasury, EVIDENCE);

        uint256 buyerBefore = usdc.balanceOf(buyer);

        // Owner (address(this)) cancels
        escrow.cancelDispute(disputeId);

        assertEq(usdc.balanceOf(buyer), buyerBefore + AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        (,,,,, , DisputeEscrow.DisputeStatus status) = escrow.disputes(disputeId);
        assertEq(uint8(status), uint8(DisputeEscrow.DisputeStatus.Cancelled));
    }

    // -----------------------------------------------------------------------
    // setJuryContract — only owner
    // -----------------------------------------------------------------------

    function test_setJuryContract_onlyOwner() external {
        address newJury = address(0x9999);
        escrow.setJuryContract(newJury);
        assertEq(escrow.juryContract(), newJury);
    }

    function test_setJuryContract_reverts_notOwner() external {
        vm.prank(buyer);
        vm.expectRevert(DisputeEscrow.NotOwner.selector);
        escrow.setJuryContract(address(0x9999));
    }

    // -----------------------------------------------------------------------
    // openDispute — evidence too large reverts
    // -----------------------------------------------------------------------

    function test_openDispute_reverts_evidenceTooLarge() external {
        // Build a string > 1024 bytes
        bytes memory bigEvidence = new bytes(1025);
        for (uint256 i = 0; i < 1025; i++) bigEvidence[i] = 0x61; // 'a'

        vm.prank(buyer);
        vm.expectRevert(DisputeEscrow.EvidenceTooLarge.selector);
        escrow.openDispute(PURCHASE_ID, address(usdc), AMOUNT, shopTreasury, string(bigEvidence));
    }
}
