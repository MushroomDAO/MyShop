pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {MyShops} from "../src/MyShops.sol";
import {MyShopItems} from "../src/MyShopItems.sol";
import {MintERC20Action} from "../src/actions/MintERC20Action.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockERC20Mintable} from "../src/mocks/MockERC20Mintable.sol";
import {MockCommunityNFT} from "../src/mocks/MockCommunityNFT.sol";

contract DemoShopFlow is Script {
    bytes32 internal constant ROLE_COMMUNITY = keccak256("COMMUNITY");

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        uint256 buyerPk = vm.envUint("BUYER_PK");
        uint256 serialSignerPk = vm.envUint("SERIAL_SIGNER_PK");
        uint256 riskSignerPk = vm.envUint("RISK_SIGNER_PK");

        address deployer = vm.addr(deployerPk);
        address buyer = vm.addr(buyerPk);
        address serialSigner = vm.addr(serialSignerPk);
        address riskSigner = vm.addr(riskSignerPk);

        vm.startBroadcast(deployerPk);

        MockRegistry registry = new MockRegistry();
        MockERC20Mintable apnts = new MockERC20Mintable("aPNTs", "aPNTs", 18);
        MockERC20Mintable usdc = new MockERC20Mintable("USDC", "USDC", 6);
        MockCommunityNFT nft = new MockCommunityNFT();

        address platformTreasury = deployer;
        MyShops shops = new MyShops(address(registry), platformTreasury, address(apnts), 100 ether, 300);
        MyShopItems items = new MyShopItems(address(shops), riskSigner, serialSigner);
        MintERC20Action action = new MintERC20Action();

        items.setActionAllowed(address(action), true);

        registry.setHasRole(ROLE_COMMUNITY, deployer, true);

        uint256 shopId = shops.registerShop(deployer, bytes32(uint256(1)));

        apnts.mint(deployer, 1000 ether);
        apnts.approve(address(items), type(uint256).max);

        usdc.mint(buyer, 1_000_000_000);

        MyShopItems.AddItemParams memory p = MyShopItems.AddItemParams({
            shopId: shopId,
            payToken: address(usdc),
            unitPrice: 1000,
            nftContract: address(nft),
            soulbound: true,
            tokenURI: "ipfs://token",
            action: address(action),
            actionData: abi.encode(address(apnts), 50 ether),
            requiresSerial: true,
            maxItems: 0,
            deadline: 0,
            nonce: 0,
            signature: bytes(""),
            maxSupply: 0,
            perWallet: 0,
            startTime: 0,
            endTime: 0
        });

        uint256 itemId = items.addItem(p);

        vm.stopBroadcast();

        vm.startBroadcast(buyerPk);

        usdc.approve(address(items), type(uint256).max);

        bytes32 serialHash = keccak256(abi.encodePacked("SERIAL-001"));
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 1;
        bytes memory serialSig =
            _signSerialPermit(serialSignerPk, address(items), itemId, buyer, serialHash, deadline, nonce);
        bytes memory extraData = abi.encode(serialHash, deadline, nonce, serialSig);

        uint256 firstTokenId = items.buy(itemId, 1, buyer, extraData);

        vm.stopBroadcast();

        console2.logAddress(address(registry));
        console2.logAddress(address(shops));
        console2.logAddress(address(items));
        console2.logAddress(address(nft));
        console2.logUint(shopId);
        console2.logUint(itemId);
        console2.logUint(firstTokenId);
    }

    function _signSerialPermit(
        uint256 pk,
        address verifyingContract,
        uint256 itemId,
        address buyer,
        bytes32 serialHash,
        uint256 deadline,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
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
        bytes32 digest = _hashTypedDataV4(verifyingContract, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _hashTypedDataV4(address verifyingContract, bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MyShop")),
                keccak256(bytes("1")),
                block.chainid,
                verifyingContract
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}

