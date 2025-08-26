import { ethers } from "hardhat";
import { JsonRpcProvider, Wallet, Interface } from "ethers";

async function main() {
  const IMPLEMENTATION = "0x38490830b2b43F083Fa9bB1e70e13411f99b8116"; // impl
  const superAdmin    = "0x24416E80bdaFEe83dFffcc13A4fd0726A176823B"; // IDRP.initialize(address)

  // 1) Make a direct mainnet provider + signer (don’t use HardhatEthersProvider)
  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY!;
  const PK          = process.env.IDRP_DEPLOYER_PRIVATE_KEY!; // must start with 0x
  const provider    = new JsonRpcProvider(`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`);
  const signer      = new Wallet(PK, provider);

  // 2) Encode initializer
  const iface = new Interface(["function initialize(address superAdmin)"]);
  const initData = iface.encodeFunctionData("initialize", [superAdmin]);

  // 3) Get the proxy factory with this signer
  const Proxy = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    signer
  );

  // 4) Deploy (don’t pass custom overrides with `to`)
  const proxy = await Proxy.deploy(IMPLEMENTATION, initData);
  await proxy.waitForDeployment();

  console.log("IDRP proxy:", await proxy.getAddress());
}

main().catch((e) => { console.error(e); process.exit(1); });
