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
    /// @notice 唯一授权发放的店铺。MyShopItems.allowedActions 是全局 allowlist,
    /// 任何店铺的 ITEM_EDITOR 都能把本 action 挂到自己商品上;不绑 shopId 等于
    /// 允许其他店铺用任意 actionData 薅本金库。execute 校验 MyShopItems 从
    /// item.shopId 存储传入的 shopId 与本值一致。
    uint256 public immutable allowedShopId;

    /// @notice 唯一授权调用方(MyShopItems),由金库 one-shot 设置。
    /// 原 MintERC20Action 无调用方约束,但本合约持有金库授权额度,
    /// 开放 execute 等于允许任何人耗尽额度,故收紧为仅 items 可调。
    address public items;

    event ItemsUpdated(address indexed items);
    event RewardPaid(address indexed recipient, uint256 amount);

    error InvalidAddress();
    error InvalidShopId();
    error NotTreasury();
    error ItemsAlreadySet();
    error NotItems();
    error ShopNotAllowed();
    error TransferFailed();

    constructor(address token_, address treasury_, uint256 allowedShopId_) {
        if (token_ == address(0) || treasury_ == address(0)) revert InvalidAddress();
        if (allowedShopId_ == 0) revert InvalidShopId();
        token = IERC20(token_);
        treasury = treasury_;
        allowedShopId = allowedShopId_;
    }

    /// @notice one-shot:金库(资金所有方)绑定 MyShopItems 后不可再改,
    /// 防止事后把调用权重指向恶意上下文耗尽金库额度。
    function setItems(address items_) external {
        if (msg.sender != treasury) revert NotTreasury();
        if (items != address(0)) revert ItemsAlreadySet();
        if (items_ == address(0)) revert InvalidAddress();
        items = items_;
        emit ItemsUpdated(items_);
    }

    /// @dev IMyShopItemAction 接口;actionData = abi.encode(uint256 amountPerUnit)。
    function execute(
        address,
        address recipient,
        uint256,
        uint256 shopId,
        uint256 quantity,
        bytes calldata actionData,
        bytes calldata
    ) external payable {
        if (msg.sender != items) revert NotItems();
        if (shopId != allowedShopId) revert ShopNotAllowed();
        uint256 amountPerUnit = abi.decode(actionData, (uint256));
        uint256 amount = amountPerUnit * quantity;
        bool ok = token.transferFrom(treasury, recipient, amount);
        if (!ok) revert TransferFailed();
        emit RewardPaid(recipient, amount);
    }
}
