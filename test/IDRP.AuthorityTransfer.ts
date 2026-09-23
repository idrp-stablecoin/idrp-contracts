import hre from "hardhat";
import { expect } from "chai";
import {
  loadFixture,
  takeSnapshot,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * Delayed two-step handover of the token's `admin` and `upgrader`, modelled on
 * OpenZeppelin's AccessControlDefaultAdminRules: the admin begins a transfer,
 * UPGRADE_DELAY runs, then the new holder accepts. Until then the admin can
 * cancel it or begin another, which replaces it.
 *
 * Written to run unchanged on both lineages (OZ 5 on EVM, OZ 4 on Tron): slot
 * numbers come from the compiler, and upgrades go through `upgradeTo` where the
 * build still has it.
 */
describe("IDRP authority handover (admin + upgrader)", function () {
  const DELAY = 48n * 60n * 60n; // 172800, UPGRADE_DELAY on the canonical build
  const ZERO = hre.ethers.ZeroAddress;

  // These tests move the chain clock by days. Put it back afterwards: suites
  // that run later build their deadlines from wall-clock time.
  let untouched: Awaited<ReturnType<typeof takeSnapshot>>;
  before(async () => {
    untouched = await takeSnapshot();
  });
  after(async () => {
    await untouched.restore();
  });

  // ERC-7201 location of the handover state, derived here independently of the
  // contract: keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~0xff
  const NAMESPACE_SLOT = (() => {
    const inner =
      BigInt(hre.ethers.keccak256(hre.ethers.toUtf8Bytes("idrp.storage.AuthorityTransfer"))) - 1n;
    const outer = BigInt(
      hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [inner]))
    );
    return outer & ~0xffn;
  })();

  type Role = {
    name: "admin" | "upgrader";
    begin: string;
    cancel: string;
    accept: string;
    pending: string;
    current: string;
    scheduledEvent: string;
    canceledEvent: string;
    updatedEvent: string;
    notPendingError: string;
    invalidMessage: string;
    slotOffset: bigint;
  };

  const ROLES: Role[] = [
    {
      name: "admin",
      begin: "beginAdminTransfer",
      cancel: "cancelAdminTransfer",
      accept: "acceptAdminTransfer",
      pending: "pendingAdmin",
      current: "admin",
      scheduledEvent: "AdminTransferScheduled",
      canceledEvent: "AdminTransferCanceled",
      updatedEvent: "AdminUpdated",
      notPendingError: "NotPendingAdmin",
      invalidMessage: "Invalid admin",
      slotOffset: 0n,
    },
    {
      name: "upgrader",
      begin: "beginUpgraderTransfer",
      cancel: "cancelUpgraderTransfer",
      accept: "acceptUpgraderTransfer",
      pending: "pendingUpgrader",
      current: "upgrader",
      scheduledEvent: "UpgraderTransferScheduled",
      canceledEvent: "UpgraderTransferCanceled",
      updatedEvent: "UpgraderUpdated",
      notPendingError: "NotPendingUpgrader",
      invalidMessage: "Invalid upgrader",
      slotOffset: 1n,
    },
  ];

  async function fixture() {
    const [admin, target, other, second, extra] = await hre.ethers.getSigners();
    const IDRP = await hre.ethers.getContractFactory("IDRP");
    const idrp: any = await hre.upgrades.deployProxy(IDRP, [admin.address]);
    await idrp.waitForDeployment();
    return { idrp, IDRP, admin, target, other, second, extra };
  }

  async function pendingOf(idrp: any, role: Role): Promise<[string, bigint]> {
    const [who, schedule] = await idrp[role.pending]();
    return [who, BigInt(schedule)];
  }

  async function beginAndSchedule(idrp: any, role: Role, from: any, to: string) {
    const tx = await idrp.connect(from)[role.begin](to);
    const block = await hre.ethers.provider.getBlock(tx.blockNumber);
    return { tx, schedule: BigInt(block!.timestamp) + DELAY };
  }

  /** OZ 4 builds keep upgradeTo; OZ 5 builds only have upgradeToAndCall. */
  async function upgrade(idrp: any, from: any, impl: string) {
    return idrp.interface.getFunction("upgradeTo")
      ? idrp.connect(from).upgradeTo(impl)
      : idrp.connect(from).upgradeToAndCall(impl, "0x");
  }

  /** Slot of one of IDRP's own variables, read from the compiler's layout. */
  async function slotOf(variable: string): Promise<bigint> {
    const info = await hre.artifacts.getBuildInfo("contracts/IDRP.sol:IDRP");
    const layout = (info!.output.contracts as any)["contracts/IDRP.sol"].IDRP.storageLayout;
    const entry = layout.storage.find((s: any) => s.label === variable);
    if (!entry) throw new Error(`${variable} not in IDRP storage layout`);
    return BigInt(entry.slot);
  }

  async function word(idrp: any, slot: bigint): Promise<bigint> {
    return BigInt(await hre.ethers.provider.getStorage(await idrp.getAddress(), slot));
  }

  for (const role of ROLES) {
    describe(`${role.name} handover`, function () {
      it("starts with nothing pending", async function () {
        const { idrp } = await loadFixture(fixture);
        expect(await pendingOf(idrp, role)).to.deep.equal([ZERO, 0n]);
      });

      it("only the admin may begin", async function () {
        const { idrp, target, other } = await loadFixture(fixture);
        await expect(
          idrp.connect(other)[role.begin](target.address)
        ).to.be.revertedWithCustomError(idrp, "NotAdmin");
      });

      it("rejects the zero address", async function () {
        const { idrp, admin } = await loadFixture(fixture);
        await expect(idrp.connect(admin)[role.begin](ZERO)).to.be.revertedWith(
          role.invalidMessage
        );
      });

      it("begin records the target and a schedule UPGRADE_DELAY ahead, without moving the role", async function () {
        const { idrp, admin, target } = await loadFixture(fixture);
        const { tx, schedule } = await beginAndSchedule(idrp, role, admin, target.address);

        await expect(tx).to.emit(idrp, role.scheduledEvent).withArgs(target.address, schedule);
        expect(await pendingOf(idrp, role)).to.deep.equal([target.address, schedule]);
        expect(await idrp[role.current]()).to.equal(admin.address);
      });

      it("refuses acceptance before the schedule, and AT the schedule second", async function () {
        const { idrp, admin, target } = await loadFixture(fixture);
        const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);

        await expect(idrp.connect(target)[role.accept]())
          .to.be.revertedWithCustomError(idrp, "TransferDelayNotPassed")
          .withArgs(schedule);

        // OZ semantics: the schedule has passed only once block.timestamp > schedule.
        await time.setNextBlockTimestamp(schedule);
        await expect(idrp.connect(target)[role.accept]())
          .to.be.revertedWithCustomError(idrp, "TransferDelayNotPassed")
          .withArgs(schedule);
      });

      it("accepts one second after the schedule: moves the role, clears the pending pair, emits the update", async function () {
        const { idrp, admin, target } = await loadFixture(fixture);
        const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);

        await time.setNextBlockTimestamp(schedule + 1n);
        await expect(idrp.connect(target)[role.accept]())
          .to.emit(idrp, role.updatedEvent)
          .withArgs(admin.address, target.address);

        expect(await idrp[role.current]()).to.equal(target.address);
        expect(await pendingOf(idrp, role)).to.deep.equal([ZERO, 0n]);
      });

      it("only the pending holder may accept — not the current holder, not a stranger", async function () {
        const { idrp, admin, target, other } = await loadFixture(fixture);
        const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);
        await time.increaseTo(schedule + 1n);

        await expect(idrp.connect(admin)[role.accept]())
          .to.be.revertedWithCustomError(idrp, role.notPendingError)
          .withArgs(admin.address);
        await expect(idrp.connect(other)[role.accept]())
          .to.be.revertedWithCustomError(idrp, role.notPendingError)
          .withArgs(other.address);
      });

      it("refuses acceptance when nothing is pending", async function () {
        const { idrp, target } = await loadFixture(fixture);
        await expect(idrp.connect(target)[role.accept]())
          .to.be.revertedWithCustomError(idrp, role.notPendingError)
          .withArgs(target.address);
      });

      it("accepting is one-shot", async function () {
        const { idrp, admin, target } = await loadFixture(fixture);
        const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);
        await time.increaseTo(schedule + 1n);
        await idrp.connect(target)[role.accept]();

        await expect(idrp.connect(target)[role.accept]())
          .to.be.revertedWithCustomError(idrp, role.notPendingError)
          .withArgs(target.address);
      });

      it("cancel clears the pending pair and emits; the target can no longer accept", async function () {
        const { idrp, admin, target } = await loadFixture(fixture);
        const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);

        await expect(idrp.connect(admin)[role.cancel]()).to.emit(idrp, role.canceledEvent);
        expect(await pendingOf(idrp, role)).to.deep.equal([ZERO, 0n]);

        await time.increaseTo(schedule + 1n);
        await expect(idrp.connect(target)[role.accept]())
          .to.be.revertedWithCustomError(idrp, role.notPendingError)
          .withArgs(target.address);
        expect(await idrp[role.current]()).to.equal(admin.address);
      });

      it("cancel with nothing pending neither reverts nor emits", async function () {
        const { idrp, admin } = await loadFixture(fixture);
        await expect(idrp.connect(admin)[role.cancel]()).to.not.emit(idrp, role.canceledEvent);
      });

      it("only the admin may cancel — the target cannot", async function () {
        const { idrp, admin, target, other } = await loadFixture(fixture);
        await idrp.connect(admin)[role.begin](target.address);

        await expect(idrp.connect(target)[role.cancel]()).to.be.revertedWithCustomError(
          idrp,
          "NotAdmin"
        );
        await expect(idrp.connect(other)[role.cancel]()).to.be.revertedWithCustomError(
          idrp,
          "NotAdmin"
        );
      });

      it("beginning again replaces the target, restarts the clock, and cancels first", async function () {
        const { idrp, admin, target, second } = await loadFixture(fixture);
        const first = await beginAndSchedule(idrp, role, admin, target.address);
        await time.increase(3600);

        const again = await beginAndSchedule(idrp, role, admin, second.address);
        expect(again.schedule).to.be.greaterThan(first.schedule);

        const receipt = await again.tx.wait();
        const names = receipt.logs
          .map((l: any) => idrp.interface.parseLog(l)?.name)
          .filter(Boolean);
        expect(names).to.deep.equal([role.canceledEvent, role.scheduledEvent]);

        // The replaced target is out, even after its own schedule.
        await time.increaseTo(first.schedule + 1n);
        await expect(idrp.connect(target)[role.accept]())
          .to.be.revertedWithCustomError(idrp, role.notPendingError)
          .withArgs(target.address);
        // The new target waits out its own, later schedule.
        await expect(idrp.connect(second)[role.accept]())
          .to.be.revertedWithCustomError(idrp, "TransferDelayNotPassed")
          .withArgs(again.schedule);

        await time.increaseTo(again.schedule + 1n);
        await idrp.connect(second)[role.accept]();
        expect(await idrp[role.current]()).to.equal(second.address);
      });

      it("beginning again after the first schedule passed (unaccepted) still cancels it", async function () {
        const { idrp, admin, target, second } = await loadFixture(fixture);
        const first = await beginAndSchedule(idrp, role, admin, target.address);
        await time.increaseTo(first.schedule + 10n);

        await expect(idrp.connect(admin)[role.begin](second.address)).to.emit(
          idrp,
          role.canceledEvent
        );
        await expect(idrp.connect(target)[role.accept]())
          .to.be.revertedWithCustomError(idrp, role.notPendingError)
          .withArgs(target.address);
      });

      it("stores the pending pair at the ERC-7201 slot, packed address | uint48", async function () {
        const { idrp, admin, target } = await loadFixture(fixture);
        const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);

        const w = await word(idrp, NAMESPACE_SLOT + role.slotOffset);
        const mask160 = (1n << 160n) - 1n;
        expect(hre.ethers.getAddress("0x" + (w & mask160).toString(16).padStart(40, "0"))).to.equal(
          target.address
        );
        expect((w >> 160n) & ((1n << 48n) - 1n)).to.equal(schedule);
        expect(w >> 208n).to.equal(0n);
      });
    });
  }

  describe("admin handover specifics", function () {
    const role = ROLES[0];

    it("the old admin loses admin-only calls and the new admin gains them", async function () {
      const { idrp, admin, target } = await loadFixture(fixture);
      const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);
      await time.increaseTo(schedule + 1n);
      await idrp.connect(target).acceptAdminTransfer();

      await expect(idrp.connect(admin).setMaxSupply(1)).to.be.revertedWithCustomError(
        idrp,
        "NotAdmin"
      );
      await expect(idrp.connect(target).setMaxSupply(1))
        .to.emit(idrp, "MaxSupplyUpdated")
        .withArgs(0, 1);
    });

    it("leaves upgrader and controller where they were", async function () {
      const { idrp, admin, target, extra } = await loadFixture(fixture);
      await idrp.connect(admin).setController(extra.address);
      const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);
      await time.increaseTo(schedule + 1n);
      await idrp.connect(target).acceptAdminTransfer();

      expect(await idrp.upgrader()).to.equal(admin.address);
      expect(await idrp.controller()).to.equal(extra.address);
    });
  });

  describe("upgrader handover specifics", function () {
    const role = ROLES[1];

    it("the old upgrader can no longer schedule; the new one completes an upgrade", async function () {
      const { idrp, IDRP, admin, target } = await loadFixture(fixture);
      const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);
      await time.increaseTo(schedule + 1n);
      await idrp.connect(target).acceptUpgraderTransfer();

      const impl = await (await IDRP.deploy()).getAddress();
      await expect(idrp.connect(admin).scheduleUpgrade(impl)).to.be.revertedWithCustomError(
        idrp,
        "NotUpgrader"
      );
      await idrp.connect(target).scheduleUpgrade(impl);
      await time.increase(DELAY + 1n);
      await upgrade(idrp, target, impl);
      expect(await hre.upgrades.erc1967.getImplementationAddress(await idrp.getAddress())).to.equal(
        impl
      );
    });

    it("leaves admin where it was", async function () {
      const { idrp, admin, target } = await loadFixture(fixture);
      const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);
      await time.increaseTo(schedule + 1n);
      await idrp.connect(target).acceptUpgraderTransfer();
      expect(await idrp.admin()).to.equal(admin.address);
    });

    it("the upgrader cannot begin or cancel its own handover — only the admin can", async function () {
      const { idrp, admin, target, other } = await loadFixture(fixture);
      const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);
      await time.increaseTo(schedule + 1n);
      await idrp.connect(target).acceptUpgraderTransfer();

      await expect(
        idrp.connect(target).beginUpgraderTransfer(other.address)
      ).to.be.revertedWithCustomError(idrp, "NotAdmin");
      await idrp.connect(admin).beginUpgraderTransfer(other.address);
      await expect(idrp.connect(target).cancelUpgraderTransfer()).to.be.revertedWithCustomError(
        idrp,
        "NotAdmin"
      );
    });

    it("an upgrade the old upgrader scheduled can be executed by the new upgrader only", async function () {
      const { idrp, IDRP, admin, target } = await loadFixture(fixture);
      const impl = await (await IDRP.deploy()).getAddress();
      await idrp.connect(admin).scheduleUpgrade(impl);

      const { schedule } = await beginAndSchedule(idrp, role, admin, target.address);
      await time.increaseTo(schedule + 1n);
      await idrp.connect(target).acceptUpgraderTransfer();

      await expect(upgrade(idrp, admin, impl)).to.be.revertedWithCustomError(idrp, "NotUpgrader");
      await upgrade(idrp, target, impl);
      expect(await hre.upgrades.erc1967.getImplementationAddress(await idrp.getAddress())).to.equal(
        impl
      );
    });
  });

  describe("both handovers together", function () {
    it("a pending upgrader handover outlives an admin handover; only the new admin can cancel it", async function () {
      const { idrp, admin, target, second } = await loadFixture(fixture);
      await idrp.connect(admin).beginUpgraderTransfer(second.address);
      const { schedule } = await beginAndSchedule(idrp, ROLES[0], admin, target.address);
      await time.increaseTo(schedule + 1n);
      await idrp.connect(target).acceptAdminTransfer();

      const [pendingUpgrader] = await idrp.pendingUpgrader();
      expect(pendingUpgrader).to.equal(second.address);

      await expect(idrp.connect(admin).cancelUpgraderTransfer()).to.be.revertedWithCustomError(
        idrp,
        "NotAdmin"
      );
      await expect(idrp.connect(target).cancelUpgraderTransfer()).to.emit(
        idrp,
        "UpgraderTransferCanceled"
      );
    });

    it("both can be pending at once and each completes on its own", async function () {
      const { idrp, admin, target, second } = await loadFixture(fixture);
      await idrp.connect(admin).beginAdminTransfer(target.address);
      const up = await beginAndSchedule(idrp, ROLES[1], admin, second.address);
      await time.increaseTo(up.schedule + 1n);

      await idrp.connect(second).acceptUpgraderTransfer();
      expect(await idrp.upgrader()).to.equal(second.address);
      expect(await idrp.admin()).to.equal(admin.address);
      expect((await idrp.pendingAdmin())[0]).to.equal(target.address);

      await idrp.connect(target).acceptAdminTransfer();
      expect(await idrp.admin()).to.equal(target.address);
    });
  });

  describe("a compromised upgrader can still be stopped", function () {
    // With the upgrader handover delayed, a rogue upgrade scheduled by a
    // compromised upgrader would mature before any replacement could accept.
    // The admin's cancelUpgrade is the brake that covers that window.
    async function separateUpgrader(idrp: any, admin: any, upgrader: any) {
      const { schedule } = await beginAndSchedule(idrp, ROLES[1], admin, upgrader.address);
      await time.increaseTo(schedule + 1n);
      await idrp.connect(upgrader).acceptUpgraderTransfer();
    }

    it("the admin cancels a rogue upgrade, and it never executes", async function () {
      const { idrp, IDRP, admin, target: rogue } = await loadFixture(fixture);
      await separateUpgrader(idrp, admin, rogue);
      const evil = await (await IDRP.deploy()).getAddress();
      await idrp.connect(rogue).scheduleUpgrade(evil);

      await expect(idrp.connect(admin).cancelUpgrade())
        .to.emit(idrp, "UpgradeCancelled")
        .withArgs(evil, admin.address);

      await time.increase(DELAY + 1n);
      await expect(upgrade(idrp, rogue, evil)).to.be.revertedWith("Upgrade not scheduled");
    });

    it("the admin keeps cancelling while the replacement waits out the delay, then the rogue is out", async function () {
      const { idrp, IDRP, admin, target: rogue, second: replacement } = await loadFixture(fixture);
      await separateUpgrader(idrp, admin, rogue);
      const evil = await (await IDRP.deploy()).getAddress();

      await idrp.connect(rogue).scheduleUpgrade(evil);
      await idrp.connect(admin).cancelUpgrade();
      const { schedule } = await beginAndSchedule(idrp, ROLES[1], admin, replacement.address);
      await idrp.connect(rogue).scheduleUpgrade(evil); // tries again, same block window
      await idrp.connect(admin).cancelUpgrade();

      await time.increaseTo(schedule + 1n);
      await idrp.connect(replacement).acceptUpgraderTransfer();
      await expect(idrp.connect(rogue).scheduleUpgrade(evil)).to.be.revertedWithCustomError(idrp, "NotUpgrader");
      await expect(upgrade(idrp, rogue, evil)).to.be.revertedWithCustomError(idrp, "NotUpgrader");
    });

    it("anyone else still cannot cancel an upgrade", async function () {
      const { idrp, IDRP, admin, target: upgrader, other } = await loadFixture(fixture);
      await separateUpgrader(idrp, admin, upgrader);
      await idrp.connect(upgrader).scheduleUpgrade(await (await IDRP.deploy()).getAddress());
      await expect(idrp.connect(other).cancelUpgrade()).to.be.revertedWithCustomError(idrp, "NotUpgrader");
    });
  });

  describe("the migration initializer cannot be used as a shortcut", function () {
    it("initializeV3 refuses a proxy whose admin is already set (every fresh deploy)", async function () {
      const { idrp, admin, other } = await loadFixture(fixture);
      // Fresh proxy: initialize() ran (version 1), admin == upgrader == admin.
      await expect(
        idrp.connect(admin).initializeV3(other.address, other.address, other.address)
      ).to.be.revertedWith("Admin already set");
      expect(await idrp.admin()).to.equal(admin.address);
      expect(await idrp.controller()).to.equal(ZERO);
    });
  });

  describe("the instant setters are gone", function () {
    for (const sig of ["setAdmin(address)", "setUpgrader(address)"]) {
      it(`${sig} no longer exists`, async function () {
        const { idrp, admin, target } = await loadFixture(fixture);
        expect(idrp.interface.getFunction(sig.split("(")[0])).to.equal(null);

        const data = new hre.ethers.Interface([`function ${sig}`]).encodeFunctionData(
          sig.split("(")[0],
          [target.address]
        );
        await expect(admin.sendTransaction({ to: await idrp.getAddress(), data })).to.be.reverted;
        expect(await idrp.admin()).to.equal(admin.address);
        expect(await idrp.upgrader()).to.equal(admin.address);
      });
    }
  });

  describe("storage", function () {
    it("leftover data in the sequential slot after `controller` is not read as a pending handover", async function () {
      const { idrp, admin, target } = await loadFixture(fixture);
      const after = (await slotOf("controller")) + 1n;
      const junk = "0x" + "00".repeat(6) + "0000000000ff" + "11".repeat(20);
      await hre.network.provider.send("hardhat_setStorageAt", [
        await idrp.getAddress(),
        hre.ethers.toQuantity(after),
        junk,
      ]);

      expect(await pendingOf(idrp, ROLES[0])).to.deep.equal([ZERO, 0n]);
      expect(await pendingOf(idrp, ROLES[1])).to.deep.equal([ZERO, 0n]);

      const { schedule } = await beginAndSchedule(idrp, ROLES[0], admin, target.address);
      await time.increaseTo(schedule + 1n);
      await idrp.connect(target).acceptAdminTransfer();
      expect(await idrp.admin()).to.equal(target.address);
    });
  });
});
