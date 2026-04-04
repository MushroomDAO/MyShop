// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

interface IRegistryHasRole {
    function hasRole(bytes32 role, address account) external view returns (bool);
}

contract MyShops {
    bytes32 public constant ROLE_COMMUNITY = keccak256("COMMUNITY");

    uint8 public constant ROLE_SHOP_ADMIN = 1;
    uint8 public constant ROLE_ITEM_MAINTAINER = 2;
    uint8 public constant ROLE_ITEM_EDITOR = 4;
    uint8 public constant ROLE_ITEM_ACTION_EDITOR = 8;

    address public owner;
    address public registry;

    address public platformTreasury;
    address public listingFeeToken;
    uint256 public listingFeeAmount;
    uint16 public platformFeeBps;

    uint256 public shopCount;

    struct Shop {
        address owner;
        address treasury;
        bytes32 metadataHash;
        bool paused;
    }

    mapping(uint256 => Shop) public shops;
    mapping(uint256 => mapping(address => uint8)) public shopRoles;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RegistryUpdated(address indexed registry);
    event PlatformTreasuryUpdated(address indexed treasury);
    event ListingFeeUpdated(address indexed token, uint256 amount);
    event PlatformFeeUpdated(uint16 feeBps);
    event ShopRegistered(
        uint256 indexed shopId, address indexed shopOwner, address indexed treasury, bytes32 metadataHash
    );
    event ShopUpdated(uint256 indexed shopId, address indexed treasury, bytes32 metadataHash);
    event ShopPaused(uint256 indexed shopId, bool paused);
    event ShopRoleUpdated(uint256 indexed shopId, address indexed operator, uint8 roles);

    error NotOwner();
    error InvalidAddress();
    error InvalidFeeBps();
    error NotCommunity();
    error NotShopOwner();
    error ShopNotFound();
    error InvalidRole();

    constructor(
        address registry_,
        address platformTreasury_,
        address listingFeeToken_,
        uint256 listingFeeAmount_,
        uint16 platformFeeBps_
    ) {
        owner = msg.sender;
        registry = registry_;
        platformTreasury = platformTreasury_;
        listingFeeToken = listingFeeToken_;
        listingFeeAmount = listingFeeAmount_;
        platformFeeBps = platformFeeBps_;

        if (registry_ == address(0) || platformTreasury_ == address(0) || listingFeeToken_ == address(0)) {
            revert InvalidAddress();
        }
        if (platformFeeBps_ > 2000) revert InvalidFeeBps();
        emit OwnershipTransferred(address(0), msg.sender);
        emit RegistryUpdated(registry_);
        emit PlatformTreasuryUpdated(platformTreasury_);
        emit ListingFeeUpdated(listingFeeToken_, listingFeeAmount_);
        emit PlatformFeeUpdated(platformFeeBps_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setRegistry(address registry_) external onlyOwner {
        if (registry_ == address(0)) revert InvalidAddress();
        registry = registry_;
        emit RegistryUpdated(registry_);
    }

    function setPlatformTreasury(address treasury) external onlyOwner {
        if (treasury == address(0)) revert InvalidAddress();
        platformTreasury = treasury;
        emit PlatformTreasuryUpdated(treasury);
    }

    function setListingFee(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        listingFeeToken = token;
        listingFeeAmount = amount;
        emit ListingFeeUpdated(token, amount);
    }

    function setPlatformFee(uint16 feeBps) external onlyOwner {
        if (feeBps > 2000) revert InvalidFeeBps();
        platformFeeBps = feeBps;
        emit PlatformFeeUpdated(feeBps);
    }

    function registerShop(address treasury, bytes32 metadataHash) external returns (uint256 shopId) {
        if (!IRegistryHasRole(registry).hasRole(ROLE_COMMUNITY, msg.sender)) revert NotCommunity();
        if (treasury == address(0)) revert InvalidAddress();

        shopId = ++shopCount;
        shops[shopId] = Shop({owner: msg.sender, treasury: treasury, metadataHash: metadataHash, paused: false});

        emit ShopRegistered(shopId, msg.sender, treasury, metadataHash);
    }

    function updateShop(uint256 shopId, address treasury, bytes32 metadataHash) external {
        Shop storage shop = shops[shopId];
        if (shop.owner == address(0)) revert ShopNotFound();
        if (!_isShopOwnerOrRole(shopId, msg.sender, ROLE_SHOP_ADMIN)) revert NotShopOwner();
        if (treasury == address(0)) revert InvalidAddress();

        shop.treasury = treasury;
        shop.metadataHash = metadataHash;

        emit ShopUpdated(shopId, treasury, metadataHash);
    }

    function setShopPaused(uint256 shopId, bool paused) external {
        Shop storage shop = shops[shopId];
        if (shop.owner == address(0)) revert ShopNotFound();
        if (msg.sender != owner && !_isShopOwnerOrRole(shopId, msg.sender, ROLE_SHOP_ADMIN)) revert NotShopOwner();
        shop.paused = paused;
        emit ShopPaused(shopId, paused);
    }

    function setShopRoles(uint256 shopId, address operator, uint8 roles) external {
        Shop storage shop = shops[shopId];
        if (shop.owner == address(0)) revert ShopNotFound();
        if (shop.owner != msg.sender) revert NotShopOwner();
        if (operator == address(0)) revert InvalidAddress();
        if ((roles & (ROLE_SHOP_ADMIN | ROLE_ITEM_MAINTAINER | ROLE_ITEM_EDITOR | ROLE_ITEM_ACTION_EDITOR)) != roles) {
            revert InvalidRole();
        }
        shopRoles[shopId][operator] = roles;
        emit ShopRoleUpdated(shopId, operator, roles);
    }

    function hasShopRole(uint256 shopId, address operator, uint8 role) external view returns (bool) {
        return _isShopOwnerOrRole(shopId, operator, role);
    }

    function _isShopOwnerOrRole(uint256 shopId, address operator, uint8 role) internal view returns (bool) {
        Shop storage shop = shops[shopId];
        if (shop.owner == operator) return true;
        return (shopRoles[shopId][operator] & role) != 0;
    }
}
