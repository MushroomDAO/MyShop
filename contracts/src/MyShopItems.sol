// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.33;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {MyShops} from "./MyShops.sol";
import {IEligibilityValidator} from "./interfaces/IEligibilityValidator.sol";

interface ICommunityNFTMint {
    function mint(address to, string calldata uri, bool soulbound) external returns (uint256);
}

interface IMyShopItemAction {
    function execute(
        address buyer,
        address recipient,
        uint256 itemId,
        uint256 shopId,
        uint256 quantity,
        bytes calldata actionData,
        bytes calldata extraData
    ) external payable;
}

contract MyShopItems {
    MyShops public immutable shops;
    address public owner;

    address public riskSigner;
    address public serialSigner;

    uint256 public constant DEFAULT_MAX_ITEMS_PER_SHOP = 5;
    uint8 internal constant ROLE_ITEM_MAINTAINER = 2;
    uint8 internal constant ROLE_ITEM_EDITOR = 4;
    uint8 internal constant ROLE_ITEM_ACTION_EDITOR = 8;

    mapping(address => mapping(uint256 => bool)) public usedNonces;
    mapping(address => bool) public allowedActions;
    // C10: protocol-level whitelist of approved eligibility validator contracts
    mapping(address => bool) public allowedValidators;
    // C10: per-item eligibility validator config data (separate mapping to avoid stack-too-deep)
    mapping(uint256 => bytes) public itemEligibilityData;

    uint256 public itemCount;

    // C1: sold count and per-wallet purchase count
    mapping(uint256 => uint256) public itemSoldCount;
    mapping(uint256 => mapping(address => uint256)) public walletPurchaseCount;

    // C11: dispute window — records purchase timestamp per purchaseId for DisputeModule (M4)
    // purchaseId = keccak256(abi.encode(itemId, firstTokenId))
    uint256 public disputeWindowSeconds = 7 days;
    mapping(bytes32 => uint256) public purchaseTimestamps;

    // Reentrancy guard for buy() — prevents re-entrancy via ERC721 onReceived or action callbacks
    uint256 private _buyLock = 1;

    struct Item {
        uint256 shopId;
        address payToken;
        uint256 unitPrice;
        address nftContract;
        bool soulbound;
        string tokenURI;
        address action;
        bytes actionData;
        bool requiresSerial;
        bool active;
        // C1: inventory constraints
        uint256 maxSupply;
        uint32 perWallet;
        // C2: time window
        uint64 startTime;
        uint64 endTime;
        // C3: item-level pause
        bool paused;
        // C10: eligibility validator (0 = no restriction, anyone can buy)
        address eligibilityValidator;
    }

    struct ItemPage {
        bytes32 contentHash;
        string uri;
    }

    struct UpdateItemParams {
        address payToken;
        uint256 unitPrice;
        address nftContract;
        bool soulbound;
        string tokenURI;
        bool requiresSerial;
        // C1/C2 fields (0 = unchanged / no restriction)
        uint256 maxSupply;
        uint32 perWallet;
        uint64 startTime;
        uint64 endTime;
        // C10: eligibility validator (address(0) = no restriction)
        address eligibilityValidator;
        bytes eligibilityValidatorData; // stored in itemEligibilityData[itemId]
    }

    struct PurchaseContext {
        address buyer;
        address recipient;
        uint256 itemId;
        uint256 shopId;
        uint256 quantity;
    }

    struct PurchaseRecord {
        uint256 itemId;
        uint256 shopId;
        address buyer;
        address recipient;
        uint256 quantity;
        address payToken;
        uint256 payAmount;
        uint256 platformFeeAmount;
        bytes32 serialHash;
        uint256 firstTokenId;
    }

    struct AddItemParams {
        uint256 shopId;
        address payToken;
        uint256 unitPrice;
        address nftContract;
        bool soulbound;
        string tokenURI;
        address action;
        bytes actionData;
        bool requiresSerial;
        uint256 maxItems;
        uint256 deadline;
        uint256 nonce;
        bytes signature;
        // C1: inventory constraints
        uint256 maxSupply;
        uint32 perWallet;
        // C2: time window
        uint64 startTime;
        uint64 endTime;
        // C10: eligibility validator (address(0) = no restriction)
        address eligibilityValidator;
        bytes eligibilityValidatorData; // stored in itemEligibilityData[itemId]
    }

    mapping(uint256 => Item) internal _items;
    mapping(uint256 => uint256) public shopItemCount;
    mapping(uint256 => uint256) public itemPageCount;
    mapping(uint256 => uint256) public itemDefaultPageVersion;
    mapping(uint256 => mapping(uint256 => ItemPage)) internal itemPages;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RiskSignerUpdated(address indexed signer);
    event SerialSignerUpdated(address indexed signer);
    event ActionAllowed(address indexed action, bool allowed);
    event ValidatorAllowed(address indexed validator, bool allowed);
    event DisputeWindowUpdated(uint256 oldSeconds, uint256 newSeconds);
    event ItemAdded(uint256 indexed itemId, uint256 indexed shopId, address indexed shopOwner);
    event ItemStatusChanged(uint256 indexed itemId, bool active);
    event ItemUpdated(uint256 indexed itemId);
    event ItemActionUpdated(uint256 indexed itemId, address indexed action);
    event ItemPageVersionAdded(uint256 indexed itemId, uint256 indexed version, bytes32 contentHash, string uri);
    event ItemDefaultPageVersionSet(uint256 indexed itemId, uint256 indexed version);
    // C3: item pause event
    event ItemPaused(uint256 indexed itemId, bool paused);
    // C7/C8: withdrawal events
    event ShopBalanceWithdrawn(uint256 indexed shopId, address indexed token, address indexed to, uint256 amount);
    event ProtocolBalanceRescued(address indexed token, address indexed to, uint256 amount);
    event Purchased(
        uint256 indexed itemId,
        uint256 indexed shopId,
        address indexed buyer,
        address recipient,
        uint256 quantity,
        address payToken,
        uint256 payAmount,
        uint256 platformFeeAmount,
        bytes32 serialHash,
        uint256 firstTokenId
    );

    error NotOwner();
    error InvalidAddress();
    error NotShopOwner();
    error ShopPaused();
    error ItemNotFound();
    error ItemInactive();
    error InvalidPayment();
    error TransferFailed();
    error MaxItemsReached();
    error InvalidSignature();
    error SignatureExpired();
    error NonceUsed();
    error SerialRequired();
    error ActionNotAllowed();
    error ValidatorNotAllowed();
    error NotEligible();
    error InvalidVersion();
    error InvalidURI();
    // C1
    error ExceedsMaxSupply();
    error ExceedsPerWallet();
    // C2
    error NotYetAvailable();
    error SaleEnded();
    // C3
    error ItemPausedError();

    constructor(address shops_, address riskSigner_, address serialSigner_) {
        if (shops_ == address(0)) revert InvalidAddress();
        if (riskSigner_ == address(0)) revert InvalidAddress();
        if (serialSigner_ == address(0)) revert InvalidAddress();
        shops = MyShops(shops_);
        owner = msg.sender;
        riskSigner = riskSigner_;
        serialSigner = serialSigner_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit RiskSignerUpdated(riskSigner_);
        emit SerialSignerUpdated(serialSigner_);
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

    function setRiskSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidAddress();
        riskSigner = signer;
        emit RiskSignerUpdated(signer);
    }

    function setSerialSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidAddress();
        serialSigner = signer;
        emit SerialSignerUpdated(signer);
    }

    function setActionAllowed(address action, bool allowed) external onlyOwner {
        allowedActions[action] = allowed;
        emit ActionAllowed(action, allowed);
    }

    // C10: protocol owner manages the eligibility validator whitelist
    function setValidatorAllowed(address validator, bool allowed) external onlyOwner {
        allowedValidators[validator] = allowed;
        emit ValidatorAllowed(validator, allowed);
    }

    function setItemActive(uint256 itemId, bool active) external {
        Item storage item = _items[itemId];
        if (!item.active && item.shopId == 0) revert ItemNotFound();
        if (msg.sender != owner && !shops.hasShopRole(item.shopId, msg.sender, ROLE_ITEM_MAINTAINER)) {
            revert NotShopOwner();
        }
        item.active = active;
        emit ItemStatusChanged(itemId, active);
    }

    // C7: shop treasury withdrawal — recovers stuck ERC20 by sending to the shop's own treasury.
    // Restricted to protocol owner only: the contract holds pooled funds (all shops share one balance),
    // so a per-shop maintainer role would allow draining other shops' accumulated fees.
    function withdrawShopBalance(uint256 shopId, address token) external onlyOwner {
        if (token == address(0)) revert InvalidAddress();
        (, address shopTreasury,, ) = shops.shops(shopId);
        if (shopTreasury == address(0)) revert InvalidAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        bool ok = IERC20(token).transfer(shopTreasury, bal);
        if (!ok) revert TransferFailed();
        emit ShopBalanceWithdrawn(shopId, token, shopTreasury, bal);
    }

    // C8: protocol treasury withdrawal — owner rescues stuck ETH or ERC20 from contract
    function rescueETH(address to) external onlyOwner {
        if (to == address(0)) revert InvalidAddress();
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        _sendEth(to, bal);
        emit ProtocolBalanceRescued(address(0), to, bal);
    }

    function rescueERC20(address token, address to) external onlyOwner {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        bool ok = IERC20(token).transfer(to, bal);
        if (!ok) revert TransferFailed();
        emit ProtocolBalanceRescued(token, to, bal);
    }

    // C3: pause/unpause individual item
    function pauseItem(uint256 itemId, bool pause) external {
        Item storage item = _items[itemId];
        if (!item.active && item.shopId == 0) revert ItemNotFound();
        if (msg.sender != owner && !shops.hasShopRole(item.shopId, msg.sender, ROLE_ITEM_MAINTAINER)) {
            revert NotShopOwner();
        }
        item.paused = pause;
        emit ItemPaused(itemId, pause);
    }

    function addItem(AddItemParams calldata p) external returns (uint256 itemId) {
        (address shopOwner,,, bool shopPaused) = shops.shops(p.shopId);
        if (shopOwner == address(0)) revert InvalidAddress();
        if (shopPaused) revert ShopPaused();
        if (!shops.hasShopRole(p.shopId, msg.sender, ROLE_ITEM_EDITOR)) revert NotShopOwner();
        if (p.nftContract == address(0) || p.unitPrice == 0) revert InvalidAddress();
        if (p.action != address(0) && !allowedActions[p.action]) revert ActionNotAllowed();
        if (p.eligibilityValidator != address(0) && !allowedValidators[p.eligibilityValidator]) revert ValidatorNotAllowed();
        if (p.endTime > 0 && p.startTime > 0 && p.endTime <= p.startTime) revert SaleEnded();

        _enforceItemLimit(shopOwner, p.shopId, p.maxItems, p.deadline, p.nonce, p.signature);

        // CEI: write all state before external fee transfer to prevent reentrancy via fee token
        itemId = ++itemCount;
        shopItemCount[p.shopId] += 1;

        // Assign fields individually to avoid stack-too-deep with large struct
        Item storage newItem = _items[itemId];
        newItem.shopId = p.shopId;
        newItem.payToken = p.payToken;
        newItem.unitPrice = p.unitPrice;
        newItem.nftContract = p.nftContract;
        newItem.soulbound = p.soulbound;
        newItem.tokenURI = p.tokenURI;
        newItem.action = p.action;
        newItem.actionData = p.actionData;
        newItem.requiresSerial = p.requiresSerial;
        newItem.active = true;
        newItem.maxSupply = p.maxSupply;
        newItem.perWallet = p.perWallet;
        newItem.startTime = p.startTime;
        newItem.endTime = p.endTime;
        newItem.paused = false;
        newItem.eligibilityValidator = p.eligibilityValidator;
        if (p.eligibilityValidatorData.length > 0) {
            itemEligibilityData[itemId] = p.eligibilityValidatorData;
        }

        // INTERACTION: listing fee transfer (after state is written)
        address feeToken = shops.listingFeeToken();
        uint256 feeAmount = shops.listingFeeAmount();
        if (feeAmount > 0) {
            bool ok = IERC20(feeToken).transferFrom(msg.sender, shops.platformTreasury(), feeAmount);
            if (!ok) revert TransferFailed();
        }

        emit ItemAdded(itemId, p.shopId, msg.sender);
    }

    function updateItem(uint256 itemId, UpdateItemParams calldata p) external {
        Item storage item = _items[itemId];
        if (!item.active && item.shopId == 0) revert ItemNotFound();
        if (!shops.hasShopRole(item.shopId, msg.sender, ROLE_ITEM_EDITOR)) revert NotShopOwner();
        if (p.nftContract == address(0) || p.unitPrice == 0) revert InvalidAddress();
        if (p.endTime > 0 && p.startTime > 0 && p.endTime <= p.startTime) revert SaleEnded();
        // C9: cannot lower maxSupply below already-sold count
        if (p.maxSupply > 0 && p.maxSupply < itemSoldCount[itemId]) revert ExceedsMaxSupply();
        // C10: validator must be whitelisted
        if (p.eligibilityValidator != address(0) && !allowedValidators[p.eligibilityValidator]) revert ValidatorNotAllowed();

        item.payToken = p.payToken;
        item.unitPrice = p.unitPrice;
        item.nftContract = p.nftContract;
        item.soulbound = p.soulbound;
        item.tokenURI = p.tokenURI;
        item.requiresSerial = p.requiresSerial;
        item.maxSupply = p.maxSupply;
        item.perWallet = p.perWallet;
        item.startTime = p.startTime;
        item.endTime = p.endTime;
        item.eligibilityValidator = p.eligibilityValidator;
        itemEligibilityData[itemId] = p.eligibilityValidatorData;

        emit ItemUpdated(itemId);
    }

    function updateItemAction(uint256 itemId, address action, bytes calldata actionData) external {
        Item storage item = _items[itemId];
        if (!item.active && item.shopId == 0) revert ItemNotFound();
        if (!shops.hasShopRole(item.shopId, msg.sender, ROLE_ITEM_ACTION_EDITOR)) revert NotShopOwner();
        if (action != address(0) && !allowedActions[action]) revert ActionNotAllowed();

        item.action = action;
        item.actionData = actionData;
        emit ItemActionUpdated(itemId, action);
    }

    function addItemPageVersion(uint256 itemId, string calldata uri, bytes32 contentHash)
        external
        returns (uint256 version)
    {
        Item storage item = _items[itemId];
        if (!item.active && item.shopId == 0) revert ItemNotFound();
        if (!shops.hasShopRole(item.shopId, msg.sender, ROLE_ITEM_EDITOR)) revert NotShopOwner();
        if (bytes(uri).length == 0) revert InvalidURI();

        version = ++itemPageCount[itemId];
        itemPages[itemId][version] = ItemPage({contentHash: contentHash, uri: uri});
        itemDefaultPageVersion[itemId] = version;
        emit ItemPageVersionAdded(itemId, version, contentHash, uri);
        emit ItemDefaultPageVersionSet(itemId, version);
    }

    function setItemDefaultPageVersion(uint256 itemId, uint256 version) external {
        Item storage item = _items[itemId];
        if (!item.active && item.shopId == 0) revert ItemNotFound();
        if (!shops.hasShopRole(item.shopId, msg.sender, ROLE_ITEM_EDITOR)) revert NotShopOwner();
        if (version == 0 || version > itemPageCount[itemId]) revert InvalidVersion();

        itemDefaultPageVersion[itemId] = version;
        emit ItemDefaultPageVersionSet(itemId, version);
    }

    function getItem(uint256 itemId) external view returns (Item memory) {
        return _items[itemId];
    }

    // C11: dispute window config (owner can adjust; per-shop override comes in M4 DisputeModule)
    uint256 public constant MAX_DISPUTE_WINDOW = 90 days;
    function setDisputeWindowSeconds(uint256 seconds_) external onlyOwner {
        if (seconds_ > MAX_DISPUTE_WINDOW) revert InvalidPayment(); // window > 90 days not allowed
        emit DisputeWindowUpdated(disputeWindowSeconds, seconds_);
        disputeWindowSeconds = seconds_;
    }

    // C11: returns true if the purchase is still within the dispute window
    // purchaseId = keccak256(abi.encode(itemId, firstTokenId))
    function isInDisputeWindow(bytes32 purchaseId) external view returns (bool) {
        uint256 ts = purchaseTimestamps[purchaseId];
        if (ts == 0) return false;
        return block.timestamp <= ts + disputeWindowSeconds;
    }

    function getItemPage(uint256 itemId, uint256 version) external view returns (bytes32 contentHash, string memory uri) {
        if (version == 0 || version > itemPageCount[itemId]) revert InvalidVersion();
        ItemPage storage page = itemPages[itemId][version];
        return (page.contentHash, page.uri);
    }

    function buy(uint256 itemId, uint256 quantity, address recipient, bytes calldata extraData)
        external
        payable
        returns (uint256 firstTokenId)
    {
        return _buy(itemId, quantity, recipient, msg.sender, extraData);
    }

    /// @notice ERC-4337 compatible buy with explicit payer identity.
    ///         When called via EntryPoint/Paymaster, msg.sender = AA wallet.
    ///         `payer` is used for SerialPermit + RiskAllowance verification.
    ///         If payer == address(0), falls back to msg.sender.
    function buyGasless(
        uint256 itemId,
        uint256 quantity,
        address recipient,
        address payer,
        bytes calldata extraData
    ) external payable returns (uint256 firstTokenId) {
        address effectivePayer = payer == address(0) ? msg.sender : payer;
        // When an explicit payer is set (AA/relayer scenario), the NFT must go to the payer
        // themselves — not to an arbitrary recipient. This closes the nonce-grief vector:
        // an attacker who submits a victim's permit via buyGasless(payer=victim) is forced to
        // deliver the NFT to the victim, making the "attack" economically pointless
        // (attacker pays; victim receives the item they wanted).
        // Regular buy() still supports gifting (msg.sender pays, recipient differs).
        if (effectivePayer != msg.sender) {
            if (recipient != effectivePayer) revert InvalidAddress();
        }
        return _buy(itemId, quantity, recipient, effectivePayer, extraData);
    }

    function _buy(uint256 itemId, uint256 quantity, address recipient, address buyer, bytes calldata extraData)
        internal
        returns (uint256 firstTokenId)
    {
        require(_buyLock == 1, "reentrant");
        _buyLock = 2;
        if (quantity == 0) revert InvalidPayment();
        if (recipient == address(0)) revert InvalidAddress();

        Item storage item = _items[itemId];
        if (!item.active && item.shopId == 0) revert ItemNotFound();
        if (!item.active) revert ItemInactive();

        (, address shopTreasury,, bool shopPaused) = shops.shops(item.shopId);
        if (shopPaused) revert ShopPaused();

        // C3: item-level pause
        if (item.paused) revert ItemPausedError();

        // C2: time window checks (custom errors, not require strings)
        if (item.startTime > 0 && block.timestamp < item.startTime) revert NotYetAvailable();
        if (item.endTime > 0 && block.timestamp > item.endTime) revert SaleEnded();

        // C1: inventory and per-wallet checks
        if (item.maxSupply > 0) {
            if (itemSoldCount[itemId] + quantity > item.maxSupply) revert ExceedsMaxSupply();
        }
        if (item.perWallet > 0) {
            if (walletPurchaseCount[itemId][recipient] + quantity > item.perWallet) revert ExceedsPerWallet();
        }

        // C10: eligibility validator check (0 = anyone can buy)
        if (item.eligibilityValidator != address(0)) {
            bool eligible = IEligibilityValidator(item.eligibilityValidator).checkEligibility(
                buyer, recipient, itemId, item.shopId, quantity,
                itemEligibilityData[itemId], extraData
            );
            if (!eligible) revert NotEligible();
        }

        bytes32 serialHash = bytes32(0);
        if (item.requiresSerial) {
            serialHash = _verifySerial(itemId, buyer, extraData);
        }

        // CEI: update state before external calls to prevent reentrancy
        itemSoldCount[itemId] += quantity;
        walletPurchaseCount[itemId][recipient] += quantity;

        uint256 payAmount;
        uint256 platformFeeAmount;
        {
            payAmount = item.unitPrice * quantity;
            platformFeeAmount = (payAmount * shops.platformFeeBps()) / 10000;
            _collectPayment(item.payToken, payAmount, platformFeeAmount, shopTreasury);
        }

        firstTokenId = _mintNft(item.nftContract, recipient, item.tokenURI, item.soulbound, quantity);

        // C11: record purchase timestamp for dispute window (DisputeModule M4)
        // Include buyer+timestamp+firstTokenId to avoid collision when NFT contract reuses IDs
        bytes32 purchaseId = keccak256(abi.encode(itemId, firstTokenId, buyer, block.timestamp));
        purchaseTimestamps[purchaseId] = block.timestamp;

        {
            PurchaseContext memory ctx = PurchaseContext({
                buyer: buyer, recipient: recipient, itemId: itemId, shopId: item.shopId, quantity: quantity
            });
            _executeAction(item.action, ctx, item.actionData, extraData);
        }

        PurchaseRecord memory rec = PurchaseRecord({
            itemId: itemId,
            shopId: item.shopId,
            buyer: buyer,
            recipient: recipient,
            quantity: quantity,
            payToken: item.payToken,
            payAmount: payAmount,
            platformFeeAmount: platformFeeAmount,
            serialHash: serialHash,
            firstTokenId: firstTokenId
        });
        _emitPurchased(rec);
        _buyLock = 1;
    }

    function _emitPurchased(PurchaseRecord memory rec) internal {
        emit Purchased(
            rec.itemId,
            rec.shopId,
            rec.buyer,
            rec.recipient,
            rec.quantity,
            rec.payToken,
            rec.payAmount,
            rec.platformFeeAmount,
            rec.serialHash,
            rec.firstTokenId
        );
    }

    function _collectPayment(address payToken, uint256 payAmount, uint256 platformFeeAmount, address shopTreasury)
        internal
    {
        uint256 shopAmount = payAmount - platformFeeAmount;
        address platformTreasury = shops.platformTreasury();

        if (payToken == address(0)) {
            if (msg.value != payAmount) revert InvalidPayment();
            _sendEth(platformTreasury, platformFeeAmount);
            _sendEth(shopTreasury, shopAmount);
        } else {
            if (msg.value != 0) revert InvalidPayment();
            IERC20 token = IERC20(payToken);
            bool okPull = token.transferFrom(msg.sender, address(this), payAmount);
            if (!okPull) revert TransferFailed();
            bool okFee = token.transfer(platformTreasury, platformFeeAmount);
            if (!okFee) revert TransferFailed();
            bool okShop = token.transfer(shopTreasury, shopAmount);
            if (!okShop) revert TransferFailed();
        }
    }

    function _mintNft(address nftContract, address recipient, string storage uri, bool soulbound, uint256 quantity)
        internal
        returns (uint256 firstTokenId)
    {
        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = ICommunityNFTMint(nftContract).mint(recipient, uri, soulbound);
            if (i == 0) firstTokenId = tokenId;
        }
    }

    function _executeAction(
        address action,
        PurchaseContext memory ctx,
        bytes storage actionData,
        bytes calldata extraData
    ) internal {
        if (action == address(0)) return;
        IMyShopItemAction(action).execute{value: 0}(
            ctx.buyer, ctx.recipient, ctx.itemId, ctx.shopId, ctx.quantity, actionData, extraData
        );
    }

    function _enforceItemLimit(
        address shopOwner,
        uint256 shopId,
        uint256 maxItems,
        uint256 deadline,
        uint256 nonce,
        bytes calldata signature
    ) internal {
        uint256 limit = DEFAULT_MAX_ITEMS_PER_SHOP;

        if (maxItems > 0) {
            _useNonce(shopOwner, nonce);
            if (block.timestamp > deadline) revert SignatureExpired();
            bytes32 digest = _hashTypedDataV4(_hashRiskAllowance(shopOwner, maxItems, deadline, nonce));
            if (_recover(digest, signature) != riskSigner) revert InvalidSignature();
            limit = maxItems;
        }

        if (shopItemCount[shopId] >= limit) revert MaxItemsReached();
    }

    function _verifySerial(uint256 itemId, address buyer, bytes calldata extraData)
        internal
        returns (bytes32 serialHash)
    {
        if (extraData.length == 0) revert SerialRequired();
        (bytes32 hash_, uint256 deadline, uint256 nonce, bytes memory sig) =
            abi.decode(extraData, (bytes32, uint256, uint256, bytes));
        serialHash = hash_;
        _useNonce(buyer, nonce);
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(_hashSerialPermit(itemId, buyer, serialHash, deadline, nonce));
        if (_recover(digest, sig) != serialSigner) revert InvalidSignature();
    }

    function _useNonce(address user, uint256 nonce) internal {
        if (usedNonces[user][nonce]) revert NonceUsed();
        usedNonces[user][nonce] = true;
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MyShop")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparatorV4(), structHash));
    }

    function _hashRiskAllowance(address shopOwner, uint256 maxItems, uint256 deadline, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("RiskAllowance(address shopOwner,uint256 maxItems,uint256 deadline,uint256 nonce)"),
                shopOwner,
                maxItems,
                deadline,
                nonce
            )
        );
    }

    function _hashSerialPermit(uint256 itemId, address buyer, bytes32 serialHash, uint256 deadline, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256(
                    "SerialPermit(uint256 itemId,address buyer,bytes32 serialHash,uint256 deadline,uint256 nonce)"
                ),
                itemId,
                buyer,
                serialHash,
                deadline,
                nonce
            )
        );
    }

    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
