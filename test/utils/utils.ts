import hre, { ethers } from "hardhat"
import { Signer, AddressLike, BigNumberish, ZeroAddress } from "ethers"
import { Safe } from "../../typechain-types"

/**
 * Deploy a v3 IDRP proxy already wired so the test signer can directly call
 * operational methods (mint/burn/pause/freeze).
 *
 * v3 removed role-based gates on operational methods — they now require
 * msg.sender == controller (single-address). For unit tests we set
 * controller = the operational signer so existing test bodies keep working.
 *
 * Returns the IDRP contract instance. Optionally also sets the depository wallet.
 */
const deployIDRPv3ForTests = async function (
  superAdmin: Signer,
  operationalSigner: Signer,
  depositoryWallet?: AddressLike
) {
  const IDRP = await hre.ethers.getContractFactory("IDRP")
  const idrp = await hre.upgrades.deployProxy(IDRP, [await superAdmin.getAddress()])
  await idrp.waitForDeployment()

  // In v3, `initialize(superAdmin)` sets admin = upgrader = superAdmin
  // and controller = address(0). Wire controller to the operational signer
  // so it can call mint/burn/pause/freeze/etc. directly.
  await idrp
    .connect(superAdmin)
    // @ts-ignore — IDRP exposes setController
    .setController(await operationalSigner.getAddress())

  if (depositoryWallet !== undefined) {
    await idrp
      .connect(superAdmin)
      // @ts-ignore — IDRP exposes setDepositoryWallet
      .setDepositoryWallet(depositoryWallet)
  }

  return idrp
}

/**
 * Executes a transaction on the Safe contract.
 * @param wallets - The signers of the transaction.
 * @param safe - The Safe contract instance.
 * @param to - The address to send the transaction to.
 * @param value - The value to send with the transaction.
 * @param data - The data to send with the transaction.
 * @param operation - The operation type (0 for call, 1 for delegate call).
 */
const execTransaction = async function (
  wallets: Signer[],
  safe: Safe,
  to: AddressLike,
  value: BigNumberish,
  data: string,
  operation: number
): Promise<void> {
  // Get the current nonce of the Safe contract
  const nonce = await safe.nonce()

  // Get the transaction hash for the Safe transaction
  const transactionHash = await safe.getTransactionHash(
    to,
    value,
    data,
    operation,
    0,
    0,
    0,
    ZeroAddress,
    ZeroAddress,
    nonce
  )

  let signatureBytes = "0x"
  const bytesDataHash = ethers.getBytes(transactionHash)

  // Get the addresses of the signers
  const addresses = await Promise.all(wallets.map((wallet) => wallet.getAddress()))
  // Sort the signers by their addresses
  const sorted = wallets.sort((a, b) => {
    const addressA = addresses[wallets.indexOf(a)]
    const addressB = addresses[wallets.indexOf(b)]
    return addressA.localeCompare(addressB, "en", { sensitivity: "base" })
  })

  // Sign the transaction hash with each signer
  for (let i = 0; i < sorted.length; i++) {
    const flatSig = (await sorted[i].signMessage(bytesDataHash)).replace(/1b$/, "1f").replace(/1c$/, "20")
    signatureBytes += flatSig.slice(2)
  }

  // Execute the transaction on the Safe contract
  await safe.execTransaction(to, value, data, operation, 0, 0, 0, ZeroAddress, ZeroAddress, signatureBytes)
}

/**
 * Deploy v3 IDRP + IDRPController + wire them together for unit tests.
 *
 * Returns:
 *   - idrp        : IDRP proxy, with `controller` wired to the Controller proxy,
 *                   `admin` = `superAdmin`, and `depositoryWallet` set if provided.
 *   - controller  : IDRPController proxy, with ACDAR initialized so `superAdmin`
 *                   is the DEFAULT_ADMIN_ROLE holder.
 *
 * This is the production-shaped wiring. For tests that need direct mint/freeze
 * on IDRP without going through executeOperation, temporarily flip
 * `idrp.setController(<signer>)` and back.
 */
const deployIDRPControllerV3ForTests = async function (
  superAdmin: Signer,
  depositoryWallet?: AddressLike
) {
  const superAdminAddr = await superAdmin.getAddress()

  const IDRPFactory = await hre.ethers.getContractFactory("IDRP")
  const idrp = await hre.upgrades.deployProxy(IDRPFactory, [superAdminAddr])
  await idrp.waitForDeployment()

  const ControllerFactory = await hre.ethers.getContractFactory("IDRPController")
  const controller = await hre.upgrades.deployProxy(ControllerFactory, [
    await idrp.getAddress(),
    superAdminAddr,
  ])
  await controller.waitForDeployment()

  // @ts-ignore — IDRP exposes setController
  await idrp.connect(superAdmin).setController(await controller.getAddress())

  if (depositoryWallet !== undefined) {
    // @ts-ignore — IDRP exposes setDepositoryWallet
    await idrp.connect(superAdmin).setDepositoryWallet(depositoryWallet)
  }

  return { idrp, controller }
}

export {
  execTransaction,
  deployIDRPv3ForTests,
  deployIDRPControllerV3ForTests,
}
