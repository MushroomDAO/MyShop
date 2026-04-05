// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

import {Test} from "forge-std/Test.sol";
import {SubscriptionAction} from "../src/actions/SubscriptionAction.sol";

contract MockSimpleNFT {
    uint256 public nextTokenId;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => string) public tokenURI;

    function mint(address to, string calldata uri) external returns (uint256 tokenId) {
        tokenId = ++nextTokenId;
        ownerOf[tokenId] = to;
        tokenURI[tokenId] = uri;
    }
}

contract SubscriptionActionTest is Test {
    SubscriptionAction internal action;
    MockSimpleNFT internal nft;

    address internal buyer = address(0xB0A7);
    address internal recipient = address(0xF00D);

    function setUp() external {
        action = new SubscriptionAction();
        nft = new MockSimpleNFT();
    }

    /// @notice Builds actionData for SubscriptionAction
    function _actionData(uint256 durationSeconds) internal view returns (bytes memory) {
        return abi.encode(address(nft), durationSeconds);
    }

    /// @notice test_Execute_GrantsSubscription: verify NFT minted, event emitted with correct expiresAt
    function test_Execute_GrantsSubscription() external {
        uint256 duration = 30 days;
        uint256 expectedExpiresAt = block.timestamp + duration;

        vm.expectEmit(true, true, true, true);
        emit SubscriptionAction.SubscriptionGranted(recipient, address(nft), 1, expectedExpiresAt);

        action.execute(buyer, recipient, 1, 1, 1, _actionData(duration), "");

        assertEq(nft.ownerOf(1), recipient);
        assertEq(nft.nextTokenId(), 1);

        // Verify tokenURI contains expiresAt
        string memory uri = nft.tokenURI(1);
        // tokenURI should be a data URI containing expiresAt
        bytes memory uriBytes = bytes(uri);
        assertTrue(uriBytes.length > 0, "tokenURI should not be empty");
    }

    /// @notice test_Execute_ExpiryIsBlockTimestampPlusDuration
    function test_Execute_ExpiryIsBlockTimestampPlusDuration() external {
        uint256 duration = 7 days;
        uint256 ts = 1_700_000_000;
        vm.warp(ts);

        uint256 expectedExpiresAt = ts + duration;

        vm.expectEmit(true, true, true, true);
        emit SubscriptionAction.SubscriptionGranted(recipient, address(nft), 1, expectedExpiresAt);

        action.execute(buyer, recipient, 1, 1, 1, _actionData(duration), "");

        // Verify the tokenURI encodes the correct expiresAt
        string memory uri = nft.tokenURI(1);
        // Build expected substring
        string memory expectedFragment = string(abi.encodePacked(
            "{\"expiresAt\":", _uintToString(expectedExpiresAt), "}"
        ));
        assertTrue(
            _contains(uri, expectedFragment),
            "tokenURI should contain correct expiresAt"
        );
    }

    /// @notice test_Execute_BatchQuantity: quantity=2 mints 2 tokens both with same expiresAt
    function test_Execute_BatchQuantity() external {
        uint256 duration = 30 days;
        uint256 expectedExpiresAt = block.timestamp + duration;

        vm.expectEmit(true, true, true, true);
        emit SubscriptionAction.SubscriptionGranted(recipient, address(nft), 1, expectedExpiresAt);
        vm.expectEmit(true, true, true, true);
        emit SubscriptionAction.SubscriptionGranted(recipient, address(nft), 2, expectedExpiresAt);

        action.execute(buyer, recipient, 1, 1, 2, _actionData(duration), "");

        assertEq(nft.nextTokenId(), 2);
        assertEq(nft.ownerOf(1), recipient);
        assertEq(nft.ownerOf(2), recipient);

        // Both tokens should have same expiry in tokenURI
        assertEq(nft.tokenURI(1), nft.tokenURI(2));
    }

    /// @notice test_Execute_ZeroDuration_StillMints: graceful handling of 0 duration
    function test_Execute_ZeroDuration_StillMints() external {
        uint256 duration = 0;
        uint256 expectedExpiresAt = block.timestamp; // 0 duration = expires immediately

        vm.expectEmit(true, true, true, true);
        emit SubscriptionAction.SubscriptionGranted(recipient, address(nft), 1, expectedExpiresAt);

        action.execute(buyer, recipient, 1, 1, 1, _actionData(duration), "");

        assertEq(nft.ownerOf(1), recipient);
        assertEq(nft.nextTokenId(), 1);
    }

    // --- helpers ---

    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) { found = false; break; }
            }
            if (found) return true;
        }
        return false;
    }
}
