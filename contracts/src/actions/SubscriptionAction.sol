// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

interface IERC721Mintable {
    function mint(address to, string calldata uri) external returns (uint256);
}

/// @notice Mints a subscription NFT with an expiry timestamp encoded in tokenURI.
///         actionData = abi.encode(address nftContract, uint256 durationSeconds)
///         Duration: e.g. 30 days = 2592000
///
///         Security: only the whitelisted MyShopItems contract may call execute().
///         The caller restriction is enforced by requiring msg.sender == itemsContract.
contract SubscriptionAction {
    /// @notice The MyShopItems contract that is allowed to call execute().
    address public immutable itemsContract;

    error Unauthorized();
    error InvalidActionData();

    event SubscriptionGranted(
        address indexed subscriber,
        address indexed nftContract,
        uint256 indexed tokenId,
        uint256 expiresAt
    );

    constructor(address itemsContract_) {
        require(itemsContract_ != address(0), "SubscriptionAction: zero address");
        itemsContract = itemsContract_;
    }

    /// @notice Called by MyShopItems.buy() after a successful purchase.
    ///         Restricted to itemsContract only — cannot be called directly.
    function execute(
        address /*buyer*/,
        address recipient,
        uint256 /*itemId*/,
        uint256 /*shopId*/,
        uint256 quantity,
        bytes calldata actionData,
        bytes calldata /*extraData*/
    ) external payable {
        if (msg.sender != itemsContract) revert Unauthorized();
        // Guard: actionData must encode at least (address, uint256) = 64 bytes
        if (actionData.length < 64) revert InvalidActionData();
        (address nftContract, uint256 durationSeconds) = abi.decode(actionData, (address, uint256));
        if (nftContract == address(0)) revert InvalidActionData();
        uint256 expiresAt = block.timestamp + durationSeconds;
        if (quantity == 0) quantity = 1;
        for (uint256 i = 0; i < quantity; i++) {
            // tokenURI encodes expiry as a data URI for on-chain verification
            string memory tokenURI = string(abi.encodePacked(
                "data:application/json;utf8,{\"expiresAt\":",
                _toString(expiresAt), "}"
            ));
            uint256 tokenId = IERC721Mintable(nftContract).mint(recipient, tokenURI);
            emit SubscriptionGranted(recipient, nftContract, tokenId, expiresAt);
        }
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) { digits--; buffer[digits] = bytes1(uint8(48 + uint256(value % 10))); value /= 10; }
        return string(buffer);
    }
}
