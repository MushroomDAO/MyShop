pragma solidity ^0.8.20;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice MS-1: 取代 MintERC20Action 的积分发放 Action。
/// 本合约不持有任何 mint 权:奖励从店铺金库(社区 owner 预先 mint 好的 xPNTs 池)
/// 经 `transferFrom(treasury, recipient, amount)` 发放;金库需事先对本合约
/// approve(或 xPNTs 侧 addAutoApprovedSpender)。
/// 发行权只存在于 xPNTsFactory / communityOwner(设计稿 §4 不变量)。
contract TransferRewardAction {
    /// @notice 发放的奖励 token(社区 xPNTs)。
    IERC20 public immutable token;
    /// @notice 店铺金库。MS-1 起步 = 社区 owner 地址;MS-3 治理收敛时可升级为多签 Treasury。
    address public immutable treasury;
    /// @notice 部署者,唯一可指定授权调用方。
    address public immutable owner;

    /// @notice 唯一授权调用方(MyShopItems)。原 MintERC20Action 无调用方约束,
    /// 但本合约持有金库授权额度,开放 execute 等于允许任何人耗尽额度,故收紧为仅 items 可调。
    address public items;

    event ItemsUpdated(address indexed items);
    event RewardPaid(address indexed recipient, uint256 amount);

    error InvalidAddress();
    error NotOwner();
    error NotItems();
    error TransferFailed();

    constructor(address token_, address treasury_) {
        if (token_ == address(0) || treasury_ == address(0)) revert InvalidAddress();
        token = IERC20(token_);
        treasury = treasury_;
        owner = msg.sender;
    }

    function setItems(address items_) external {
        if (msg.sender != owner) revert NotOwner();
        if (items_ == address(0)) revert InvalidAddress();
        items = items_;
        emit ItemsUpdated(items_);
    }

    /// @dev IMyShopItemAction 接口;actionData = abi.encode(uint256 amountPerUnit)。
    function execute(
        address,
        address recipient,
        uint256,
        uint256,
        uint256 quantity,
        bytes calldata actionData,
        bytes calldata
    ) external payable {
        if (msg.sender != items) revert NotItems();
        uint256 amountPerUnit = abi.decode(actionData, (uint256));
        uint256 amount = amountPerUnit * quantity;
        bool ok = token.transferFrom(treasury, recipient, amount);
        if (!ok) revert TransferFailed();
        emit RewardPaid(recipient, amount);
    }
}
