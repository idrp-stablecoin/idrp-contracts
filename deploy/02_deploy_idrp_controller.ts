import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { vars } from "hardhat/config";

const deployFunction: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
) {
  const { deployments } = hre;
  const { deploy, save, get, getArtifact } = deployments;
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  if (hre.network.name !== "shasta" && hre.network.name !== "nile" && hre.network.name !== "tron") {
    throw new Error("Script ini hanya untuk TRON networks");
  }

  // Use deployments.deploy() — handled by hardhat-tron, avoids eth_getTransactionCount
  const GAS_OPTIONS = { gasLimit: 10_000_000, gasPrice: "420" };

  // Ambil IDRP PROXY address dari artifacts step 01
  const idrpDeployment = await get("IDRP");
  const idrpProxyAddress = idrpDeployment.address;

  // Derive admin address from private key — guaranteed to match
  const adminPk = vars.get("IDRP_ADMIN_PRIVATE_KEY_TRON");
  const adminWallet = new ethers.Wallet(adminPk.startsWith("0x") ? adminPk : `0x${adminPk}`);
  const adminAddress = adminWallet.address;

  if (adminAddress === ethers.ZeroAddress) {
    throw new Error("IDRP_ADMIN_PRIVATE_KEY_TRON derives to zero address");
  }

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  DEPLOY IDRPController — ${hre.network.name.toUpperCase()}`);
  console.log(`${"═".repeat(55)}`);
  console.log(`  Deployer    : ${deployerAddress}`);
  console.log(`  IDRP Proxy  : ${idrpProxyAddress}`);
  console.log(`  safeAddress : ${adminAddress}`);
  console.log(`${"═".repeat(55)}\n`);

  // Validate IDRP proxy (read-only eth_call)
  const idrpCheck = await ethers.getContractAt("IDRP", idrpProxyAddress);
  try {
    const name = await idrpCheck.name();
    console.log(`  ✓ IDRP proxy verified — name(): "${name}"\n`);
  } catch {
    throw new Error(
      `❌ FATAL: ${idrpProxyAddress} is not a valid IDRP proxy!\n` +
      `   Make sure 01_deploy_idrp.ts ran first.`
    );
  }

  // ─── TX 1: Deploy Implementation ──────────────────────────────────────────
  console.log(`[TX 1] Deploying IDRPController implementation...`);
  const implResult = await deploy("IDRPController_Implementation", {
    from: deployerAddress,
    contract: "IDRPController",
    args: [],
    log: true,
    ...GAS_OPTIONS,
  });
  const implAddress = implResult.address;
  console.log(`       ✓ Implementation : ${implAddress}\n`);

  // ─── TX 2: Deploy Proxy with initialize(_idrpToken, _safeAddress) ──────────
  console.log(`[TX 2] Encoding initialize() calldata...`);
  const controllerArtifact = await getArtifact("IDRPController");
  const controllerIface = new ethers.Interface(controllerArtifact.abi);
  const initData = controllerIface.encodeFunctionData("initialize", [
    idrpProxyAddress,  // _idrpToken  → PROXY address ✓
    adminAddress,      // _safeAddress
  ]);
  console.log(`       idrpToken arg : ${idrpProxyAddress} (proxy ✓)`);

  console.log(`[TX 2] Deploying ERC1967Proxy(impl, initData)...`);
  const proxyResult = await deploy("IDRPController", {
    from: deployerAddress,
    contract: "ERC1967Proxy",
    args: [implAddress, initData],
    log: true,
    ...GAS_OPTIONS,
  });
  const proxyAddress = proxyResult.address;
  console.log(`       ✓ Proxy : ${proxyAddress}\n`);

  // Override saved artifact to use IDRPController ABI
  await save("IDRPController", {
    address:         proxyAddress,
    abi:             controllerArtifact.abi,
    implementation:  implAddress,
    transactionHash: proxyResult.transactionHash ?? "",
    args:            [implAddress, initData],
  });

  // ─── Verify state (read-only eth_call) ────────────────────────────────────
  console.log(`[VERIFY] Checking post-deploy state...`);
  const controller = await ethers.getContractAt("IDRPController", proxyAddress);

  const ADMIN_ROLE    = await controller.ADMIN_ROLE();
  const DEFAULT_ADMIN = await controller.DEFAULT_ADMIN_ROLE();

  const adminHasAdminRole   = await controller.hasRole(ADMIN_ROLE,    adminAddress);
  const adminHasDefaultRole = await controller.hasRole(DEFAULT_ADMIN, adminAddress);
  const idrpTokenOnChain    = await controller.idrpToken();

  // Note: on Tron, deployer === admin (hardhat-tron exposes only one signer)
  console.log(`  idrpToken correct          : ${idrpTokenOnChain.toLowerCase() === idrpProxyAddress.toLowerCase()}`);
  console.log(`  adminAddress ADMIN_ROLE    : ${adminHasAdminRole}   ← must be true`);
  console.log(`  adminAddress DEFAULT_ADMIN : ${adminHasDefaultRole} ← must be true`);

  if (!adminHasAdminRole) {
    throw new Error(`❌ FATAL: adminAddress did not receive ADMIN_ROLE on IDRPController!`);
  }
  if (idrpTokenOnChain.toLowerCase() !== idrpProxyAddress.toLowerCase()) {
    throw new Error(
      `❌ FATAL: idrpToken wrong!\n` +
      `   Expected: ${idrpProxyAddress}\n` +
      `   Got     : ${idrpTokenOnChain}`
    );
  }

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  ✅ IDRPController DEPLOYED SUCCESSFULLY`);
  console.log(`${"═".repeat(55)}`);
  console.log(`  Proxy (use this)  : ${proxyAddress}`);
  console.log(`  Implementation    : ${implAddress}`);
  console.log(`  idrpToken         : ${idrpTokenOnChain} ✓`);
  console.log(`${"═".repeat(55)}`);
  console.log(`\n  Next: run controller-setup-tron.ts\n`);
};

deployFunction.tags        = ["IDRPController"];
deployFunction.dependencies = ["IDRP"];
deployFunction.id          = "deploy_idrp_controller";
export default deployFunction;
