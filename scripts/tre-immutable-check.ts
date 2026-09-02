/**
 * Local TVM check — does TVM execute Solidity `immutable`?
 *
 * This is the one question the local EVM tests cannot answer, and it is the reason
 * TronUUPSUpgradeable replaced OZ's `immutable __self` with a storage slot in April 2026.
 * If TVM reads immutables correctly, that workaround — and the deadlock it caused — is
 * unnecessary.
 *
 * Talks to TRE over the native Tron HTTP API. TRE's JSON-RPC bridge does not implement
 * eth_getTransactionCount, so the ethers/hardhat path cannot be used here.
 *
 *   docker run -d --name idrp-tre -p 9090:9090 tronbox/tre
 *   npx hardhat run scripts/tre-immutable-check.ts --network tre
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "http://127.0.0.1:9090";

async function main() {
  const accts: any = await fetch(`${HOST}/admin/accounts-json`).then(r => r.json());
  const pk = accts.privateKeys[0];
  const tw = new TronWeb({ fullHost: HOST, privateKey: pk });
  const me = tw.address.fromPrivateKey(pk);
  console.log(`local TVM: ${HOST}\nsigner   : ${me}\n`);

  const art = await hre.artifacts.readArtifact("IDRPController");
  const proxyArt = await hre.artifacts.readArtifact("ERC1967Proxy");

  const deploy = async (a: any, params: any[] = [], label = "") => {
    const tx = await tw.transactionBuilder.createSmartContract(
      { abi: { entrys: a.abi }, bytecode: a.bytecode.replace(/^0x/, ""),
        feeLimit: 1_000_000_000, callValue: 0, userFeePercentage: 100,
        originEnergyLimit: 10_000_000, parameters: params, name: a.contractName },
      tw.address.toHex(me));
    const signed = await tw.trx.sign(tx);
    const res = await tw.trx.sendRawTransaction(signed);
    if (!res.result) throw new Error(`${label} deploy failed: ${JSON.stringify(res)}`);
    await new Promise(r => setTimeout(r, 3000));
    const addr = tw.address.fromHex(tx.contract_address);
    console.log(`  ${label}: ${addr}`);
    return addr;
  };

  console.log("deploying");
  const implA = await deploy(art, [], "impl A");
  const implB = await deploy(art, [], "impl B");

  // THE TEST: proxiableUUID() is `notDelegated` — it requires address(this) == __self.
  // Calling it directly on the implementation can only succeed if TVM read the immutable.
  const ia = await tw.contract(art.abi, implA);
  const uuid = await ia.proxiableUUID().call();
  const expected = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const got = "0x" + uuid.toString().replace(/^0x/, "");
  console.log(`\nproxiableUUID() called DIRECTLY on impl: ${got}`);
  console.log(`  expected: ${expected}`);
  console.log(got.toLowerCase() === expected
    ? "  ✓ TVM read `immutable __self` correctly — notDelegated passed"
    : "  ✗ immutable NOT readable on TVM");
  if (got.toLowerCase() !== expected) throw new Error("immutable check failed");

  // And through a proxy: onlyProxy also depends entirely on the immutable.
  const { ethers } = hre;
  const initData = new ethers.Interface(["function initialize(address,address)"])
    .encodeFunctionData("initialize", ["0x" + tw.address.toHex(me).slice(2), "0x" + tw.address.toHex(me).slice(2)]);
  const proxy = await deploy(proxyArt,
    [implA, initData], "proxy");

  const c = await tw.contract(art.abi, proxy);
  console.log(`\nupgrader() via proxy: ${(await c.upgrader().call()).toString()}`);
  const delay = Number(await c.UPGRADE_DELAY().call());
  console.log(`UPGRADE_DELAY: ${delay}s`);

  await c.scheduleUpgrade(implB).send({ feeLimit: 500_000_000, shouldPollResponse: true });
  console.log(`scheduled -> ${implB}; waiting ${delay}s`);
  await new Promise(r => setTimeout(r, delay * 1000 + 5000));
  await c.upgradeTo(implB).send({ feeLimit: 500_000_000, shouldPollResponse: true });
  await new Promise(r => setTimeout(r, 3000));

  const slot = await tw.trx.getContractStorageAt?.(proxy,
    "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc").catch(() => null);
  console.log(`\nupgrade executed via onlyProxy (immutable-gated) — no revert`);
  if (slot) console.log(`impl slot now: ${slot}`);

  console.log("\n=== RESULT ===");
  console.log("TVM executes Solidity immutables correctly. The storage-slot workaround in");
  console.log("TronUUPSUpgradeable is unnecessary, and the deadlock it caused is avoidable.");
}
main().then(() => process.exit(0)).catch(e => { console.error("\n✗", e.message || JSON.stringify(e)); process.exit(1); });
