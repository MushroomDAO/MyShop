pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {TransferRewardAction} from "../src/actions/TransferRewardAction.sol";
import {MockERC20Mintable} from "./mocks/MockERC20Mintable.sol";

/// @dev transferFrom 返回 false(不 revert)的非标准 ERC20,用于覆盖 TransferFailed 分支。
contract ReturnFalseToken {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract TransferRewardActionTest is Test {
    uint256 internal constant SHOP_ID = 1;

    address internal treasury = address(0xC0FFEE);
    address internal itemsContract = address(0x17E45);
    address internal recipient = address(0xF00D);
    address internal stranger = address(0xBAD);

    MockERC20Mintable internal xpnts;
    TransferRewardAction internal action;

    function setUp() external {
        xpnts = new MockERC20Mintable("xPNTs", "xPNTs", 18);
        action = new TransferRewardAction(address(xpnts), treasury, SHOP_ID);
        vm.prank(treasury);
        action.setItems(itemsContract);
    }

    function _execute(address caller, uint256 shopId, uint256 amountPerUnit, uint256 quantity) internal {
        vm.prank(caller);
        action.execute(address(0xB0A7), recipient, 1, shopId, quantity, abi.encode(amountPerUnit), "");
    }

    function _fundAndApprove(uint256 balance, uint256 allowance) internal {
        xpnts.mint(treasury, balance);
        vm.prank(treasury);
        xpnts.approve(address(action), allowance);
    }

    function test_constructor_rejectsZeroValues() external {
        vm.expectRevert(TransferRewardAction.InvalidAddress.selector);
        new TransferRewardAction(address(0), treasury, SHOP_ID);

        vm.expectRevert(TransferRewardAction.InvalidAddress.selector);
        new TransferRewardAction(address(xpnts), address(0), SHOP_ID);

        vm.expectRevert(TransferRewardAction.InvalidShopId.selector);
        new TransferRewardAction(address(xpnts), treasury, 0);
    }

    function test_setItems_onlyTreasury() external {
        TransferRewardAction fresh = new TransferRewardAction(address(xpnts), treasury, SHOP_ID);

        // 部署者也无权,只有金库(资金所有方)能绑
        vm.expectRevert(TransferRewardAction.NotTreasury.selector);
        fresh.setItems(itemsContract);

        vm.prank(stranger);
        vm.expectRevert(TransferRewardAction.NotTreasury.selector);
        fresh.setItems(stranger);
    }

    function test_setItems_isOneShot() external {
        vm.prank(treasury);
        vm.expectRevert(TransferRewardAction.ItemsAlreadySet.selector);
        action.setItems(address(0xDEAD));
    }

    function test_execute_reverts_whenCallerNotItems() external {
        _fundAndApprove(1_000 ether, type(uint256).max);

        // 对齐 MyShopItems 的调用方约束:只有 items 合约(buy 内 _executeAction)可触发发放
        vm.expectRevert(TransferRewardAction.NotItems.selector);
        _execute(stranger, SHOP_ID, 50 ether, 1);

        vm.expectRevert(TransferRewardAction.NotItems.selector);
        _execute(treasury, SHOP_ID, 50 ether, 1);
    }

    function test_execute_reverts_whenShopIdNotAllowed() external {
        _fundAndApprove(1_000 ether, type(uint256).max);

        // H1:其他店铺即使把本 action 挂上商品(全局 allowlist),也无法从本金库发放
        vm.expectRevert(TransferRewardAction.ShopNotAllowed.selector);
        _execute(itemsContract, SHOP_ID + 1, 50 ether, 1);
    }

    function test_execute_reverts_whenTreasuryNotApproved() external {
        xpnts.mint(treasury, 1_000 ether);
        // 金库未对 action approve
        vm.expectRevert(bytes("ALLOWANCE"));
        _execute(itemsContract, SHOP_ID, 50 ether, 1);
    }

    function test_execute_reverts_whenExactAllowanceExhausted() external {
        _fundAndApprove(1_000 ether, 100 ether);

        _execute(itemsContract, SHOP_ID, 50 ether, 2);
        assertEq(xpnts.allowance(treasury, address(action)), 0);

        // 精确额度耗尽后,下一次发放 revert
        vm.expectRevert(bytes("ALLOWANCE"));
        _execute(itemsContract, SHOP_ID, 50 ether, 1);
    }

    function test_execute_reverts_whenTreasuryBalanceInsufficient() external {
        _fundAndApprove(10 ether, type(uint256).max);

        vm.expectRevert(bytes("BAL"));
        _execute(itemsContract, SHOP_ID, 50 ether, 1);
    }

    function test_execute_reverts_whenTransferFromReturnsFalse() external {
        TransferRewardAction falseAction =
            new TransferRewardAction(address(new ReturnFalseToken()), treasury, SHOP_ID);
        vm.prank(treasury);
        falseAction.setItems(itemsContract);

        vm.prank(itemsContract);
        vm.expectRevert(TransferRewardAction.TransferFailed.selector);
        falseAction.execute(address(0xB0A7), recipient, 1, SHOP_ID, 1, abi.encode(uint256(1 ether)), "");
    }

    function test_execute_paysReward_fromTreasury() external {
        _fundAndApprove(1_000 ether, type(uint256).max);

        _execute(itemsContract, SHOP_ID, 50 ether, 3);

        // 从金库转账发放,总供给不变(无任何新铸)
        assertEq(xpnts.balanceOf(recipient), 150 ether);
        assertEq(xpnts.balanceOf(treasury), 850 ether);
        assertEq(xpnts.totalSupply(), 1_000 ether);
    }
}
