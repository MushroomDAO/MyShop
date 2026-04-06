// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {IMyShopItems} from "./interfaces/IMyShopItems.sol";
import {IJuryCallback} from "./interfaces/IJuryCallback.sol";

/// @title DisputeEscrow
/// @notice Holds buyer payment in escrow during dispute period; releases to shop or refunds buyer
///         based on JuryContract verdict via IJuryCallback.
/// @dev M4 implementation. JuryContract address is set by protocol owner (mutable for upgrade path).
contract DisputeEscrow is IJuryCallback {
    address public owner;
    IMyShopItems public immutable itemsContract;
    address public juryContract; // set by owner; mutable to allow JuryContract upgrade

    struct Dispute {
        address buyer;
        address shopTreasury;
        address payToken;      // address(0) = ETH
        uint256 amount;        // total disputed amount
        bytes32 purchaseId;
        uint256 openedAt;
        DisputeStatus status;
    }

    // None=0 is the zero-value sentinel so uninitialized disputes are NOT mistaken for Open.
    enum DisputeStatus { None, Open, Resolved, Cancelled }

    mapping(bytes32 => Dispute) public disputes; // disputeId => Dispute
    mapping(bytes32 => bool) public purchaseDisputed; // purchaseId => already disputed

    uint256 public constant MAX_EVIDENCE_SIZE = 1024; // bytes, IPFS CID is 46-59 chars

    event DisputeOpened(bytes32 indexed disputeId, bytes32 indexed purchaseId, address indexed buyer, uint256 amount);
    event DisputeResolved(bytes32 indexed disputeId, bool buyerWins, uint256 amount);
    event DisputeCancelled(bytes32 indexed disputeId);
    event JuryContractUpdated(address indexed oldJury, address indexed newJury);

    error NotOwner();
    error NotJuryContract();
    error DisputeAlreadyOpen();
    error PurchaseNotInDisputeWindow();
    error DisputeNotOpen();
    error DisputeNotFound();
    error InvalidAddress();
    error ZeroAmount();
    error EvidenceTooLarge();
    error TransferFailed();
    error IncorrectEthAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address itemsContract_, address juryContract_) {
        if (itemsContract_ == address(0)) revert InvalidAddress();
        owner = msg.sender;
        itemsContract = IMyShopItems(itemsContract_);
        juryContract = juryContract_; // can be address(0) initially
    }

    /// @notice Owner sets the JuryContract address. Must be non-zero to prevent permanently
    ///         locking open disputes (only the cancel path would remain if jury is address(0)).
    function setJuryContract(address jury) external onlyOwner {
        if (jury == address(0)) revert InvalidAddress();
        emit JuryContractUpdated(juryContract, jury);
        juryContract = jury;
    }

    /// @notice Buyer opens a dispute for a purchase still within the dispute window.
    ///         For ERC20 purchases: buyer must pre-approve this contract for `payToken` `amount`.
    ///         For ETH purchases: buyer must send exactly `amount` as msg.value.
    /// @param purchaseId keccak256(abi.encode(itemId, firstTokenId, buyer, purchaseTimestamp))
    /// @param payToken ERC20 token address, or address(0) for ETH (must match original purchase)
    /// @param amount Amount to escrow (typically the purchase price)
    /// @param shopTreasury Shop's treasury (receives funds if shop wins); must be non-zero
    /// @param evidence IPFS CID string of the evidence package (<=1024 bytes)
    function openDispute(
        bytes32 purchaseId,
        address payToken,
        uint256 amount,
        address shopTreasury,
        string calldata evidence
    ) external payable returns (bytes32 disputeId) {
        if (amount == 0) revert ZeroAmount();
        if (shopTreasury == address(0)) revert InvalidAddress();
        if (purchaseDisputed[purchaseId]) revert DisputeAlreadyOpen();
        if (!itemsContract.isInDisputeWindow(purchaseId)) revert PurchaseNotInDisputeWindow();
        if (bytes(evidence).length > MAX_EVIDENCE_SIZE) revert EvidenceTooLarge();

        disputeId = keccak256(abi.encode(purchaseId, msg.sender, block.timestamp));
        purchaseDisputed[purchaseId] = true;

        disputes[disputeId] = Dispute({
            buyer: msg.sender,
            shopTreasury: shopTreasury,
            payToken: payToken,
            amount: amount,
            purchaseId: purchaseId,
            openedAt: block.timestamp,
            status: DisputeStatus.Open
        });

        // Pull funds into escrow — state is written first (CEI pattern)
        if (payToken == address(0)) {
            // ETH dispute: caller must send exactly `amount` as msg.value
            if (msg.value != amount) revert IncorrectEthAmount();
        } else {
            // ERC20 dispute: no ETH should be sent
            if (msg.value != 0) revert IncorrectEthAmount();
            bool ok = IERC20(payToken).transferFrom(msg.sender, address(this), amount);
            if (!ok) revert TransferFailed();
        }

        emit DisputeOpened(disputeId, purchaseId, msg.sender, amount);
    }

    /// @notice Called by JuryContract after finalizeTask().
    ///         contextId = disputeId (set when creating the jury task).
    function onTaskFinalized(bytes32 contextId, uint256, bool buyerWins) external override {
        if (msg.sender != juryContract) revert NotJuryContract();
        Dispute storage d = disputes[contextId];
        // None is the zero-value; guard against phantom contextIds that never had a dispute opened
        if (d.status == DisputeStatus.None) revert DisputeNotFound();
        if (d.status != DisputeStatus.Open) revert DisputeNotOpen();

        d.status = DisputeStatus.Resolved;

        address recipient = buyerWins ? d.buyer : d.shopTreasury;
        _release(d.payToken, recipient, d.amount);

        emit DisputeResolved(contextId, buyerWins, d.amount);
    }

    /// @notice Owner can cancel a stuck dispute and return funds to buyer.
    function cancelDispute(bytes32 disputeId) external onlyOwner {
        Dispute storage d = disputes[disputeId];
        if (d.status != DisputeStatus.Open) revert DisputeNotOpen();
        d.status = DisputeStatus.Cancelled;
        _release(d.payToken, d.buyer, d.amount);
        emit DisputeCancelled(disputeId);
    }

    function _release(address payToken, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (payToken == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            bool ok = IERC20(payToken).transfer(to, amount);
            if (!ok) revert TransferFailed();
        }
    }

    receive() external payable {}
}
