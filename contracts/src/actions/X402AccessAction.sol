// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

interface IERC721Mintable {
    function mint(address to, string calldata uri) external returns (uint256);
}

/// @notice Action that mints an x402 access credential NFT to the buyer.
///         actionData = abi.encode(address accessNftContract, string resourceUri)
///         resourceUri identifies what resource/API this token gates access to.
///
/// @dev Security: execute() is restricted to a trusted caller (MyShopItems).
///      The trusted caller is set at deployment and cannot be changed.
///      This prevents anyone from calling execute() directly to mint access
///      NFTs without going through the purchase flow.
contract X402AccessAction {
    /// @notice The only address allowed to call execute() (MyShopItems).
    address public immutable trustedCaller;

    event X402AccessGranted(
        address indexed recipient,
        address indexed accessNft,
        uint256 indexed tokenId,
        string resourceUri
    );

    error Unauthorized();
    error InvalidNFTContract();
    error EmptyActionData();

    constructor(address trustedCaller_) {
        require(trustedCaller_ != address(0), "X402: zero caller");
        trustedCaller = trustedCaller_;
    }

    /// @notice Called by MyShopItems during a purchase.
    /// @dev    Restricted to trustedCaller (MyShopItems) only.
    ///         Direct calls from any other address are rejected to prevent
    ///         bypassing the purchase/payment flow.
    /// @param recipient  Address that receives the access NFT.
    /// @param quantity   Number of access tokens to mint (must be > 0 — enforced by MyShopItems).
    /// @param actionData abi.encode(address accessNftContract, string resourceUri)
    function execute(
        address /*buyer*/,
        address recipient,
        uint256 /*itemId*/,
        uint256 /*shopId*/,
        uint256 quantity,
        bytes calldata actionData,
        bytes calldata /*extraData*/
    ) external payable {
        if (msg.sender != trustedCaller) revert Unauthorized();
        if (actionData.length == 0) revert EmptyActionData();

        (address accessNft, string memory resourceUri) = abi.decode(actionData, (address, string));
        if (accessNft == address(0)) revert InvalidNFTContract();

        // quantity == 0 should never reach here (MyShopItems enforces quantity > 0),
        // but guard defensively to avoid a no-op loop.
        if (quantity == 0) quantity = 1;

        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = IERC721Mintable(accessNft).mint(recipient, resourceUri);
            emit X402AccessGranted(recipient, accessNft, tokenId, resourceUri);
        }
    }
}
