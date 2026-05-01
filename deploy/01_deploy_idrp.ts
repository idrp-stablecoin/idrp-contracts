import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { vars } from "hardhat/config";

const deployFunction: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
) {
  const { deployments } = hre;
  const { deploy, save, getArtifact } = deployments;
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  if (hre.network.name !== "shasta" && hre.network.name !== "nile" && hre.network.name !== "tron") {
    throw new Error("Script ini hanya untuk TRON networks");
  }

  // Use deployments.deploy() — handled by hardhat-tron, avoids eth_getTransactionCount
  const GAS_OPTIONS = { gasLimit: 10_000_000, gasPrice: "420" };

  // Derive admin address from private key — guaranteed to match
  const adminPk = vars.get("IDRP_ADMIN_PRIVATE_KEY_TRON");
  const adminWallet = new ethers.Wallet(adminPk.startsWith("0x") ? adminPk : `0x${adminPk}`);
  const adminAddress = adminWallet.address;

  if (adminAddress === ethers.ZeroAddress) {
    throw new Error("IDRP_ADMIN_PRIVATE_KEY_TRON derives to zero address");
  }

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  DEPLOY IDRP — ${hre.network.name.toUpperCase()}`);
  console.log(`${"═".repeat(55)}`);
  console.log(`  Deployer   : ${deployerAddress}`);
  console.log(`  superAdmin : ${adminAddress}`);
  console.log(`${"═".repeat(55)}\n`);

  // ─── TX 1: Deploy Implementation ──────────────────────────────────────────
  console.log(`[TX 1] Deploying IDRP implementation...`);
  const implResult = await deploy("IDRP_Implementation", {
    from: deployerAddress,
    contract: "IDRP",
    args: [],
    log: true,
    ...GAS_OPTIONS,
  });
  const implAddress = implResult.address;
  console.log(`       ✓ Implementation : ${implAddress}\n`);

  // ─── TX 2: Deploy Proxy with initialize(superAdmin) ───────────────────────
  console.log(`[TX 2] Encoding initialize(superAdmin) calldata...`);
  const idrpArtifact = await getArtifact("IDRP");
  const idrpIface = new ethers.Interface(idrpArtifact.abi);
  const initData = idrpIface.encodeFunctionData("initialize", [adminAddress]);
  console.log(`       initData : ${initData.slice(0, 66)}...`);

  console.log(`[TX 2] Deploying ERC1967Proxy(impl, initData)...`);
  const proxyResult = await deploy("IDRP", {
    from: deployerAddress,
    contract: "ERC1967Proxy",
    args: [implAddress, initData],
    log: true,
    ...GAS_OPTIONS,
  });
  const proxyAddress = proxyResult.address;
  console.log(`       ✓ Proxy : ${proxyAddress}\n`);

  // Override saved artifact to use IDRP ABI (not ERC1967Proxy ABI)
  await save("IDRP", {
    address:         proxyAddress,
    abi:             idrpArtifact.abi,
    implementation:  implAddress,
    transactionHash: proxyResult.transactionHash ?? "",
    args:            [implAddress, initData],
  });

  // ─── Verify state (read-only eth_call — no nonce needed) ──────────────────
  console.log(`[VERIFY] Checking post-deploy state...`);
  const idrp = await ethers.getContractAt("IDRP", proxyAddress);

  const DEFAULT_ADMIN = await idrp.DEFAULT_ADMIN_ROLE();
  const MINTER_ROLE   = await idrp.MINTER_ROLE();

  const adminHasDefaultAdmin = await idrp.hasRole(DEFAULT_ADMIN, adminAddress);
  const adminHasMinter       = await idrp.hasRole(MINTER_ROLE,   adminAddress);

  // Note: on Tron, deployer === admin (hardhat-tron exposes only one signer)
  console.log(`  adminAddress DEFAULT_ADMIN_ROLE : ${adminHasDefaultAdmin}  ← must be true`);
  console.log(`  adminAddress MINTER_ROLE        : ${adminHasMinter}        ← must be true`);

  if (!adminHasDefaultAdmin) {
    throw new Error(`❌ FATAL: adminAddress did not receive DEFAULT_ADMIN_ROLE!`);
  }

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  ✅ IDRP DEPLOYED SUCCESSFULLY`);
  console.log(`${"═".repeat(55)}`);
  console.log(`  Proxy (use this)  : ${proxyAddress}`);
  console.log(`  Implementation    : ${implAddress}`);
  console.log(`${"═".repeat(55)}`);
  console.log(`\n  Next: run 02_deploy_idrp_controller.ts\n`);
};

deployFunction.tags = ["IDRP"];
deployFunction.id   = "deploy_idrp";
export default deployFunction;
