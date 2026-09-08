import fs from "fs";
import path from "path";
import hre from "hardhat";
import { expect } from "chai";

/**
 * End-to-end against the FRESHLY DEPLOYED testnet proxies, on a fork.
 *
 * Exercises the real thing — the deployed bytecode, the deployed quorum rules,
 * the deployed wiring — through the full Controller quorum path: freeze by
 * quorum, then seize by quorum, then check where the money went.
 *
 * WHY A FORK AND NOT THE LIVE CHAIN
 *
 * `executeOperation` verifies EIP-712 signatures, so a real run needs the four
 * role holders' private keys, which are not here. On a fork the deployed admin
 * can be impersonated to grant those roles to local signers, and then the
 * signatures are genuine. Nothing touches live state, and no test wiring is left
 * behind on a chain.
 *
 *   E2E_NETWORK=baseSepolia npx hardhat test test/confiscate/FreshDeployE2E.ts
 */

const ROLES = ["OFFICER_ROLE", "MANAGER_ROLE", "DIRECTOR_ROLE", "COMMISSIONER_ROLE"] as const;

enum Op { Mint, Burn, Freeze, Unfreeze, Pause, Unpause, Confiscate }

describe("Fresh testnet deployment — end to end through the quorum", function () {
  this.timeout(300_000);

  let enabled = false;
  let originalForkConfig: unknown;
  let tokenAddr: string;
  let ctrlAddr: string;
  let depository: string;
  let realChainId: number;

  before(async function () {
    // Resolve the RPC from hardhat's own network config so the URL does not have
    // to be repeated (and cannot drift from what the deploy scripts use).
    const netName = process.env.E2E_NETWORK;
    const net = netName ? (hre.config.networks as any)[netName] : undefined;
    const rpcUrl: string | undefined = process.env.E2E_FORK_RPC_URL ?? net?.url;
    const chainId = process.env.E2E_CHAIN ?? (net?.chainId ? String(net.chainId) : undefined);
    if (!rpcUrl || !chainId) {
      console.log("\n  [skipping] set E2E_NETWORK (e.g. baseSepolia) to run.");
      this.skip();
    }
    enabled = true;

    const d = JSON.parse(
      fs.readFileSync(path.join(__dirname, `../../deployment/chain-${chainId}.json`), "utf8")
    );
    tokenAddr = d.IDRP;
    ctrlAddr = d.IDRPController;

    originalForkConfig = (hre.network.config as { forking?: unknown }).forking;
    const probe = new hre.ethers.JsonRpcProvider(rpcUrl);
    const blockNumber = (await probe.getBlockNumber()) - 5;
    probe.destroy();
    realChainId = Number(chainId);
    console.log(`  forking chain ${chainId} at block ${blockNumber}`);
    console.log(`  token ${tokenAddr}  controller ${ctrlAddr}`);
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: rpcUrl, blockNumber } }],
    });
  });

  after(async function () {
    if (!enabled) return;
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: originalForkConfig ? [{ forking: originalForkConfig }] : [],
    });
  });

  it("freezes and then seizes a wallet, entirely through the quorum", async function () {
    const token = await hre.ethers.getContractAt("IDRP", tokenAddr);
    const controller = await hre.ethers.getContractAt("IDRPController", ctrlAddr);
    const signers = await hre.ethers.getSigners();
    const [, officer, manager, director, commissioner, victim] = signers;

    depository = await token.depositoryWallet();

    // The deployed admin grants the four roles to keys we actually hold, so the
    // signatures below are real rather than impersonated.
    const admin = await token.admin();
    await hre.network.provider.send("hardhat_setBalance", [admin, "0x" + (10n ** 20n).toString(16)]);
    const adminSigner = await hre.ethers.getImpersonatedSigner(admin);
    const quorum = [officer, manager, director, commissioner];
    for (let i = 0; i < ROLES.length; i++) {
      const hash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(ROLES[i]));
      await (await controller.connect(adminSigner).grantRole(hash, quorum[i].address)).wait();
      expect(
        await controller.hasRole(hash, quorum[i].address),
        `${ROLES[i]} grant did not land`
      ).to.equal(true);
    }

    // Fund the victim from the depository.
    await hre.network.provider.send("hardhat_setBalance", [depository, "0x" + (10n ** 20n).toString(16)]);
    const dep = await hre.ethers.getImpersonatedSigner(depository);
    const seized = hre.ethers.parseUnits("1000", 6);
    await (await token.connect(dep).transfer(victim.address, seized)).wait();
    expect(await token.balanceOf(victim.address)).to.equal(seized);

    const domain = {
      name: "IDRPController",
      version: "1",
      // NOT the fork's chain id. The controller froze DOMAIN_SEPARATOR at deploy
      // time with the real one; a fork reports 31337, and signing against that
      // yields signatures the contract recovers to the wrong addresses — which
      // surfaces as "Missing signature for role", not as a domain error.
      chainId: realChainId,
      verifyingContract: ctrlAddr,
    };
    const types = {
      Operation: [
        { name: "to", type: "address" },
        { name: "operationType", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "operationIdentifier", type: "string" },
        { name: "deadline", type: "uint256" },
      ],
    };

    async function execute(op: Op, to: string, amount: bigint, who: typeof signers, tag: string) {
      const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
      const msg = {
        to,
        operationType: op,
        amount,
        operationIdentifier: tag,
        deadline: now + 3600n,
      };
      const sigs = await Promise.all(who.map((s) => s.signTypedData(domain, types, msg)));
      return controller
        .connect(who[0])
        .executeOperation(msg.operationType, msg.to, msg.amount, msg.operationIdentifier, msg.deadline, sigs);
    }

    // ── Freeze by quorum. The tier is chosen from max(amount, balance), and at
    //    1000 IDRP that is the lowest tier: Officer alone.
    await (await execute(Op.Freeze, victim.address, 0n, [officer], "e2e-freeze-1")).wait();
    expect(await token.frozen(victim.address), "victim should be frozen").to.equal(true);

    // The gate is real.
    await hre.network.provider.send("hardhat_setBalance", [victim.address, "0x" + (10n ** 20n).toString(16)]);
    await expect(
      token.connect(victim).transfer(officer.address, 1n)
    ).to.be.revertedWithCustomError(token, "FrozenAccount");

    // ── Seize by quorum. All four roles, full balance, all-or-nothing.
    const depBefore = await token.balanceOf(depository);
    const supplyBefore = await token.totalSupply();

    await expect(execute(Op.Confiscate, victim.address, seized, quorum, "e2e-seize-1"))
      .to.emit(token, "AssetsConfiscated")
      .withArgs(victim.address, depository, seized);

    expect(await token.balanceOf(victim.address), "victim drained").to.equal(0n);
    expect(await token.balanceOf(depository), "funds landed in the depository").to.equal(depBefore + seized);
    expect(await token.totalSupply(), "a seizure is a transfer, never a burn").to.equal(supplyBefore);
    expect(await token.frozen(victim.address), "target stays frozen after a seizure").to.equal(true);

    // ── The gate re-sealed, and the retired slots are still clean.
    await expect(
      token.connect(officer).transfer(victim.address, 1n)
    ).to.be.revertedWithCustomError(token, "FrozenAccount");
    for (const slot of [9, 10, 11]) {
      expect(await hre.ethers.provider.getStorage(tokenAddr, slot)).to.equal(hre.ethers.ZeroHash);
    }
  });

  it("rejects a seizure that names less than the full balance", async function () {
    // The Controller's all-or-nothing guard, on the deployed bytecode.
    const token = await hre.ethers.getContractAt("IDRP", tokenAddr);
    const controller = await hre.ethers.getContractAt("IDRPController", ctrlAddr);
    const signers = await hre.ethers.getSigners();
    const [, officer, manager, director, commissioner, , victim2] = signers;
    const quorum = [officer, manager, director, commissioner];

    const dep = await hre.ethers.getImpersonatedSigner(depository);
    const funded = hre.ethers.parseUnits("500", 6);
    await (await token.connect(dep).transfer(victim2.address, funded)).wait();

    const domain = {
      name: "IDRPController",
      version: "1",
      chainId: realChainId,
      verifyingContract: ctrlAddr,
    };
    const types = {
      Operation: [
        { name: "to", type: "address" },
        { name: "operationType", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "operationIdentifier", type: "string" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);

    await (await controller.connect(officer).executeOperation(
      Op.Freeze, victim2.address, 0n, "e2e-freeze-2", now + 3600n,
      [await officer.signTypedData(domain, types, {
        to: victim2.address, operationType: Op.Freeze, amount: 0n,
        operationIdentifier: "e2e-freeze-2", deadline: now + 3600n })]
    )).wait();

    const msg = {
      to: victim2.address, operationType: Op.Confiscate, amount: funded / 2n,
      operationIdentifier: "e2e-partial", deadline: now + 3600n,
    };
    const sigs = await Promise.all(quorum.map((s) => s.signTypedData(domain, types, msg)));
    await expect(
      controller.connect(officer).executeOperation(
        msg.operationType, msg.to, msg.amount, msg.operationIdentifier, msg.deadline, sigs)
    ).to.be.revertedWith("amount below target balance");
  });
});
