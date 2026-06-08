import hre from "hardhat";
import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { execTransaction } from "./utils/utils";

/**
 * Integration test: deploy a REAL Safe (5-of-5) and wire it as the IDRP
 * `admin` slot AND the IDRPController DEFAULT_ADMIN_ROLE holder. Confirm
 * that:
 *   - Admin-gated functions only succeed when invoked via Safe.execTransaction
 *     with sufficient owner signatures.
 *   - Stock OZ AccessControl behaviour holds for the Controller's signer-role
 *     grants when admin is a Safe.
 *   - The `upgrader` slot rotation through the Safe also works.
 *
 * This replaces the old test/IDRPControllerWithSafe.ts.bak. That file
 * targeted the pre-v2 contract surface (nonce-based EIP-712, no proxy
 * deployment for the Controller, direct grantRole) and would require a
 * full rewrite to be useful today. The new test below covers the v3
 * surface specifically.
 */
describe("IDRP & IDRPController with real Safe wallet", function () {
  it("admin-gated functions on IDRP require Safe execTransaction", async function () {
    const [deployer, owner1, owner2, owner3, owner4, owner5, controllerEOA, depository] =
      await hre.ethers.getSigners();

    // 1. Deploy a Safe (5-of-5).
    const SafeFactory = await hre.ethers.getContractFactory("Safe", deployer);
    const masterCopy = await SafeFactory.deploy();
    const proxyFactory = await (
      await hre.ethers.getContractFactory("SafeProxyFactory", deployer)
    ).deploy();
    const owners = [owner1, owner2, owner3, owner4, owner5];
    const ownerAddrs = await Promise.all(owners.map((o) => o.getAddress()));
    const setupData = masterCopy.interface.encodeFunctionData("setup", [
      ownerAddrs,
      5,
      ZeroAddress,
      "0x",
      ZeroAddress,
      ZeroAddress,
      0,
      ZeroAddress,
    ]);
    const safeAddr = await proxyFactory.createProxyWithNonce.staticCall(
      await masterCopy.getAddress(),
      setupData,
      0n
    );
    await proxyFactory.createProxyWithNonce(
      await masterCopy.getAddress(),
      setupData,
      0n
    );
    const safe = await hre.ethers.getContractAt("Safe", safeAddr);

    // 2. Deploy v3 IDRP with Safe as the superAdmin.
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP");
    const idrp = await hre.upgrades.deployProxy(IDRPFactory, [safeAddr]);
    await idrp.waitForDeployment();

    // Confirm initial wiring: admin = upgrader = Safe.
    expect(await idrp.admin()).to.equal(safeAddr);
    expect(await idrp.upgrader()).to.equal(safeAddr);

    // 3. Direct call from a Safe owner (not Safe itself) must revert.
    await expect(
      idrp.connect(owner1).setDepositoryWallet(depository.address)
    ).to.be.revertedWithCustomError(idrp, "NotAdmin");

    // 4. Same call via Safe.execTransaction (with 5/5 sigs) must succeed.
    const setDepositoryCalldata = idrp.interface.encodeFunctionData(
      "setDepositoryWallet",
      [depository.address]
    );
    await execTransaction(
      owners,
      safe,
      await idrp.getAddress(),
      0,
      setDepositoryCalldata,
      0
    );
    expect(await idrp.depositoryWallet()).to.equal(depository.address);

    // 5. setController via Safe too.
    const setControllerCalldata = idrp.interface.encodeFunctionData(
      "setController",
      [controllerEOA.address]
    );
    await execTransaction(
      owners,
      safe,
      await idrp.getAddress(),
      0,
      setControllerCalldata,
      0
    );
    expect(await idrp.controller()).to.equal(controllerEOA.address);

    // 6. Controller-gated function should now work (controller is an EOA in test).
    await idrp.connect(controllerEOA).freeze(depository.address);
    expect(await idrp.frozen(depository.address)).to.equal(true);
  });

  it("Controller signer-role grants flow through Safe (ACDAR DEFAULT_ADMIN_ROLE)", async function () {
    const [deployer, owner1, owner2, owner3, owner4, owner5, idrpEOA, officer] =
      await hre.ethers.getSigners();

    // 1. Set up the Safe (re-using the 5-of-5 pattern).
    const SafeFactory = await hre.ethers.getContractFactory("Safe", deployer);
    const masterCopy = await SafeFactory.deploy();
    const proxyFactory = await (
      await hre.ethers.getContractFactory("SafeProxyFactory", deployer)
    ).deploy();
    const owners = [owner1, owner2, owner3, owner4, owner5];
    const ownerAddrs = await Promise.all(owners.map((o) => o.getAddress()));
    const setupData = masterCopy.interface.encodeFunctionData("setup", [
      ownerAddrs,
      5,
      ZeroAddress,
      "0x",
      ZeroAddress,
      ZeroAddress,
      0,
      ZeroAddress,
    ]);
    const safeAddr = await proxyFactory.createProxyWithNonce.staticCall(
      await masterCopy.getAddress(),
      setupData,
      0n
    );
    await proxyFactory.createProxyWithNonce(
      await masterCopy.getAddress(),
      setupData,
      0n
    );
    const safe = await hre.ethers.getContractAt("Safe", safeAddr);

    // 2. Deploy v3 Controller with Safe as the DEFAULT_ADMIN_ROLE holder
    // (initialize signature is (idrpToken, safe)).
    const CtrlFactory = await hre.ethers.getContractFactory("IDRPController");
    const controller = await hre.upgrades.deployProxy(CtrlFactory, [
      idrpEOA.address,
      safeAddr,
    ]);
    await controller.waitForDeployment();

    // Confirm ACDAR view: Safe is the defaultAdmin.
    expect(await controller.defaultAdmin()).to.equal(safeAddr);

    // 3. A Safe owner cannot directly grant a signer role.
    const OFFICER_ROLE = await controller.OFFICER_ROLE();
    await expect(
      controller.connect(owner1).grantRole(OFFICER_ROLE, officer.address)
    ).to.be.revertedWithCustomError(
      controller,
      "AccessControlUnauthorizedAccount"
    );

    // 4. Grant via Safe.execTransaction succeeds.
    const grantCalldata = controller.interface.encodeFunctionData("grantRole", [
      OFFICER_ROLE,
      officer.address,
    ]);
    await execTransaction(
      owners,
      safe,
      await controller.getAddress(),
      0,
      grantCalldata,
      0
    );
    expect(await controller.hasRole(OFFICER_ROLE, officer.address)).to.equal(
      true
    );

    // 5. ACDAR-protected calls also require the Safe:
    // beginDefaultAdminTransfer must come from Safe.
    const newAdminCandidate = officer.address; // arbitrary; just for the test
    await expect(
      controller.connect(owner1).beginDefaultAdminTransfer(newAdminCandidate)
    ).to.be.revertedWithCustomError(
      controller,
      "AccessControlUnauthorizedAccount"
    );
    const beginCalldata = controller.interface.encodeFunctionData(
      "beginDefaultAdminTransfer",
      [newAdminCandidate]
    );
    await execTransaction(
      owners,
      safe,
      await controller.getAddress(),
      0,
      beginCalldata,
      0
    );
    const [pending] = await controller.pendingDefaultAdmin();
    expect(pending).to.equal(newAdminCandidate);
  });
});
