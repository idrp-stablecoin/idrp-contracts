import hre from "hardhat";
import { expect } from "chai";

/**
 * Fork rehearsal of the next EVM upgrade session, one chain per run, against the
 * real proxies, the real upgrader and the real governance Safe at head.
 *
 *   FORK_CHAIN=ethereum HARDHAT_CHAIN_ID=1 npx hardhat test test/upgrade/ForkUpgradeRehearsal.ts
 *   (polygon 137, bsc 56, kaia 8217; FORK_RPC_URL overrides the default RPC)
 *
 * Optional: FORK_BLOCK pins an exact block (re-runs then hit a caching relay),
 * FORK_BLOCK_LAG (default 3) pins that far behind head, FORK_TIMEOUT_MS raises
 * the per-stage timeout for throttled RPCs.
 *
 * HARDHAT_CHAIN_ID must equal the forked chain's id: the token's EIP712 domain is
 * derived from block.chainid, so a fork running as 31337 reports a different
 * DOMAIN_SEPARATOR after the first locally mined block.
 *
 * Skipped unless FORK_CHAIN is set, so a plain run never depends on an RPC.
 *
 * Every call is made by whoever holds the seat on chain at the fork block — the
 * governance Safe through execTransaction (owners' approveHash, real threshold),
 * or the EOA by impersonation — so the rehearsal follows the chain, not a note.
 *
 * Stages, each asserted on live state:
 *   1. what runs today: seats, implementations, token source identity, no
 *      pending upgrade, the handover namespace empty
 *   2. both proxies upgraded the way the session will do it
 *   3. every piece of token and controller state survives
 *   4. a quorum-signed mint and burn still execute; a re-used identifier does not
 *   5. governance ends on the Safe: any pending controller admin handover is
 *      accepted by the Safe, the controller upgrader follows, and both token
 *      handovers are exercised through the Safe (begin, cancel, too-early
 *      accept, accept) out to a fresh key and back
 *   6. the Safe upgrades both proxies twice more, and everything still holds
 *
 * The chain's public RPC must keep state at the pinned block for the length of
 * the run; the defaults below were measured to serve state 300 blocks back.
 */

type Chain = { chainId: bigint; rpc: string; token: string; controller: string };

const CHAINS: Record<string, Chain> = {
  ethereum: {
    chainId: 1n,
    rpc: "https://rpc.mevblocker.io",
    token: "0x07429a7f8F80Db4Bf05D0753Aa6b0FD156fffA56",
    controller: "0x9cB9AE7480ee98A41373100d4304194043f02c9d",
  },
  polygon: {
    chainId: 137n,
    rpc: "https://polygon.gateway.tenderly.co",
    token: "0xADb603C1D0a1b3943C9df35a50099f22fEaCaA58",
    controller: "0x877538747fe8acb657C1a54A759A8e4B9cC987Bc",
  },
  bsc: {
    chainId: 56n,
    rpc: "https://bsc-mainnet.public.blastapi.io",
    token: "0x817d0C3D4e63231d88B2d73217B7fB75b87e0606",
    controller: "0x466d7B865e394f640aa436a399A464f7dC65C410",
  },
  kaia: {
    chainId: 8217n,
    rpc: "https://archive-en.node.kaia.io",
    token: "0xC16d986585407A74Ab87d17C3d0Dc19822E3EB35",
    controller: "0xA2A8337eBc5d8553BFa12749eaB6b4bEAAc9137d",
  },
};

/** Governance Safe, same address on all four chains. */
const SAFE = "0xCd82e8d4F9cf5c5cB5B7E63A54F2Ea10dc77f7f0";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** OZ 5 Initializable namespace. */
const INITIALIZABLE_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
/** idrp.storage.AuthorityTransfer, derived in test/IDRP.AuthorityTransfer.ts. */
const HANDOVER_SLOT = 0xd991add08b46b747ed6af6ef75a6adb683aeb97c062570389ee0117fb395ff00n;
const DAY = 24n * 60n * 60n;
const DELAY = 2n * DAY;
const EIP170_LIMIT = 24_576;
const ZERO = hre.ethers.ZeroAddress;

