pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {MyShops} from "../src/MyShops.sol";
import {MyShopItems} from "../src/MyShopItems.sol";
import {MintERC20Action} from "../src/actions/MintERC20Action.sol";
import {MockRegistry} from "../src/mocks/MockRegistry.sol";
import {MockERC20Mintable} from "../src/mocks/MockERC20Mintable.sol";
import {MockCommunityNFT} from "../src/mocks/MockCommunityNFT.sol";

contract DeployDemo is Script {
    using stdJson for string;

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

        string memory obj = "demo";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "buyer", buyer);
        vm.serializeAddress(obj, "serialSigner", serialSigner);
        vm.serializeAddress(obj, "riskSigner", riskSigner);
        vm.serializeAddress(obj, "registry", address(registry));
        vm.serializeAddress(obj, "apnts", address(apnts));
        vm.serializeAddress(obj, "usdc", address(usdc));
        vm.serializeAddress(obj, "nft", address(nft));
        vm.serializeAddress(obj, "shops", address(shops));
        vm.serializeAddress(obj, "items", address(items));
        vm.serializeAddress(obj, "action", address(action));
        vm.serializeUint(obj, "shopId", shopId);
        string memory json = vm.serializeUint(obj, "itemId", itemId);

        console2.logString(json);
    }
}
