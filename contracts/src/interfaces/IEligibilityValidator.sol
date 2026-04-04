// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

/// @title IEligibilityValidator
/// @notice Ecosystem-level interface for on-chain buyer eligibility checks.
/// @dev Validators must be whitelisted by the protocol owner (allowedValidators).
///      Called by MyShopItems.buy() when item.eligibilityValidator != address(0).
interface IEligibilityValidator {
    /// @notice Check if a buyer is eligible to purchase an item.
    /// @param buyer     The address initiating the purchase (msg.sender in buy())
    /// @param recipient The NFT recipient address
    /// @param itemId    The item being purchased
    /// @param shopId    The shop the item belongs to
    /// @param quantity  Number of units being purchased
    /// @param validatorData Arbitrary data configured per-item by the shop owner
    /// @param extraData Arbitrary data passed by the buyer in buy() extraData
    /// @return eligible True if the buyer is allowed to purchase
    function checkEligibility(
        address buyer,
        address recipient,
        uint256 itemId,
        uint256 shopId,
        uint256 quantity,
        bytes calldata validatorData,
        bytes calldata extraData
    ) external view returns (bool eligible);
}
