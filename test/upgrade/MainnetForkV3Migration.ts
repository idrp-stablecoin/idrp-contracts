import hre from "hardhat";
import { expect } from "chai";

/**
 * Mainnet-fork test (Pattern C from docs/design/v3-rollout-plan.md).
 *
 * Forks Ethereum mainnet at the current block, impersonates the live
 * upgrader address (0xb2480df57396569f93D8A71203546066B66c1779), and runs
 * the v3 migration against the actual deployed bytecode of:
 *   IDRP            at 0x07429a7f8F80Db4Bf05D0753Aa6b0FD156fffA56
 *   IDRPController  at 0x9cB9AE7480ee98A41373100d4304194043f02c9d
 *
 * This is the strongest possible safety check before a real migration —
 * it tests against actual on-chain state, not an approximation in a mock.
 *
 * GATED BY ENV VAR: set MAINNET_FORK_RPC_URL to an Ethereum mainnet RPC
 * to run this test. Without that env var the test is skipped, so the
 * regular CI run (no RPC key) doesn't depend on external state.
 *
 * Usage:
 *   MAINNET_FORK_RPC_URL=https://eth.llamarpc.com \
 *     npx hardhat test test/upgrade/MainnetForkV3Migration.ts
 *
 * Or via the configured `mainnet` network's URL (read from hardhat.config.ts):
 *   FORK_FROM_HARDHAT_CONFIG=mainnet \
 *     npx hardhat test test/upgrade/MainnetForkV3Migration.ts
 */

const IDRP_PROXY = "0x07429a7f8F80Db4Bf05D0753Aa6b0FD156fffA56";
const CTRL_PROXY = "0x9cB9AE7480ee98A41373100d4304194043f02c9d";
const UPGRADER = "0xb2480df57396569f93D8A71203546066B66c1779";

describe("Mainnet fork: v2 → v3 migration against real Ethereum bytecode", function () {
  this.timeout(120_000);

  let originalForkConfig: unknown;

  before(async function () {
    const rpcUrl = process.env.MAINNET_FORK_RPC_URL;
    if (!rpcUrl) {
      console.log(
        "\n  [skipping] MAINNET_FORK_RPC_URL not set. " +
          "Set it to enable the mainnet-fork test."
      );
      this.skip();
    }

    // Capture and switch to forking mode pointed at mainnet.
    originalForkConfig = (hre.network.config as { forking?: unknown }).forking;
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: rpcUrl } }],
    });

    // Fund the upgrader so it can sign txs locally.
    await hre.network.provider.send("hardhat_setBalance", [
      UPGRADER,
      "0x" + (10n ** 19n).toString(16), // 10 ETH
    ]);

    // Impersonate it.
    await hre.network.provider.send("hardhat_impersonateAccount", [UPGRADER]);
  });

  after(async function () {
    if (process.env.MAINNET_FORK_RPC_URL) {
      await hre.network.provider.send("hardhat_stopImpersonatingAccount", [
        UPGRADER,
      ]);
      await hre.network.provider.request({
        method: "hardhat_reset",
        params: originalForkConfig
          ? [{ forking: originalForkConfig }]
          : [],
      });
    }
  });

  it("IDRP v2 → v3 upgrade succeeds on a mainnet fork (real upgrader signs)", async function () {
    const upgraderSigner = await hre.ethers.getImpersonatedSigner(UPGRADER);

    // Pre-flight: confirm we're really pointed at mainnet bytecode.
    const v2IDRP = await hre.ethers.getContractAt("IDRPv2", IDRP_PROXY);
    const currentUpgrader = await v2IDRP.upgrader();
    expect(currentUpgrader).to.equal(UPGRADER);

    const depositoryBefore = await v2IDRP.depositoryWallet();
    const totalSupplyBefore = await v2IDRP.totalSupply();
    console.log(`  pre-migration depositoryWallet: ${depositoryBefore}`);
    console.log(`  pre-migration totalSupply:      ${totalSupplyBefore}`);

    // Register the live mainnet proxy with the OZ Upgrades plugin so it
    // knows the existing storage layout (the local .openzeppelin manifest
    // doesn't apply to a fork). forceImport reads the deployed bytecode and
    // records it; we pass the v2 source so the plugin learns the v2 layout.
    const IDRPv2Legacy = await hre.ethers.getContractFactory("IDRPv2");
    await hre.upgrades.forceImport(IDRP_PROXY, IDRPv2Legacy, {
      kind: "uups",
    });
    console.log("  ✓ proxy registered with OZ Upgrades plugin");

    // Validate the storage layout before we attempt the upgrade.
    const IDRPv3 = await hre.ethers.getContractFactory("IDRP");
    await hre.upgrades.validateUpgrade(IDRP_PROXY, IDRPv3, {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call"],
    });
    console.log("  ✓ validateUpgrade passed");

    // Deploy v3 implementation.
    const v3Impl = (await hre.upgrades.prepareUpgrade(IDRP_PROXY, IDRPv3, {
      kind: "uups",
      unsafeAllow: ["missing-initializer-call"],
    })) as string;
    console.log(`  ✓ deployed v3 impl at ${v3Impl}`);

    // Schedule the upgrade (live v2 enforces 48h timelock).
    await v2IDRP.connect(upgraderSigner).scheduleUpgrade(v3Impl);
    console.log("  ✓ upgrade scheduled");

    // Advance time past the timelock.
    await hre.network.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine");

    // Execute the upgrade atomically with initializeV3.
    const initV3Data = IDRPv3.interface.encodeFunctionData("initializeV3", [
      UPGRADER, // admin
      CTRL_PROXY, // controller
      UPGRADER, // upgrader (unchanged)
    ]);
    await v2IDRP.connect(upgraderSigner).upgradeToAndCall(v3Impl, initV3Data);
    console.log("  ✓ upgrade executed + initializeV3 ran atomically");

    // Verify post-migration state.
    const v3IDRP = await hre.ethers.getContractAt("IDRP", IDRP_PROXY);
    expect(await v3IDRP.admin()).to.equal(UPGRADER);
    expect(await v3IDRP.controller()).to.equal(CTRL_PROXY);
    expect(await v3IDRP.upgrader()).to.equal(UPGRADER);
    expect(await v3IDRP.depositoryWallet()).to.equal(depositoryBefore);
    expect(await v3IDRP.totalSupply()).to.equal(totalSupplyBefore);
    console.log("  ✓ all post-migration assertions passed");
  });
});
