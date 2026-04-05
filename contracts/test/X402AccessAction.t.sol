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

    // ── test_x402_singleMint ───────────────────────────────────────────────────

    /// @dev quantity=1 mints exactly one token and emits one X402AccessGranted event.
    function test_x402_singleMint() external {
        vm.expectEmit(true, true, true, true);
        emit X402AccessAction.X402AccessGranted(recipient, address(nft), 1, resourceUri);

        _exec(recipient, 1, _data(address(nft), resourceUri));

        assertEq(nft.nextTokenId(), 1, "one token minted");
        assertEq(nft.ownerOf(1), recipient, "recipient owns token");
    }

    // ── test_x402_batchMint ────────────────────────────────────────────────────

    /// @dev quantity=3 mints 3 tokens and emits 3 X402AccessGranted events.
    function test_x402_batchMint() external {
        vm.expectEmit(true, true, true, true);
        emit X402AccessAction.X402AccessGranted(recipient, address(nft), 1, resourceUri);
        vm.expectEmit(true, true, true, true);
        emit X402AccessAction.X402AccessGranted(recipient, address(nft), 2, resourceUri);
        vm.expectEmit(true, true, true, true);
        emit X402AccessAction.X402AccessGranted(recipient, address(nft), 3, resourceUri);

        _exec(recipient, 3, _data(address(nft), resourceUri));

        assertEq(nft.nextTokenId(), 3, "three tokens minted");
        assertEq(nft.ownerOf(1), recipient);
        assertEq(nft.ownerOf(2), recipient);
        assertEq(nft.ownerOf(3), recipient);
    }

    // ── test_x402_quantityZeroDefaultsToOne ───────────────────────────────────

    /// @dev quantity=0 is treated as 1 — exactly one token minted.
    function test_x402_quantityZeroDefaultsToOne() external {
        _exec(recipient, 0, _data(address(nft), resourceUri));

        assertEq(nft.nextTokenId(), 1, "quantity 0 should default to 1 mint");
        assertEq(nft.ownerOf(1), recipient, "recipient owns the minted token");
    }

    // ── test_x402_resourceUriInEvent ──────────────────────────────────────────

    /// @dev The resourceUri passed in actionData is faithfully forwarded in the event.
    function test_x402_resourceUriInEvent() external {
        string memory specificUri = "https://api.example.com/premium/99";

        vm.expectEmit(true, true, true, true);
        emit X402AccessAction.X402AccessGranted(recipient, address(nft), 1, specificUri);

        _exec(recipient, 1, _data(address(nft), specificUri));
    }
}
