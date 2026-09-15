/**
 * Measures the EXACT gas of every step of the confiscate rollout, by executing each one
 * against a local chain with the real contracts. Deployment gas is bytecode-determined and
 * therefore identical on any EVM chain; only the gas PRICE differs per chain.
 *
 *   npx hardhat run scripts/measure-mainnet-gas.ts --network hardhat
 */
import hre from "hardhat";

const g = (r: any) => Number(r.gasUsed ?? r.deploymentTransaction?.gasUsed ?? 0);

async function main() {
  const { ethers, upgrades } = hre;
  const [admin, depository, confiscation, officer, manager, director, commissioner, victim] =
    await ethers.getSigners();
  const out: Array<[string, number, string]> = [];

  // ── implementation deploys (what actually gets paid for on mainnet) ──────────
  const IDRP = await ethers.getContractFactory("IDRP");
  const tokenImpl = await IDRP.deploy();
  await tokenImpl.waitForDeployment();
  out.push(["deploy IDRP implementation", g(await tokenImpl.deploymentTransaction()!.wait()), "one per chain"]);

  const CTRL = await ethers.getContractFactory("IDRPController");
  const ctrlImpl = await CTRL.deploy();
  await ctrlImpl.waitForDeployment();
  out.push(["deploy IDRPController implementation", g(await ctrlImpl.deploymentTransaction()!.wait()), "one per chain"]);

  // ── a live proxy pair to measure the operations against ─────────────────────
  const idrp: any = await upgrades.deployProxy(IDRP, [admin.address]);
  await idrp.waitForDeployment();
  const controller: any = await upgrades.deployProxy(CTRL, [await idrp.getAddress(), admin.address]);
  await controller.waitForDeployment();

  out.push(["token: setDepositoryWallet", g(await (await idrp.connect(admin).setDepositoryWallet(depository.address)).wait()), "if changing"]);
  out.push(["token: setConfiscationWallet  <-- NEW", g(await (await idrp.connect(admin).setConfiscationWallet(confiscation.address)).wait()), "REQUIRED, once per chain"]);
  out.push(["token: setController", g(await (await idrp.connect(admin).setController(await controller.getAddress())).wait()), "only if re-wiring"]);

  const R = (n: string) => ethers.id(n);
  out.push(["controller: grantRole (x1)", g(await (await controller.connect(admin).grantRole(R("OFFICER_ROLE"), officer.address)).wait()), "per role holder"]);
  await (await controller.connect(admin).grantRole(R("MANAGER_ROLE"), manager.address)).wait();
  await (await controller.connect(admin).grantRole(R("DIRECTOR_ROLE"), director.address)).wait();
  await (await controller.connect(admin).grantRole(R("COMMISSIONER_ROLE"), commissioner.address)).wait();

  const MAX = (1n << 256n) - 1n;
  const confiscateRule = [[0n, MAX, [R("OFFICER_ROLE"), R("MANAGER_ROLE"), R("DIRECTOR_ROLE"), R("COMMISSIONER_ROLE")]]];
  out.push(["controller: setQuorumRules(Confiscate)  <-- NEW", g(await (await controller.connect(admin).setQuorumRules(6, confiscateRule)).wait()), "REQUIRED, instant (op is new)"]);

  // ── the upgrade itself, through the real timelock ────────────────────────────
  const newImpl = await upgrades.prepareUpgrade(await idrp.getAddress(), IDRP, { kind: "uups" });
  out.push(["token: scheduleUpgrade", g(await (await idrp.connect(admin).scheduleUpgrade(newImpl as string)).wait()), "starts the 48h clock"]);
  await hre.network.provider.send("evm_increaseTime", [48 * 3600 + 1]);
  await hre.network.provider.send("evm_mine");
  const initV4 = IDRP.interface.encodeFunctionData("initializeV4");
  out.push(["token: upgradeToAndCall(impl, initializeV4())", g(await (await idrp.connect(admin).upgradeToAndCall(newImpl as string, initV4)).wait()), "the upgrade tx"]);

  const ctrlNew = await upgrades.prepareUpgrade(await controller.getAddress(), CTRL, { kind: "uups" });
  await (await controller.connect(admin).scheduleUpgrade(ctrlNew as string)).wait();
  await hre.network.provider.send("evm_increaseTime", [48 * 3600 + 1]);
  await hre.network.provider.send("evm_mine");
  out.push(["controller: upgradeToAndCall(impl, 0x)", g(await (await controller.connect(admin).upgradeToAndCall(ctrlNew as string, "0x")).wait()), "the upgrade tx"]);

  // ── a seizure, for completeness ──────────────────────────────────────────────
  // initializeV4 cleared the destination during the upgrade above — that is the
  // designed protection against inheriting the retired design's wallet. So the
  // destination has to be set AFTER the upgrade, and that ordering is a runbook step,
  // not an accident. Measured separately because it is paid twice on a chain that
  // upgrades and then configures.
  out.push(["token: setConfiscationWallet AGAIN, post-upgrade  <-- REQUIRED",
    g(await (await idrp.connect(admin).setConfiscationWallet(confiscation.address)).wait()),
    "initializeV4 clears it during the upgrade"]);
  await (await idrp.connect(admin).setController(admin.address)).wait();
  await (await idrp.connect(admin).mint(ethers.parseUnits("1000", 6))).wait();
  await (await idrp.connect(depository).transfer(victim.address, ethers.parseUnits("100", 6))).wait();
  await (await idrp.connect(admin).freeze(victim.address)).wait();
  out.push(["token: confiscate (direct, excl. quorum verify)", g(await (await idrp.connect(admin).confiscate(victim.address, ethers.parseUnits("100", 6))).wait()), "per seizure"]);

  console.log(`\nEVM GAS — measured by execution (bytecode-determined; identical on every EVM chain)\n`);
  console.log(`  ${"step".padEnd(50)}${"gas".padStart(10)}   note`);
  console.log(`  ${"-".repeat(50)}${"-".repeat(10)}   ${"-".repeat(30)}`);
  for (const [label, gas, note] of out) console.log(`  ${label.padEnd(50)}${gas.toLocaleString().padStart(10)}   ${note}`);
  const perChain = out.filter(([l]) => /deploy |setConfiscationWallet|setQuorumRules|scheduleUpgrade|upgradeToAndCall/.test(l))
    .reduce((a, [, x]) => a + x, 0);
  console.log(`\n  one-chain rollout total (2 deploys + 2 schedules + 2 upgrades + destination + rules): ${perChain.toLocaleString()} gas`);
  require("fs").writeFileSync("/tmp/evm-gas.json", JSON.stringify(out, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
