pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {TransferRewardAction} from "../src/actions/TransferRewardAction.sol";
import {MockERC20Mintable} from "../src/mocks/MockERC20Mintable.sol";

/// @dev transferFrom 返回 false(不 revert)的非标准 ERC20,用于覆盖 TransferFailed 分支。
contract ReturnFalseToken {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract TransferRewardActionTest is Test {
    address internal treasury = address(0xC0FFEE);
    address internal itemsContract = address(0x17E45);
    address internal recipient = address(0xF00D);
    address internal stranger = address(0xBAD);

    MockERC20Mintable internal xpnts;
    TransferRewardAction internal action;

    function setUp() external {
        xpnts = new MockERC20Mintable("xPNTs", "xPNTs", 18);
        action = new TransferRewardAction(address(xpnts), treasury);
        action.setItems(itemsContract);
    }

    function _execute(address caller, uint256 amountPerUnit, uint256 quantity) internal {
        vm.prank(caller);
        action.execute(address(0xB0A7), recipient, 1, 1, quantity, abi.encode(amountPerUnit), "");
    }

    function test_constructor_rejectsZeroAddresses() external {
        vm.expectRevert(TransferRewardAction.InvalidAddress.selector);
        new TransferRewardAction(address(0), treasury);

        vm.expectRevert(TransferRewardAction.InvalidAddress.selector);
        new TransferRewardAction(address(xpnts), address(0));
    }

    function test_setItems_onlyOwner() external {
        vm.prank(stranger);
        vm.expectRevert(TransferRewardAction.NotOwner.selector);
        action.setItems(stranger);
    }

    function test_execute_reverts_whenCallerNotItems() external {
        xpnts.mint(treasury, 1_000 ether);
        vm.prank(treasury);
        xpnts.approve(address(action), type(uint256).max);

        // 对齐 MyShopItems 的调用方约束:只有 items 合约(buy 内 _executeAction)可触发发放
        vm.expectRevert(TransferRewardAction.NotItems.selector);
        _execute(stranger, 50 ether, 1);

        vm.expectRevert(TransferRewardAction.NotItems.selector);
        _execute(treasury, 50 ether, 1);
    }

    function test_execute_reverts_whenTreasuryNotApproved() external {
        xpnts.mint(treasury, 1_000 ether);
        // 金库未对 action approve
        vm.expectRevert(bytes("ALLOWANCE"));
        _execute(itemsContract, 50 ether, 1);
    }

    function test_execute_reverts_whenTreasuryBalanceInsufficient() external {
        xpnts.mint(treasury, 10 ether);
        vm.prank(treasury);
        xpnts.approve(address(action), type(uint256).max);

        vm.expectRevert(bytes("BAL"));
        _execute(itemsContract, 50 ether, 1);
    }

    function test_execute_reverts_whenTransferFromReturnsFalse() external {
        TransferRewardAction falseAction = new TransferRewardAction(address(new ReturnFalseToken()), treasury);
        falseAction.setItems(itemsContract);

        vm.prank(itemsContract);
        vm.expectRevert(TransferRewardAction.TransferFailed.selector);
        falseAction.execute(address(0xB0A7), recipient, 1, 1, 1, abi.encode(uint256(1 ether)), "");
    }

    function test_execute_paysReward_fromTreasury() external {
        xpnts.mint(treasury, 1_000 ether);
        vm.prank(treasury);
        xpnts.approve(address(action), type(uint256).max);

        _execute(itemsContract, 50 ether, 3);

        // 从金库转账发放,总供给不变(无任何新铸)
        assertEq(xpnts.balanceOf(recipient), 150 ether);
        assertEq(xpnts.balanceOf(treasury), 850 ether);
        assertEq(xpnts.totalSupply(), 1_000 ether);
    }
}
