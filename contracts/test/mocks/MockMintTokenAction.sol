pragma solidity ^0.8.20;

interface IERC20Mintable {
    function mint(address to, uint256 amount) external;
}

contract MockMintTokenAction {
    address public lastBuyer;
    address public lastRecipient;
    uint256 public lastItemId;
    uint256 public lastShopId;
    uint256 public lastQuantity;

    function execute(
        address buyer,
        address recipient,
        uint256 itemId,
        uint256 shopId,
        uint256 quantity,
        bytes calldata actionData,
        bytes calldata
    ) external payable {
        (address token, uint256 amountPerUnit) = abi.decode(actionData, (address, uint256));
        IERC20Mintable(token).mint(recipient, amountPerUnit * quantity);
        lastBuyer = buyer;
        lastRecipient = recipient;
        lastItemId = itemId;
        lastShopId = shopId;
        lastQuantity = quantity;
    }
}

