pragma solidity ^0.8.20;

/// @notice Minimal ERC721 mock with balanceOf support for validator tests.
contract MockERC721 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}
