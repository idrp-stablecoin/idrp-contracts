import hre from "hardhat"
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers"

/**
 * Perform an upgrade the way a real TRON upgrade does, without the OZ plugin.
 *
 * ⚠️ THIS DELIBERATELY DOES NOT RUN OZ'S STORAGE-LAYOUT CHECK, and that needs
 * justifying rather than assuming.
 *
 * v3 drops `AccessControlUpgradeable` and `ERC165Upgradeable`, so their named
 * variables (`_roles`, two `__gap`s) leave the layout and the validator refuses
 * the upgrade — it has no annotation for a deletion. But
 * `LegacyAccessControlSlots` reserves exactly the 100 slots they occupied, so
 * nothing physically moves. That is a naming objection, not a statement about
 * the chain.
 *
 * What replaces the check: `test/upgrade/TronBattleTest.ts` and
 * `test/upgrade/TronV2ToV3Real.ts` drive these paths for real against the real
 * legacy sources and assert every slot, every balance, and DOMAIN_SEPARATOR —
 * which is the value that would move first, and silently, if the 100-slot
 * reservation ever changed.
 *
 * Do not reach for this helper to get past a validator complaint you have not
 * measured.
 */
export async function upgradeTronProxy(
  proxyAddr: string,
  targetContract: string,
  opts: { as?: any; initData?: string; abiFor?: string } = {},
) {
  const Factory = await hre.ethers.getContractFactory(targetContract)
  const impl = await Factory.deploy()
  await impl.waitForDeployment()
  const implAddr = await impl.getAddress()

  // The proxy's CURRENT implementation decides whether a timelock applies, so
  // talk to it through a minimal ABI rather than the target's.
  const abi = [
    "function scheduleUpgrade(address) external",
    "function UPGRADE_DELAY() view returns (uint256)",
    "function upgradeTo(address) external",
    "function upgradeToAndCall(address,bytes) external payable",
  ]
  const base = new hre.ethers.Contract(proxyAddr, abi, opts.as ?? (await hre.ethers.getSigners())[0])

  try {
    await (await base.scheduleUpgrade(implAddr)).wait()
    const delay = await base.UPGRADE_DELAY()
    await time.increase(Number(delay) + 1)
  } catch {
    // v1 proxies have no timelock — nothing to schedule.
  }

  if (opts.initData && opts.initData !== "0x") {
    await (await base.upgradeToAndCall(implAddr, opts.initData)).wait()
  } else {
    // NEVER upgradeToAndCall(impl, "0x") on OZ 4.9.6 — forceCall=true makes it
    // delegatecall the implementation with empty calldata and revert.
    await (await base.upgradeTo(implAddr)).wait()
  }

  // Record the new layout with the plugin. Skipping this leaves the manifest
  // describing the PREVIOUS implementation, so any later upgrades.* call either
  // errors with "not registered" or validates against a layout the proxy no
  // longer has.
  try { await hre.upgrades.forceImport(proxyAddr, Factory, { kind: "uups" }) } catch { /* best effort */ }

  return hre.ethers.getContractAt(opts.abiFor ?? targetContract, proxyAddr)
}
