// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

import {IEligibilityValidator} from "../interfaces/IEligibilityValidator.sol";

interface IERC721Balance {
    function balanceOf(address owner) external view returns (uint256);
}

/// @notice Validates that the buyer holds >= minBalance tokens of a given NFT/SBT contract.
/// validatorData encoding: abi.encode(address nftContract, uint256 minBalance)
contract SBTHolderValidator is IEligibilityValidator {
    function checkEligibility(
        address buyer,
        address, // recipient — unused
        uint256, // itemId — unused
        uint256, // shopId — unused
        uint256, // quantity — unused
        bytes calldata validatorData,
        bytes calldata  // extraData — unused
    ) external view override returns (bool eligible) {
        if (validatorData.length < 64) return false; // malformed data → fail closed
        (address nftContract, uint256 minBalance) = abi.decode(validatorData, (address, uint256));
        if (nftContract == address(0)) return false; // misconfigured → fail closed (not open)
        uint256 bal = IERC721Balance(nftContract).balanceOf(buyer);
        return bal >= minBalance;
    }
}
