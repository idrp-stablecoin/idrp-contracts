/**
 * Nile ONLY — disposable rig that proves the v3 upgrade base is not a one-way door.
 *
 * WHAT IT PROVES
 *   The Tron mainnet proxies read ZERO in both TronUUPS proxy-slot generations, exactly
 *   as the Nile Controller did before it was frozen. A rig on a *fresh* proxy alone would
 *   give false confidence, because a fresh proxy is not the state mainnet is in. So this
 *   rig deliberately starts from a proxy whose TronUUPS slots are empty and then upgrades
 *   REPEATEDLY. If any step reverts with a proxy-context error, the base is unsafe for
 *   mainnet.
 *
 * SEQUENCE
 *   1. deploy impl A (v3, gapless + immutable __self) and an ERC1967 proxy over it
 *   2. assert both TronUUPS slots are 0x0  -> the proxy is in the mainnet-like state
 *   3. schedule, wait, upgradeToAndCall(B)   -> upgrade #1
 *   4. schedule, wait, upgradeToAndCall(A)   -> upgrade #2
 *   5. schedule, wait, upgradeToAndCall(B)   -> upgrade #3
 *   Three consecutive upgrades with no deadlock is the pass condition.
 *
 * Nothing here touches TWTjirsqPT6DGC63RMSAHGtb2NdzauiJWy or any address the dashboard,
 * notes, or deployment JSON reference. Every contract it creates is throwaway.
 *
 * Set IMPL_A / IMPL_B / RIG_PROXY to reuse contracts from an earlier run and skip deploys.
 *
 *   npx hardhat run scripts/nile-upgrade-rig.ts --network nile              # plan only
 *   EXECUTE=1 npx hardhat run scripts/nile-upgrade-rig.ts --network nile    # run it
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "https://nile.trongrid.io";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function storageAt(addrHex: string, slot: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    try {
      const r: any = await fetch(`${HOST}/jsonrpc`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getStorageAt", params: [addrHex, slot, "latest"], id: 1 }),
      }).then(x => x.json());
      if (r && "result" in r) return r.result;
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("storageAt failed (rate-limited) — a missing result is NOT a pass");
}

async function main() {
  if (hre.network.name !== "nile") throw new Error(`Nile only (got ${hre.network.name})`);
  const EXECUTE = process.env.EXECUTE === "1";
  const { ethers } = hre;
  const { deployments } = hre as any;
  const { vars } = require("hardhat/config");

  const raw = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const pk = raw.startsWith("0x") ? raw.slice(2) : raw;
  const tw = new TronWeb({ fullHost: HOST, privateKey: pk });
  const me = tw.address.fromPrivateKey(pk);

  const selfSlot = ethers.keccak256(ethers.toUtf8Bytes("idrp.tron.uups.__self"));
  const proxySlot = ethers.keccak256(ethers.toUtf8Bytes("idrp.tron.uups.__proxy"));

  console.log(`network: nile\nsigner : ${me}\nmode   : ${EXECUTE ? "EXECUTE" : "PLAN ONLY"}\n`);
  if (!EXECUTE) {
    console.log("Would deploy 2 throwaway implementations + 1 throwaway proxy, then run");
    console.log("three consecutive upgrades, asserting no proxy-context deadlock.");
    console.log("Touches no referenced address. Re-run with EXECUTE=1.");
    return;
  }

  const [signer] = await hre.ethers.getSigners();
  const from = await signer.getAddress();
  const GAS = { gasLimit: 10_000_000, gasPrice: "420" };

  const deployImpl = async (tag: string) => {
    const r = await deployments.deploy(`RigController_${tag}`, {
      from, contract: "IDRPController", args: [], log: false, ...GAS,
    });
    console.log(`   impl ${tag}: ${r.address}`);
    return r.address as string;
  };

  console.log("STEP 1 — deploy implementations and a throwaway proxy");
  // Reuse already-deployed implementations when given, so a rerun costs no new deploys.
  // Two are enough: alternating A -> B -> A is still three consecutive upgrades.
  const implA = process.env.IMPL_A ?? (await deployImpl("A"));
  const implB = process.env.IMPL_B ?? (await deployImpl("B"));
  if (process.env.IMPL_A) console.log(`   impl A (reused): ${implA}`);
  if (process.env.IMPL_B) console.log(`   impl B (reused): ${implB}`);

  // token address is only stored, never called, so any address works for the rig
  const initData = new ethers.Interface(["function initialize(address,address)"])
    .encodeFunctionData("initialize", ["0x" + tw.address.toHex(me).slice(2), "0x" + tw.address.toHex(me).slice(2)]);
  const proxyDep = process.env.RIG_PROXY
    ? { address: process.env.RIG_PROXY }
    : await deployments.deploy("RigProxy", {
        from, contract: "ERC1967Proxy", args: [implA, initData], log: false, ...GAS,
      });
  const proxyHex = proxyDep.address as string;
  const proxyT = tw.address.fromHex("41" + proxyHex.slice(2));
  console.log(`   proxy   : ${proxyHex}  (${proxyT})`);

  console.log("\nSTEP 2 — confirm the rig starts in the MAINNET-LIKE state");
  const s1 = await storageAt(proxyHex, selfSlot);
  const s2 = await storageAt(proxyHex, proxySlot);
  const zero = (h: string) => /^0x0*$/.test(h);
  console.log(`   __self  slot : ${s1}  ${zero(s1) ? "✓ empty" : "✗ NOT empty"}`);
  console.log(`   __proxy slot : ${s2}  ${zero(s2) ? "✓ empty" : "✗ NOT empty"}`);
  if (!zero(s1) || !zero(s2)) throw new Error("rig is not in the mainnet-like state — abort");

  const abi = [
    { inputs: [{ name: "n", type: "address" }], name: "scheduleUpgrade", outputs: [], stateMutability: "nonpayable", type: "function" },
    { inputs: [{ name: "n", type: "address" }, { name: "d", type: "bytes" }], name: "upgradeToAndCall", outputs: [], stateMutability: "payable", type: "function" },
    { inputs: [], name: "UPGRADE_DELAY", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "upgrader", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  ];
  const c = await tw.contract(abi, proxyT);
  const delay = Number(await c.UPGRADE_DELAY().call());
  console.log(`   UPGRADE_DELAY: ${delay}s`);

  const upgradeTo = async (target: string, label: string) => {
    console.log(`\n${label} -> ${target}`);
    await c.scheduleUpgrade(target).send({ feeLimit: 200_000_000, shouldPollResponse: true });
    console.log(`   scheduled; waiting ${delay}s`);
    await new Promise(r => setTimeout(r, delay * 1000 + 15000));
    await c.upgradeToAndCall(target, "0x").send({ feeLimit: 500_000_000, callValue: 0, shouldPollResponse: true });
    await new Promise(r => setTimeout(r, 9000));
    const live = "0x" + (await storageAt(proxyHex, IMPL_SLOT)).slice(-40);
    const ok = live.toLowerCase() === target.toLowerCase();
    console.log(`   impl now: ${live}  ${ok ? "✓" : "✗ MISMATCH"}`);
    if (!ok) throw new Error(`${label} did not take effect`);
  };

  await upgradeTo(implB, "STEP 3 — upgrade #1");
  await upgradeTo(implA, "STEP 4 — upgrade #2 (back to A)");
  await upgradeTo(implB, "STEP 5 — upgrade #3 (B again)");

  console.log("\n=== RESULT ===");
  console.log("Three consecutive upgrades succeeded from a proxy whose TronUUPS slots");
  console.log("were empty — the same state as both Tron mainnet proxies.");
  console.log("The gapless + immutable UUPS base has no proxy-context deadlock.");
  console.log(`\nThrowaway addresses (safe to ignore): proxy ${proxyT}`);
}

main().then(() => process.exit(0)).catch(e => { console.error("\n✗", e.message || JSON.stringify(e)); process.exit(1); });
