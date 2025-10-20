const { deployProxy } = require('@openzeppelin/truffle-upgrades');

const IDRP = artifacts.require('IDRP');

// Simple helper for expecting revert on TRON
async function expectRevert(promise, message) {
  try {
    await promise;
    throw new Error('Expected revert, but succeeded');
  } catch (err) {
    if (message && !String(err.message || err).includes(message)) {
      throw new Error(`Expected revert with "${message}", got: ${err.message || err}`);
    }
  }
}

contract('IDRP (TRON)', function (accounts) {
  const [admin, depository, user, stranger] = accounts;
  console.log('Accounts:', { admin, depository, user, stranger });

  let idrp;

  beforeEach(async function () {
    const instance = await deployProxy(IDRP, [], { deployer: admin, initializer: 'initialize', });
    idrp = await instance.deployed();
    await idrp.initialize(admin);
    // set depository wallet before any mint
    await idrp.setDepositoryWallet(depository, { from: admin });
    console.log('Deployed IDRP at', idrp.address, {dep: await idrp.depositoryWallet()});
    const DEFAULT_ADMIN_ROLE = await idrp.DEFAULT_ADMIN_ROLE();
   
    console.log("aaa", await idrp.hasRole(DEFAULT_ADMIN_ROLE, admin))
  });

  
  it('initializes with correct metadata and roles', async function () {
    const name = await idrp.name;
    const symbol = await idrp.symbol();
    const decimals = await idrp.decimals();
    console.log('Token metadata:', { name, symbol, decimals });

    assert.equal(name, 'IDRP');
    assert.equal(symbol, 'IDRP');
    assert.equal(Number(decimals), 6);

    const DEFAULT_ADMIN_ROLE = await idrp.DEFAULT_ADMIN_ROLE();
    const MINTER_ROLE = await idrp.MINTER_ROLE();
    const PAUSER_ROLE = await idrp.PAUSER_ROLE();
    const FREEZER_ROLE = await idrp.FREEZER_ROLE();

    assert.isTrue(await idrp.hasRole(DEFAULT_ADMIN_ROLE, admin));
    assert.isTrue(await idrp.hasRole(MINTER_ROLE, admin));
    assert.isTrue(await idrp.hasRole(PAUSER_ROLE, admin));
    assert.isTrue(await idrp.hasRole(FREEZER_ROLE, admin));
  });

  it('pauses and unpauses by PAUSER_ROLE only', async function () {
    await idrp.pause({ from: admin });
    assert.equal(await idrp.paused(), true);

    await expectRevert(idrp.pause({ from: stranger })); // cannot pause again and not a pauser
    await expectRevert(idrp.unpause({ from: stranger })); // not a pauser

    await idrp.unpause({ from: admin });
    assert.equal(await idrp.paused(), false);
  });

  it('freezes and unfreezes by FREEZER_ROLE only', async function () {
    await idrp.freeze(user, { from: admin });
    assert.equal(await idrp.frozen(user), true);

    await expectRevert(idrp.unfreeze(user, { from: stranger }));
    await idrp.unfreeze(user, { from: admin });
    assert.equal(await idrp.frozen(user), false);
  });

  it('mints to depository wallet, requires MINTER_ROLE and not paused', async function () {
    const amount = '1000000'; // 1 IDRP (6 decimals)

    // not minter
    await expectRevert(idrp.mint(amount, { from: stranger }));

    // success
    await idrp.mint(amount, { from: admin });
    const bal = await idrp.balanceOf(depository);
    assert.equal(bal.toString(), amount);

    // paused
    await idrp.pause({ from: admin });
    await expectRevert(idrp.mint(amount, { from: admin }));
  });

  it('cannot mint when depository is frozen', async function () {
    const amount = '1000000';
    await idrp.freeze(depository, { from: admin });
    await expectRevert(idrp.mint(amount, { from: admin }));
  });

  it('burns from depository without allowance; from others requires allowance', async function () {
    const amount = '2000000'; // 2 IDRP
    const half = '1000000';   // 1 IDRP

    // Mint to depository
    await idrp.mint(amount, { from: admin });
    assert.equal((await idrp.balanceOf(depository)).toString(), amount);

    // Burn from depository (no allowance needed)
    await idrp.burn(depository, half, { from: admin });
    assert.equal((await idrp.balanceOf(depository)).toString(), half);

    // Transfer half from depository to user
    await idrp.transfer(user, half, { from: depository });
    assert.equal((await idrp.balanceOf(user)).toString(), half);
    assert.equal((await idrp.balanceOf(depository)).toString(), '0');

    // Try burn from user without allowance -> revert
    await expectRevert(idrp.burn(user, half, { from: admin }));

    // Approve admin then burn
    await idrp.approve(admin, half, { from: user });
    await idrp.burn(user, half, { from: admin });
    assert.equal((await idrp.balanceOf(user)).toString(), '0');
  });

  it('cannot burn when paused or when account is frozen', async function () {
    const amount = '1000000';
    await idrp.mint(amount, { from: admin });

    await idrp.pause({ from: admin });
    await expectRevert(idrp.burn(depository, amount, { from: admin }));
    await idrp.unpause({ from: admin });

    await idrp.freeze(depository, { from: admin });
    await expectRevert(idrp.burn(depository, amount, { from: admin }));
  });

  it('transfer respects pause and frozen checks', async function () {
    const amount = '1000000';
    await idrp.mint(amount, { from: admin });

    // transfer depository -> user
    await idrp.transfer(user, amount, { from: depository });
    assert.equal((await idrp.balanceOf(user)).toString(), amount);

    // pause prevents transfer
    await idrp.pause({ from: admin });
    await expectRevert(idrp.transfer(depository, amount, { from: user }));
    await idrp.unpause({ from: admin });

    // freeze sender
    await idrp.freeze(user, { from: admin });
    await expectRevert(idrp.transfer(depository, amount, { from: user }));
    await idrp.unfreeze(user, { from: admin });

    // freeze recipient
    await idrp.freeze(depository, { from: admin });
    await expectRevert(idrp.transfer(depository, amount, { from: user }));
  });
});