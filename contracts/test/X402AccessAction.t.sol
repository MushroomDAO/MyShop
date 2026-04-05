// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {X402AccessAction} from "../src/actions/X402AccessAction.sol";

/// @dev Minimal ERC-721 mint stub used by the tests.
contract MockAccessNFT {
    uint256 public nextTokenId;
    mapping(uint256 => address) public ownerOf;

    function mint(address to, string calldata /*uri*/) external returns (uint256 tokenId) {
        tokenId = ++nextTokenId;
        ownerOf[tokenId] = to;
    }
}

/// @dev Another stub whose mint always reverts — used to test bad-contract handling.
contract RevertingNFT {
    function mint(address, string calldata) external pure returns (uint256) {
        revert("always fails");
    }
}

contract X402AccessActionTest is Test {
    X402AccessAction internal action;
    MockAccessNFT internal nft;

    address internal recipient = address(0xBEEF);
    string  internal resourceUri = "https://api.example.com/resource/42";

    function setUp() external {
        action = new X402AccessAction();
        nft    = new MockAccessNFT();
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    function _data(address nft_, string memory uri) internal pure returns (bytes memory) {
        return abi.encode(nft_, uri);
    }

    function _exec(address recipient_, uint256 quantity, bytes memory data) internal {
        action.execute(address(0), recipient_, 0, 0, quantity, data, "");
    }

    // ── test_Execute_MintsAccessNFT ─────────────────────────────────────────────

    function test_Execute_MintsAccessNFT() external {
        _exec(recipient, 1, _data(address(nft), resourceUri));

        assertEq(nft.nextTokenId(), 1, "one token should be minted");
        assertEq(nft.ownerOf(1), recipient, "token must be owned by recipient");
    }

    // ── test_Execute_EmitsEvent ─────────────────────────────────────────────────

    function test_Execute_EmitsEvent() external {
        vm.expectEmit(true, true, true, true);
        emit X402AccessAction.X402AccessGranted(recipient, address(nft), 1, resourceUri);

        _exec(recipient, 1, _data(address(nft), resourceUri));
    }

    // ── test_Execute_BatchQuantity ──────────────────────────────────────────────

    function test_Execute_BatchQuantity() external {
        _exec(recipient, 3, _data(address(nft), resourceUri));

        assertEq(nft.nextTokenId(), 3, "three tokens should be minted");
        assertEq(nft.ownerOf(1), recipient);
        assertEq(nft.ownerOf(2), recipient);
        assertEq(nft.ownerOf(3), recipient);
    }

    // ── test_Execute_DecodesActionData ─────────────────────────────────────────

    /// @dev Passing a wrong encoding (e.g. only a uint256) should revert when
    ///      abi.decode tries to unpack (address, string).
    function test_Execute_DecodesActionData() external {
        bytes memory badData = abi.encode(uint256(12345));
        vm.expectRevert();
        _exec(recipient, 1, badData);
    }
}
