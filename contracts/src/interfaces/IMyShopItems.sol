// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

interface IMyShopItems {
    function isInDisputeWindow(bytes32 purchaseId) external view returns (bool);
    function purchaseTimestamps(bytes32 purchaseId) external view returns (uint256);
}
