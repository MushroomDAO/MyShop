// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

interface IERC721Mintable {
    function mint(address to, string calldata uri) external returns (uint256);
}

/// @notice Action that mints an x402 access credential NFT to the buyer.
///         actionData = abi.encode(address accessNftContract, string resourceUri)
///         resourceUri identifies what resource/API this token gates access to.
contract X402AccessAction {
    event X402AccessGranted(
        address indexed recipient,
        address indexed accessNft,
        uint256 indexed tokenId,
        string resourceUri
    );

    /// @notice Called by MyShopItems during a purchase.
    /// @param recipient  Address that receives the access NFT.
    /// @param quantity   Number of access tokens to mint.
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
        (address accessNft, string memory resourceUri) = abi.decode(actionData, (address, string));
        if (quantity == 0) quantity = 1;
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = IERC721Mintable(accessNft).mint(recipient, "");
            emit X402AccessGranted(recipient, accessNft, tokenId, resourceUri);
        }
    }
}
