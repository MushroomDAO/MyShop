// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

/// @notice Callback interface for JuryContract verdict notification
/// @dev Mirrors ITaskCallback from MyTask ecosystem; implement this in DisputeEscrow
interface IJuryCallback {
    /// @param contextId The purchaseId of the disputed transaction
    /// @param finalScore The jury's final score (0-100)
    /// @param buyerWins True if consensus reached AND score favors buyer
    function onTaskFinalized(bytes32 contextId, uint256 finalScore, bool buyerWins) external;
}
