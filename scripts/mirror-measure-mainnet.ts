import fs from "fs";
import hre from "hardhat";
import { MAINNET_PROXIES, OPS, fixtureTiers, readChainConfig } from "./utils/mirror";

/**
 * Read-only: reads the quorum tables and wiring of the live IDRP controller on
 * the network it runs against and compares them with the fixtures in
 * test/utils. Sends no transaction.
 *
 * Usage:
 *   MEASURE_OUT=out.json npx hardhat run scripts/mirror-measure-mainnet.ts --network mainnet|bsc|polygon|kaia
 */
async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const proxies = MAINNET_PROXIES[chainId];
  if (!proxies) throw new Error(`chainId ${chainId} is not a mirrored mainnet`);
  const cfg = await readChainConfig(hre.ethers.provider, proxies.controller, proxies.token);
  console.log(`chain ${chainId}  token ${proxies.token}  controller ${proxies.controller}`);
  console.log(`  maxSupply=${cfg.maxSupply} sanctionsList=${cfg.sanctionsList}`);
  console.log(`  delays token=${cfg.tokenUpgradeDelay} ctrl=${cfg.controllerUpgradeDelay} adminDelay=${cfg.controllerDefaultAdminDelay}`);
  for (const [op, name, file] of OPS) {
    const live = JSON.stringify(cfg.rules[op]);
    const same = live === JSON.stringify(fixtureTiers(file, op));
    console.log(`  op ${op} ${name.padEnd(9)} ${cfg.rules[op].length} tier(s)  ${same ? "== fixture" : "DIFFERS from fixture"}`);
    if (!same) console.log(`    live ${live}`);
  }
  if (process.env.MEASURE_OUT) {
    const out = process.env.MEASURE_OUT;
    const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
    prev[chainId] = { ...proxies, ...cfg };
    fs.writeFileSync(out, JSON.stringify(prev, null, 2) + "\n");
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
