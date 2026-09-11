/**
 * Deploy TronUUPSProxySlotProbe on Nile and measure whether the LIVE Controller
 * implementation's initializeV3 writes the TronUUPS proxy slot.
 *
 *   npx hardhat run scripts/nile-probe-proxy-slot.ts --network nile
 *
 * Read scripts/../contracts/probe/TronUUPSProxySlotProbe.sol for why this exists.
 * Nothing here touches the real Controller proxy.
 */
import hre from "hardhat";
const TronWeb = require("tronweb");

const HOST = "https://nile.trongrid.io";
const LIVE_IMPL = "0x95c9eed985536228d4a220d1357f2f20cf8709d2";
const MULTISIG = "0x3a5CB1052ca9FBCd7B92574439d837bC0Df5FA4f";

async function getStorage(addrHex: string, slot: string) {
  const r = await fetch(HOST + "/jsonrpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: [addrHex, slot, "latest"] }),
  }).then((x) => x.json() as any);
  return (r.result as string) ?? "0x0";
}

async function main() {
  if (hre.network.name !== "nile") throw new Error(`nile only (got ${hre.network.name})`);
  const { ethers, deployments } = hre as any;
  const PROXY_SLOT = ethers.keccak256(ethers.toUtf8Bytes("idrp.tron.uups.__proxy"));

  const [signer] = await hre.ethers.getSigners();
  const deployerHexAddr = await signer.getAddress();
  console.log(`Deployer: ${deployerHexAddr}`);

  console.log(`\nDeploying the probe (delegates to the live impl ${LIVE_IMPL}) …`);
  const res = await deployments.deploy("TronUUPSProxySlotProbe", {
    from: deployerHexAddr,
    contract: "TronUUPSProxySlotProbe",
    args: [],
    log: true,
    gasLimit: 10_000_000,
    gasPrice: "420",
  });
  const probeHex = res.address.toLowerCase();
  console.log(`  probe: ${probeHex}`);

  console.log(`\nCloned state on the probe (should match the live proxy):`);
  const before = await getStorage(probeHex, PROXY_SLOT);
  for (const [lbl, slot, want] of [
    ["slot 0   (_initialized)", "0x0", "1"],
    ["slot 258 (upgrader)", "0x102", "deployer"],
    ["ERC-1967 impl", "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "live impl"],
  ] as const) {
    console.log(`  ${lbl.padEnd(26)} ${await getStorage(probeHex, slot)}   (expect ${want})`);
  }
  console.log(`  ${"_PROXY_SLOT".padEnd(26)} ${before}   (expect zero)`);
  if (BigInt(before) !== 0n) throw new Error("probe did not start with a zero proxy slot — abort");

  const { vars } = require("hardhat/config");
  const raw = vars.get("IDRP_DEPLOYER_PRIVATE_KEY_TRON");
  const pk = raw.startsWith("0x") ? raw.slice(2) : raw;
  const tw = new TronWeb({ fullHost: HOST, privateKey: pk });
  const meT = tw.address.fromPrivateKey(pk);
  const probeT = tw.address.fromHex("41" + probeHex.slice(2));
  console.log(`\nprobe (T): ${probeT}`);

  const iface = new ethers.Interface([
    "function initializeV3(address _admin, address _upgrader, address[] _legacyDefaultAdminHolders)",
  ]);
  const data = iface.encodeFunctionData("initializeV3", [deployerHexAddr, deployerHexAddr, [MULTISIG]]);

  console.log(`\nCalling initializeV3 on the probe …`);
  const tx = await tw.trx.sendRawTransaction(
    await tw.trx.sign(
      (
        await tw.transactionBuilder.triggerSmartContract(
          tw.address.toHex(probeT),
          "initializeV3(address,address,address[])",
          { feeLimit: 150_000_000, callValue: 0, rawParameter: data.slice(10) },
          [],
          tw.address.toHex(meT)
        )
      ).transaction
    )
  );
  const txid = tx.txid ?? tx.transaction?.txID;
  console.log(`  txid: ${txid}`);

  // Poll the receipt rather than trusting the broadcast.
  let result = "";
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const info = await fetch(HOST + "/wallet/gettransactioninfobyid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: txid }),
    }).then((x) => x.json() as any);
    if (info?.receipt?.result) {
      result = info.receipt.result;
      console.log(`  receipt: ${result}  (block ${info.blockNumber}, energy ${info.receipt.energy_usage_total})`);
      if (info.resMessage) console.log(`  resMessage: ${Buffer.from(info.resMessage, "hex").toString()}`);
      break;
    }
  }
  if (!result) throw new Error("no receipt after 60s — re-check before concluding anything");

  const after = await getStorage(probeHex, PROXY_SLOT);
  const initAfter = await getStorage(probeHex, "0x0");
  console.log(`\nResult:`);
  console.log(`  _PROXY_SLOT after : ${after}`);
  console.log(`  slot 0 after      : ${initAfter}`);

  const wrote = BigInt(after) !== 0n;
  const matches = wrote && BigInt(after) === BigInt(probeHex);
  console.log(`\n${"=".repeat(74)}`);
  if (result !== "SUCCESS") {
    console.log(`initializeV3 REVERTED on the probe (${result}). Inconclusive — do not act.`);
  } else if (matches) {
    console.log(`MEASURED: initializeV3 writes _PROXY_SLOT = address(this).`);
    console.log(`Calling it on the real Controller proxy migrates to ACDAR *and* restores`);
    console.log(`upgradeability, so the scheduled upgrade can then be executed.`);
  } else if (wrote) {
    console.log(`MEASURED: _PROXY_SLOT was written, but to ${after} — not the proxy. Investigate.`);
  } else {
    console.log(`MEASURED: initializeV3 does NOT write _PROXY_SLOT.`);
    console.log(`Calling it on the real proxy would consume reinitializer(3) and leave the`);
    console.log(`Controller permanently un-upgradeable. DO NOT CALL IT — redeploy instead.`);
  }
  console.log(`${"=".repeat(74)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