const SAFE_ABI = [
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
];

const name = process.env.FORK_CHAIN ?? "";
const chain = CHAINS[name];

describe(`Fork rehearsal: next upgrade session on ${name || "(no FORK_CHAIN)"}`, function () {
  this.timeout(Number(process.env.FORK_TIMEOUT_MS ?? 600_000));

  const gas: Record<string, bigint> = {};
  const st: any = {};
  let failed = false;
  let originalFork: unknown;

  beforeEach(function () {
    if (failed) this.skip();
  });
  afterEach(function () {
    if (this.currentTest?.state === "failed") failed = true;
  });

  async function impersonate(addr: string) {
    await hre.network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]); // 100 native
    return hre.ethers.getImpersonatedSigner(addr);
  }

  async function slot(addr: string, s: string | bigint) {
    return BigInt(await hre.ethers.provider.getStorage(addr, s));
  }

  async function implOf(proxy: string) {
    return hre.ethers.getAddress("0x" + (await slot(proxy, IMPL_SLOT)).toString(16).padStart(40, "0"));
  }

  async function record(label: string, txp: Promise<any>) {
    const tx = await txp;
    const receipt = await tx.wait();
    gas[label] = receipt.gasUsed;
    return receipt;
  }

  /** Runtime bytecode equality with immutables and the CBOR metadata tail masked out. */
  async function sameRuntime(deployed: string, source: string, contract: string) {
    const info = await hre.artifacts.getBuildInfo(`${source}:${contract}`);
    const out = (info!.output.contracts as any)[source][contract].evm.deployedBytecode;
    const a = Buffer.from(out.object, "hex");
    const b = Buffer.from(deployed.slice(2), "hex");
    if (a.length !== b.length) return { equal: false, detail: `length ${a.length} vs ${b.length}` };
    let masked = 0;
    for (const refs of Object.values(out.immutableReferences ?? {}) as any[]) {
      for (const { start, length } of refs) {
        a.fill(0, start, start + length);
        b.fill(0, start, start + length);
        masked++;
      }
    }
    const strip = (x: Buffer) => x.subarray(0, x.length - (x.readUInt16BE(x.length - 2) + 2));
    return { equal: strip(a).equals(strip(b)), detail: `${a.length} bytes, ${masked} immutable runs masked` };
  }

  async function tokenState(t: any) {
    const depository = await t.depositoryWallet();
    return {
      totalSupply: await t.totalSupply(),
      depositoryWallet: depository,
      depositoryBalance: await t.balanceOf(depository),
      controllerBalance: await t.balanceOf(chain.controller),
      depositoryNonce: await t.nonces(depository),
      maxSupply: await t.maxSupply(),
      sanctionsList: await t.sanctionsList(),
      controller: await t.controller(),
      paused: await t.paused(),
      domainSeparator: await t.DOMAIN_SEPARATOR(),
      name: await t.name(),
      symbol: await t.symbol(),
      decimals: await t.decimals(),
      upgradeDelay: await t.UPGRADE_DELAY(),
    };
  }

  async function controllerState(c: any) {
    const roles = ["OFFICER_ROLE", "MANAGER_ROLE", "DIRECTOR_ROLE", "COMMISSIONER_ROLE"];
    const holders: Record<string, boolean> = {};
    for (const r of roles) {
      for (const who of st.knownRoleHolders ?? []) {
        holders[`${r}:${who}`] = await c.hasRole(await c[r](), who);
      }
    }
    const rules: string[] = [];
    const probes = [0n, 499_999_999n * 10n ** 6n, 500_000_000n * 10n ** 6n, 10n ** 15n, 10n ** 16n, 10n ** 30n];
    for (let op = 0; op <= 5; op++) {
      for (const amount of probes) {
        try {
          const r = await c.getQuorumRule(op, amount);
          rules.push(`${op}:${amount}:${r.minAmount}-${r.maxAmount}:${[...r.requiredRoles].join(",")}`);
        } catch (e: any) {
          // A revert means "no rule for this amount"; an RPC failure means nothing.
          if (e?.code !== "CALL_EXCEPTION") throw e;
          rules.push(`${op}:${amount}:none`);
        }
      }
    }
    return {
      idrpToken: await c.idrpToken(),
      defaultAdminDelay: await c.defaultAdminDelay(),
      maxDeadline: await c.MAX_DEADLINE_DURATION(),
      upgradeDelay: await c.UPGRADE_DELAY(),
      // Same inputs before and after: equal digests mean DOMAIN_SEPARATOR and
      // the typehash survived, so every signature in flight stays valid.
      digest: await c.getOperationHash(ZERO, 0, 1n, "fork-rehearsal-probe", 1n),
      holders,
      rules,
    };
  }

  /** Owners pre-approve the Safe tx (threshold of them); returns the submitter. */
  async function safePrepare(to: string, data: string) {
    const safe: any = st.safe;
    const nonce = await safe.nonce();
    const hash = await safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, ZERO, ZERO, nonce);
    const approvers = st.safeOwners.slice(0, Number(st.safeThreshold));
    for (const owner of approvers) {
      await safe.connect(await impersonate(owner)).approveHash(hash);
    }
    // Pre-approved signatures: r = owner, s = 0, v = 1, sorted by owner.
    const sigs = hre.ethers.concat(
      [...approvers]
        .sort((x: string, y: string) => (BigInt(x) < BigInt(y) ? -1 : 1))
        .map((o: string) => hre.ethers.concat([hre.ethers.zeroPadValue(o, 32), hre.ethers.ZeroHash, "0x01"]))
    );
    return () => safe.connect(st.deployer).execTransaction(to, 0, data, 0, 0, 0, 0, ZERO, ZERO, sigs);
  }

  async function safeExec(to: string, data: string) {
    return (await safePrepare(to, data))();
  }

  /** Send `data` to `to` as `holder`: the Safe via execTransaction, anyone else impersonated. */
  async function sendAs(holder: string, to: string, data: string, label?: string) {
    const isSafe = holder.toLowerCase() === SAFE.toLowerCase();
    const txp = isSafe ? safeExec(to, data) : (await impersonate(holder)).sendTransaction({ to, data });
    return label ? record(isSafe ? `${label} (via Safe)` : label, txp) : (await txp).wait();
  }

  async function quorumOp(opType: number, to: string, amount: bigint, id: string) {
    const c = st.ctrl;
    const deadline = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const digest = await c.getOperationHash(to, opType, amount, id, deadline);
    const signatures = st.signers.map((w: any) => w.signingKey.sign(digest).serialized);
    return { tx: c.connect(st.signers[0]).executeOperation(opType, to, amount, id, deadline, signatures), deadline, signatures };
  }

  async function mintAndBurn(tag: string) {
    const t = st.tok;
    const supply = await t.totalSupply();
    const depository = await t.depositoryWallet();
    const bal = await t.balanceOf(depository);
    const unit = 10n ** 6n; // 1 IDRP

    const mintId = `fork-rehearsal-${name}-${tag}-mint`;
    await record(`executeOperation(Mint) ${tag}`, (await quorumOp(0, ZERO, unit, mintId)).tx);
    expect(await t.totalSupply()).to.equal(supply + unit);
    expect(await t.balanceOf(depository)).to.equal(bal + unit);

    // Same identifier, fresh deadline and signatures: must not run twice.
    await expect((await quorumOp(0, ZERO, unit, mintId)).tx).to.be.revertedWith(
      "Operation identifier already used"
    );

    await record(`executeOperation(Burn) ${tag}`, (await quorumOp(1, depository, unit, `fork-rehearsal-${name}-${tag}-burn`)).tx);
    expect(await t.totalSupply()).to.equal(supply);
    expect(await t.balanceOf(depository)).to.equal(bal);
  }

  async function upgradeBoth(tag: string) {
    const tokenImpl = await (await hre.ethers.getContractFactory("IDRP", st.deployer)).deploy();
    const ctrlImpl = await (await hre.ethers.getContractFactory("IDRPController", st.deployer)).deploy();
    gas[`deploy IDRP impl ${tag}`] = (await tokenImpl.deploymentTransaction()!.wait())!.gasUsed;
    gas[`deploy IDRPController impl ${tag}`] = (await ctrlImpl.deploymentTransaction()!.wait())!.gasUsed;
    const ti = await tokenImpl.getAddress();
    const ci = await ctrlImpl.getAddress();
    const tokenUpgrader = await st.tok.upgrader();
    const ctrlUpgrader = await st.ctrl.upgrader();

    await sendAs(tokenUpgrader, chain.token, st.tok.interface.encodeFunctionData("scheduleUpgrade", [ti]), `token scheduleUpgrade ${tag}`);
    await sendAs(ctrlUpgrader, chain.controller, st.ctrl.interface.encodeFunctionData("scheduleUpgrade", [ci]), `controller scheduleUpgrade ${tag}`);
    await hre.network.provider.send("evm_increaseTime", [Number(DELAY + 1n)]);
    await hre.network.provider.send("evm_mine", []);
    await sendAs(tokenUpgrader, chain.token, st.tok.interface.encodeFunctionData("upgradeToAndCall", [ti, "0x"]), `token upgradeToAndCall ${tag}`);
    await sendAs(ctrlUpgrader, chain.controller, st.ctrl.interface.encodeFunctionData("upgradeToAndCall", [ci, "0x"]), `controller upgradeToAndCall ${tag}`);

    expect(await implOf(chain.token)).to.equal(ti);
    expect(await implOf(chain.controller)).to.equal(ci);
    expect(await st.tok.scheduledImplementation()).to.equal(ZERO);
    expect(await st.ctrl.scheduledImplementation()).to.equal(ZERO);
  }

  /** Move to just past `schedule` (never backwards). */
  async function passSchedule(schedule: bigint) {
    const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
    if (now <= schedule) await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(schedule + 1n)]);
    await hre.network.provider.send("evm_mine", []);
  }

  before(async function () {
    if (!chain) {
      console.log(`\n  [skipping] set FORK_CHAIN to one of: ${Object.keys(CHAINS).join(", ")}`);
      this.skip();
    }
    const rpc = process.env.FORK_RPC_URL ?? chain.rpc;
    const probe = new hre.ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
    const head = await probe.getBlockNumber();
    const { chainId } = await probe.getNetwork();
    expect(chainId).to.equal(chain.chainId);

    // A recent real operation, to check the upgraded controller still recognises
    // history. Best effort: public RPCs cap log ranges.
    const iface = (await hre.ethers.getContractFactory("IDRPController")).interface;
    const topic = iface.getEvent("OperationExecuted")!.topicHash;
    for (let back = 0; back < 3 && !st.history; back++) {
      const toBlock = head - back * 5_000;
      try {
        const logs = await Promise.race([
          probe.getLogs({ address: chain.controller, topics: [topic], fromBlock: toBlock - 4_999, toBlock }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 30s")), 30_000)),
        ]);
        const last = logs.at(-1);
        if (last) {
          const tx = await probe.getTransaction(last.transactionHash);
          const parsed = tx && tx.to && tx.to.toLowerCase() === chain.controller.toLowerCase() ? iface.parseTransaction({ data: tx.data }) : null;
          if (parsed?.name === "executeOperation") st.history = { hash: last.transactionHash, block: last.blockNumber, args: parsed.args };
        }
      } catch (e: any) {
        console.log(`    (history lookup skipped for window ending ${toBlock}: ${String(e.shortMessage ?? e.message).slice(0, 80)})`);
        break;
      }
    }
    probe.destroy();

    originalFork = (hre.network.config as { forking?: unknown }).forking;
    // A few blocks behind head; more when load-balanced upstreams sit at different heights.
    st.forkBlock = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : head - Number(process.env.FORK_BLOCK_LAG ?? 3);
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: rpc, blockNumber: st.forkBlock } }],
    });
    console.log(`\n    forked ${name} (chainId ${chainId}) at block ${st.forkBlock}`);
    const local = BigInt(await hre.network.provider.send("eth_chainId", []));
    expect(local, `run with HARDHAT_CHAIN_ID=${chain.chainId}`).to.equal(chain.chainId);
  });

  after(async function () {
    if (!chain) return;
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: originalFork ? [{ forking: originalFork }] : [],
    });
    const rows = Object.entries(gas);
    if (rows.length) {
      console.log(`\n    gas on the ${name} fork (EVM rules${name === "kaia" ? "; Kaia's own schedule may differ" : ""}):`);
      for (const [k, v] of rows) console.log(`      ${k.padEnd(52)} ${v.toString().padStart(10)}`);
    }
  });

  it("1. pre-flight: seats, implementations, source identity; no upgrade pending", async function () {
    st.tok = await hre.ethers.getContractAt("IDRPv3", chain.token);
    st.ctrl = await hre.ethers.getContractAt("IDRPController", chain.controller);
    st.safe = await hre.ethers.getContractAt(SAFE_ABI, SAFE);
    st.deployer = (await hre.ethers.getSigners())[0];
    await hre.network.provider.send("hardhat_setBalance", [st.deployer.address, "0x56BC75E2D63100000"]);

    // Touch everything remote early: the fork fetches lazily at the pinned block.
    st.tokenAdmin = await st.tok.admin();
    st.tokenUpgraderAddr = await st.tok.upgrader();
    st.defaultAdmin = await st.ctrl.defaultAdmin();
    st.ctrlUpgraderAddr = await st.ctrl.upgrader();
    st.safeOwners = await st.safe.getOwners();
    st.safeThreshold = await st.safe.getThreshold();
    st.safeVersion = await st.safe.VERSION();
    // Quorum-role holders measured on all four chains (2026-09-14), plus the admin.
    st.knownRoleHolders = [
      "0x18A769c8D2cbC5CC34cd7D2110E209FDb9434560",
      "0x9128D58404a0CD5e959f1F83E02f081d43874811",
      "0xc4195fB2FF8e4211A93fe5B06e52819295cc3281",
      "0x12dA5E4cF0aDC3A3673d6508CCfAAF46a3446Bf5",
      st.defaultAdmin,
    ];
    st.tokenImpl = await implOf(chain.token);
    st.ctrlImpl = await implOf(chain.controller);
    st.initialized = (await slot(chain.token, INITIALIZABLE_SLOT)) & 0xffffffffffffffffn;
    st.ctrlInitialized = (await slot(chain.controller, INITIALIZABLE_SLOT)) & 0xffffffffffffffffn;

    console.log(`    token      ${chain.token} impl ${st.tokenImpl} _initialized=${st.initialized}`);
    console.log(`    controller ${chain.controller} impl ${st.ctrlImpl} _initialized=${st.ctrlInitialized}`);
    console.log(`    token admin=${st.tokenAdmin} upgrader=${st.tokenUpgraderAddr}`);
    console.log(`    controller defaultAdmin=${st.defaultAdmin} upgrader=${st.ctrlUpgraderAddr}`);
    console.log(`    Safe ${SAFE} v${st.safeVersion} threshold ${st.safeThreshold}/${st.safeOwners.length}`);

    // The token source we upgrade FROM is the one actually deployed.
    const identity = await sameRuntime(await hre.ethers.provider.getCode(st.tokenImpl), "contracts/legacy/IDRPv3.sol", "IDRPv3");
    console.log(`    deployed token impl == IDRPv3 source: ${identity.equal} (${identity.detail})`);
    expect(identity.equal).to.equal(true);

    expect(await st.tok.controller()).to.equal(chain.controller);
    expect(await st.ctrl.idrpToken()).to.equal(chain.token);
    expect(await st.tok.scheduledImplementation()).to.equal(ZERO);
    expect(await st.tok.upgradeScheduledAt()).to.equal(0n);
    expect(await st.ctrl.scheduledImplementation()).to.equal(ZERO);
    expect(await st.ctrl.upgradeScheduledAt()).to.equal(0n);
    const [pendingDefaultAdmin, pendingDefaultAdminSchedule] = await st.ctrl.pendingDefaultAdmin();
    st.pendingDefaultAdmin = pendingDefaultAdmin;
    st.pendingDefaultAdminSchedule = pendingDefaultAdminSchedule;
    console.log(`    controller pending admin handover: ${pendingDefaultAdmin === ZERO ? "none" : `${pendingDefaultAdmin} acceptable after ${new Date(Number(pendingDefaultAdminSchedule) * 1000).toISOString()}`}`);
    // The namespace the handover build starts writing is empty today.
    expect(await slot(chain.token, HANDOVER_SLOT)).to.equal(0n);
    expect(await slot(chain.token, HANDOVER_SLOT + 1n)).to.equal(0n);
    expect((await hre.ethers.provider.getCode(SAFE)).length).to.be.greaterThan(2);

    st.tokenBefore = await tokenState(st.tok);
    // The permit domain users sign today, computed here independently.
    const domainTypeHash = hre.ethers.id("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    const liveDomain = hre.ethers.keccak256(
      hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [domainTypeHash, hre.ethers.id("IDRP"), hre.ethers.id("1"), chain.chainId, chain.token]
      )
    );
    expect(st.tokenBefore.domainSeparator).to.equal(liveDomain);
    st.ctrlBefore = await controllerState(st.ctrl);
    if (st.history) {
      const a = st.history.args;
      st.historyExecutedBefore = await st.ctrl.usedSignatures(
        await st.ctrl.getOperationHash(a.to, a.operationType, a.amount, a.operationIdentifier, a.deadline)
      );
      console.log(`    recent real operation: ${st.history.hash} (block ${st.history.block}), recorded=${st.historyExecutedBefore}`);
    }

    // Every key that holds a seat today, so it can be shown locked out later.
    st.formerHolders = [...new Set([st.tokenAdmin, st.tokenUpgraderAddr, st.defaultAdmin, st.ctrlUpgraderAddr].map((a: string) => a.toLowerCase()))]
      .filter((a) => a !== SAFE.toLowerCase());
  });

  it("2. upgrades both proxies the way the session will (schedule, 48h, upgradeToAndCall(impl, \"0x\"))", async function () {
    for (const n of ["IDRP", "IDRPController"]) {
      const { deployedBytecode } = await hre.artifacts.readArtifact(n);
      const size = (deployedBytecode.length - 2) / 2;
      console.log(`    ${n} runtime ${size} bytes (limit 24,576)`);
      expect(size).to.be.lessThan(EIP170_LIMIT);
    }
    await upgradeBoth("#1");
    st.tok = await hre.ethers.getContractAt("IDRP", chain.token);
  });

  it("3. keeps every piece of token and controller state; nothing is pending; the instant setters are gone", async function () {
    expect(await tokenState(st.tok)).to.deep.equal(st.tokenBefore);
    expect(await controllerState(st.ctrl)).to.deep.equal(st.ctrlBefore);
    expect(await st.tok.admin()).to.equal(st.tokenAdmin);
    expect(await st.tok.upgrader()).to.equal(st.tokenUpgraderAddr);
    expect(await st.ctrl.defaultAdmin()).to.equal(st.defaultAdmin);
    expect(await st.ctrl.upgrader()).to.equal(st.ctrlUpgraderAddr);
    expect((await slot(chain.token, INITIALIZABLE_SLOT)) & 0xffffffffffffffffn).to.equal(st.initialized);
    expect([...(await st.tok.pendingAdmin())]).to.deep.equal([ZERO, 0n]);
    expect([...(await st.tok.pendingUpgrader())]).to.deep.equal([ZERO, 0n]);

    for (const sig of ["setAdmin(address)", "setUpgrader(address)"]) {
      const data = new hre.ethers.Interface([`function ${sig}`]).encodeFunctionData(sig.split("(")[0], [st.deployer.address]);
      await expect(sendAs(st.tokenAdmin, chain.token, data)).to.be.reverted;
    }

    if (st.history) {
      const a = st.history.args;
      // A real operation from before the upgrade is still recognised by the
      // upgraded controller (digest record, same domain), and its identifier
      // key is untouched — history is not rewritten.
      expect(await st.ctrl.isOperationExecuted(a.to, a.operationType, a.amount, a.operationIdentifier, a.deadline)).to.equal(st.historyExecutedBefore);
      console.log(`    recent real operation still recognised: isOperationExecuted=${st.historyExecutedBefore}, identifier key=${await st.ctrl.isOperationIdentifierUsed(a.operationIdentifier)}`);
    }
  });

  it("4. a quorum-signed mint and burn still execute; a re-used identifier is refused", async function () {
    const c = st.ctrl;
    st.signers = [];
    for (const r of ["OFFICER_ROLE", "MANAGER_ROLE", "DIRECTOR_ROLE", "COMMISSIONER_ROLE"]) {
      const w = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
      await hre.network.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
      await sendAs(await c.defaultAdmin(), chain.controller, c.interface.encodeFunctionData("grantRole", [await c[r](), w.address]));
      st.signers.push(w);
    }
    if (st.tokenBefore.paused) this.skip();
    await mintAndBurn("after-upgrade");
  });

  it("5. governance ends on the Safe; both token handovers run through the Safe and back", async function () {
    const t = st.tok;
    const c = st.ctrl;
    const T = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
    await hre.network.provider.send("hardhat_setBalance", [T.address, "0x56BC75E2D63100000"]);

    // Controller admin: finish the handover that is pending on chain today, or
    // run one if none is.
    if ((await c.defaultAdmin()).toLowerCase() !== SAFE.toLowerCase()) {
      let [pending, schedule] = await c.pendingDefaultAdmin();
      if (pending.toLowerCase() !== SAFE.toLowerCase()) {
        await sendAs(await c.defaultAdmin(), chain.controller, c.interface.encodeFunctionData("beginDefaultAdminTransfer", [SAFE]), "controller beginDefaultAdminTransfer");
        [pending, schedule] = await c.pendingDefaultAdmin();
      }
      await passSchedule(schedule);
      await sendAs(SAFE, chain.controller, c.interface.encodeFunctionData("acceptDefaultAdminTransfer"), "controller acceptDefaultAdminTransfer");
    }
    expect(await c.defaultAdmin()).to.equal(SAFE);
    // The controller's upgrader has no delayed handover; its admin sets it.
    if ((await c.upgrader()).toLowerCase() !== SAFE.toLowerCase()) {
      await sendAs(SAFE, chain.controller, c.interface.encodeFunctionData("setUpgrader", [SAFE]), "controller setUpgrader");
    }
    expect(await c.upgrader()).to.equal(SAFE);

    // Token admin: begin + cancel through the current admin, then out to a
    // fresh key and back to the Safe, refused one second early each way.
    const admin0 = await t.admin();
    await sendAs(admin0, chain.token, t.interface.encodeFunctionData("beginAdminTransfer", [st.deployer.address]), "token beginAdminTransfer");
    const cancel = await sendAs(admin0, chain.token, t.interface.encodeFunctionData("cancelAdminTransfer"), "token cancelAdminTransfer");
    expect(cancel.logs.some((l: any) => { try { return t.interface.parseLog(l)?.name === "AdminTransferCanceled"; } catch { return false; } })).to.equal(true);
    expect([...(await t.pendingAdmin())]).to.deep.equal([ZERO, 0n]);

    await sendAs(admin0, chain.token, t.interface.encodeFunctionData("beginAdminTransfer", [T.address]));
    let [, schedule] = await t.pendingAdmin();
    await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(schedule)]);
    await expect(t.connect(T).acceptAdminTransfer()).to.be.revertedWithCustomError(t, "TransferDelayNotPassed");
    await passSchedule(schedule);
    await record("token acceptAdminTransfer (fresh key)", t.connect(T).acceptAdminTransfer());
    expect(await t.admin()).to.equal(T.address);

    await record("token beginAdminTransfer (back to Safe)", t.connect(T).beginAdminTransfer(SAFE));
    [, schedule] = await t.pendingAdmin();
    const tooEarly = await safePrepare(chain.token, t.interface.encodeFunctionData("acceptAdminTransfer"));
    await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(schedule)]);
    await expect(tooEarly()).to.be.reverted;
    await passSchedule(schedule);
    await record("token acceptAdminTransfer (via Safe)", tooEarly());
    expect(await t.admin()).to.equal(SAFE);

    // Token upgrader: the admin (Safe) hands it to the fresh key and back.
    await sendAs(SAFE, chain.token, t.interface.encodeFunctionData("beginUpgraderTransfer", [T.address]), "token beginUpgraderTransfer");
    [, schedule] = await t.pendingUpgrader();
    await passSchedule(schedule);
    await record("token acceptUpgraderTransfer (fresh key)", t.connect(T).acceptUpgraderTransfer());
    expect(await t.upgrader()).to.equal(T.address);
    await sendAs(SAFE, chain.token, t.interface.encodeFunctionData("beginUpgraderTransfer", [SAFE]));
    [, schedule] = await t.pendingUpgrader();
    await passSchedule(schedule);
    await sendAs(SAFE, chain.token, t.interface.encodeFunctionData("acceptUpgraderTransfer"), "token acceptUpgraderTransfer");
    expect(await t.upgrader()).to.equal(SAFE);
    expect([...(await t.pendingAdmin())]).to.deep.equal([ZERO, 0n]);
    expect([...(await t.pendingUpgrader())]).to.deep.equal([ZERO, 0n]);

    // Every key that held a seat before, and the fresh key, is now locked out.
    for (const key of [...st.formerHolders, T.address]) {
      const k = await impersonate(key);
      await expect(t.connect(k).setMaxSupply(1n)).to.be.revertedWithCustomError(t, "NotAdmin");
      await expect(t.connect(k).scheduleUpgrade(key)).to.be.revertedWithCustomError(t, "NotUpgrader");
      await expect(c.connect(k).scheduleUpgrade(key)).to.be.revertedWithCustomError(c, "NotUpgrader");
      await expect(c.connect(k).grantRole(await c.OFFICER_ROLE(), key)).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    }
  });

  it("6. the Safe upgrades both proxies twice more, and everything still holds", async function () {
    expect(await st.tok.upgrader()).to.equal(SAFE);
    expect(await st.ctrl.upgrader()).to.equal(SAFE);
    await upgradeBoth("#2");
    await upgradeBoth("#3");

    expect(await tokenState(st.tok)).to.deep.equal(st.tokenBefore);
    expect(await controllerState(st.ctrl)).to.deep.equal(st.ctrlBefore);
    expect([...(await st.tok.pendingAdmin())]).to.deep.equal([ZERO, 0n]);
    expect([...(await st.tok.pendingUpgrader())]).to.deep.equal([ZERO, 0n]);
    const roles = ["OFFICER_ROLE", "MANAGER_ROLE", "DIRECTOR_ROLE", "COMMISSIONER_ROLE"];
    for (let i = 0; i < roles.length; i++) {
      expect(await st.ctrl.hasRole(await st.ctrl[roles[i]](), st.signers[i].address)).to.equal(true);
    }
    if (!st.tokenBefore.paused) await mintAndBurn("after-three-upgrades");
  });
});
