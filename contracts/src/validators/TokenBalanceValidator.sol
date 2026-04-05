// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

import {IEligibilityValidator} from "../interfaces/IEligibilityValidator.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice Validates that the buyer holds >= minAmount of a given ERC20 token.
/// validatorData encoding: abi.encode(address token, uint256 minAmount)
contract TokenBalanceValidator is IEligibilityValidator {
    function checkEligibility(
        address buyer,
        address,
        uint256,
        uint256,
        uint256,
        bytes calldata validatorData,
        bytes calldata
    ) external view override returns (bool eligible) {
        if (validatorData.length < 64) return false; // malformed data → fail closed
        (address token, uint256 minAmount) = abi.decode(validatorData, (address, uint256));
        if (token == address(0)) return false; // misconfigured → fail closed
        return IERC20(token).balanceOf(buyer) >= minAmount;
    }
}
