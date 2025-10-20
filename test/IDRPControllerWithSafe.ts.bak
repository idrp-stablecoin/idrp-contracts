import hre from "hardhat"
import { expect } from "chai"
import { ZeroAddress } from "ethers"
import { IDRPController, IDRP, Safe } from "../typechain-types"
import { execTransaction } from "./utils/utils"

describe("IDRPController with Safe", function () {
  // Define constants for test
  const OFFICER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("OFFICER_ROLE"))
  const MANAGER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANAGER_ROLE"))
  const DIRECTOR_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("DIRECTOR_ROLE"))
  const COMMISSIONER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("COMMISSIONER_ROLE"))
  const ADMIN_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("ADMIN_ROLE"))
  const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000"

  // For amount thresholds, in IDRP 6 decimals
  const ONE_HUNDRED_MILLION = hre.ethers.parseUnits("100000000", 6)
  const FIVE_HUNDRED_MILLION = hre.ethers.parseUnits("500000000", 6)
  const ONE_BILLION = hre.ethers.parseUnits("1000000000", 6)
  const TEN_BILLION = hre.ethers.parseUnits("10000000000", 6)

  let idrp: IDRP
  let controller: IDRPController
  let safe: Safe
  let deployer: any
  let owner1: any
  let owner2: any
  let owner3: any
  let owner4: any
  let owner5: any
  let officer: any
  let manager: any
  let director: any
  let commissioner: any
  let user: any

  // Set up our EIP-712 domain
  const domain = {
    name: "IDRPController",
    version: "1",
    chainId: 31337, // hardhat's chainId
    verifyingContract: "", // Will be set after deployment
  }

  // The type definition for our operation
  const types = {
    Operation: [
      { name: "to", type: "address" },
      { name: "operationType", type: "uint8" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  }

  enum OperationType {
    Mint,
    Burn,
    Freeze,
    Unfreeze,
  }

  beforeEach(async function () {
    // Deploy the contracts
    ;[deployer, owner1, owner2, owner3, owner4, owner5, officer, manager, director, commissioner, user] =
      await hre.ethers.getSigners()

    // 1. Create a Safe with 5 owners (5/5 threshold)
    // Deploy Safe master copy
    const safeFactory = await hre.ethers.getContractFactory("Safe", deployer)
    const masterCopy = await safeFactory.deploy()

    // Deploy a new SafeProxyFactory contract
    const proxyFactory = await (await hre.ethers.getContractFactory("SafeProxyFactory", deployer)).deploy()

    // Setup the Safe with 5 owners and 5/5 threshold
    const owners = [
      await owner1.getAddress(),
      await owner2.getAddress(),
      await owner3.getAddress(),
      await owner4.getAddress(),
      await owner5.getAddress(),
    ]

    // Generate setup transaction data
    const safeData = masterCopy.interface.encodeFunctionData("setup", [
      owners,
      5, // 5/5 threshold
      ZeroAddress,
      "0x",
      ZeroAddress,
      ZeroAddress,
      0,
      ZeroAddress,
    ])

    // Create the Safe proxy
    const safeAddress = await proxyFactory.createProxyWithNonce.staticCall(await masterCopy.getAddress(), safeData, 0n)

    if (safeAddress === ZeroAddress) {
      throw new Error("Safe address not found")
    }

    // Deploy the Safe proxy
    await proxyFactory.createProxyWithNonce(await masterCopy.getAddress(), safeData, 0n)

    // Connect to the deployed Safe
    safe = await hre.ethers.getContractAt("Safe", safeAddress)

    // 2. Deploy IDRP token
    const IDRPFactory = await hre.ethers.getContractFactory("IDRP")
    idrp = await hre.upgrades.deployProxy(IDRPFactory, [deployer.address])
    await idrp.waitForDeployment()

    // 3. Deploy the IDRPController with Safe as the owner and admin
    const IDRPControllerFactory = await hre.ethers.getContractFactory("IDRPController")
    controller = await IDRPControllerFactory.deploy(await idrp.getAddress(), safeAddress)

    // Update the domain with the controller's address
    domain.verifyingContract = await controller.getAddress()

    // 4. Set up IDRP roles for the controller
    await idrp.grantRole(await idrp.MINTER_ROLE(), await controller.getAddress())
    await idrp.grantRole(await idrp.FREEZER_ROLE(), await controller.getAddress())
  })

  describe("Safe Owner Setup", function () {
    it("Should set up the Safe with 5/5 threshold", async function () {
      // Check that the Safe has 5 owners
      expect(await safe.getThreshold()).to.equal(5)

      // Check each owner
      for (let i = 1; i <= 5; i++) {
        const owner = eval(`owner${i}`)
        expect(await safe.isOwner(await owner.getAddress())).to.be.true
      }
    })

    it("Should set the Safe as owner of the IDRPController", async function () {
      expect(await controller.owner()).to.equal(await safe.getAddress())
    })

    it("Should set the Safe with admin roles in the IDRPController", async function () {
      expect(await controller.hasRole(DEFAULT_ADMIN_ROLE, await safe.getAddress())).to.be.true
      expect(await controller.hasRole(ADMIN_ROLE, await safe.getAddress())).to.be.true
    })
  })

  describe("Role Management via Safe", function () {
    it("Should grant roles via Safe transaction", async function () {
      // Prepare the transaction data to grant OFFICER_ROLE to an address
      const grantRoleData = controller.interface.encodeFunctionData("grantRole", [
        OFFICER_ROLE,
        await officer.getAddress(),
      ])

      // Execute the transaction through the Safe (requires all 5 owners to sign)
      await execTransaction(
        [owner1, owner2, owner3, owner4, owner5],
        safe,
        await controller.getAddress(),
        0,
        grantRoleData,
        0 // Call operation (not delegatecall)
      )

      // Verify the role was granted
      expect(await controller.hasRole(OFFICER_ROLE, await officer.getAddress())).to.be.true
    })

    it("Should fail to grant role if not 5/5", async function () {
      const grantRoleData = controller.interface.encodeFunctionData("grantRole", [
        OFFICER_ROLE,
        await officer.getAddress(),
      ])

      let failedAsExpected = false
      try {
        await execTransaction(
          [owner1, owner2, owner3, owner4],
          safe,
          await controller.getAddress(),
          0,
          grantRoleData,
          0
        )
      } catch (error) {
        failedAsExpected = true
      }
      expect(failedAsExpected).to.be.true
    })

    it("Should grant a role to each signer via Safe transactions", async function () {
      // Grant roles to all the role-based signers
      const roles = [
        { role: OFFICER_ROLE, signer: officer },
        { role: MANAGER_ROLE, signer: manager },
        { role: DIRECTOR_ROLE, signer: director },
        { role: COMMISSIONER_ROLE, signer: commissioner },
      ]

      // Grant each role
      for (const { role, signer } of roles) {
        const grantRoleData = controller.interface.encodeFunctionData("grantRole", [role, await signer.getAddress()])

        await execTransaction(
          [owner1, owner2, owner3, owner4, owner5],
          safe,
          await controller.getAddress(),
          0,
          grantRoleData,
          0
        )

        // Verify the role was granted
        expect(await controller.hasRole(role, await signer.getAddress())).to.be.true
      }
    })

    it("Should revoke roles via Safe transaction", async function () {
      // First grant a role
      const grantRoleData = controller.interface.encodeFunctionData("grantRole", [
        OFFICER_ROLE,
        await officer.getAddress(),
      ])

      await execTransaction(
        [owner1, owner2, owner3, owner4, owner5],
        safe,
        await controller.getAddress(),
        0,
        grantRoleData,
        0
      )

      // Now revoke the role
      const revokeRoleData = controller.interface.encodeFunctionData("revokeRole", [
        OFFICER_ROLE,
        await officer.getAddress(),
      ])

      await execTransaction(
        [owner1, owner2, owner3, owner4, owner5],
        safe,
        await controller.getAddress(),
        0,
        revokeRoleData,
        0
      )

      // Verify the role was revoked
      expect(await controller.hasRole(OFFICER_ROLE, await officer.getAddress())).to.be.false
    })
  })

  describe("Quorum Rule Management via Safe", function () {
    it("Should set quorum rules via Safe transaction", async function () {
      // Prepare the quorum rules for mint
      const mintRules = [
        {
          minAmount: 0,
          maxAmount: ONE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE],
        },
        {
          minAmount: ONE_HUNDRED_MILLION,
          maxAmount: FIVE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
        },
      ]

      // Encode the transaction data
      const setQuorumRulesData = controller.interface.encodeFunctionData("setQuorumRules", [
        OperationType.Mint,
        mintRules,
      ])

      // Execute the transaction through the Safe
      await execTransaction(
        [owner1, owner2, owner3, owner4, owner5],
        safe,
        await controller.getAddress(),
        0,
        setQuorumRulesData,
        0
      )

      // Verify the quorum rules were set correctly
      const rule = await controller.getQuorumRule(OperationType.Mint, 0)
      expect(rule.minAmount).to.equal(0)
      expect(rule.maxAmount).to.equal(ONE_HUNDRED_MILLION)
      expect(rule.requiredRoles.length).to.equal(1)
      expect(rule.requiredRoles[0]).to.equal(OFFICER_ROLE)
    })
  })

  describe("Token Operations with Safe and IDRPController", function () {
    beforeEach(async function () {
      // Grant roles to role-based signers
      const roles = [
        { role: OFFICER_ROLE, signer: officer },
        { role: MANAGER_ROLE, signer: manager },
        { role: DIRECTOR_ROLE, signer: director },
        { role: COMMISSIONER_ROLE, signer: commissioner },
      ]

      for (const { role, signer } of roles) {
        const grantRoleData = controller.interface.encodeFunctionData("grantRole", [role, await signer.getAddress()])

        await execTransaction(
          [owner1, owner2, owner3, owner4, owner5],
          safe,
          await controller.getAddress(),
          0,
          grantRoleData,
          0
        )
      }

      // Set quorum rules for all operations
      const mintRules = [
        {
          minAmount: 0,
          maxAmount: ONE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE],
        },
        {
          minAmount: ONE_HUNDRED_MILLION,
          maxAmount: FIVE_HUNDRED_MILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE],
        },
        {
          minAmount: FIVE_HUNDRED_MILLION,
          maxAmount: ONE_BILLION,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE],
        },
        {
          minAmount: ONE_BILLION,
          maxAmount: hre.ethers.MaxUint256,
          requiredRoles: [OFFICER_ROLE, MANAGER_ROLE, DIRECTOR_ROLE, COMMISSIONER_ROLE],
        },
      ]

      // Set rules for each operation type
      for (let i = 0; i < 4; i++) {
        const setQuorumRulesData = controller.interface.encodeFunctionData("setQuorumRules", [i, mintRules])

        await execTransaction(
          [owner1, owner2, owner3, owner4, owner5],
          safe,
          await controller.getAddress(),
          0,
          setQuorumRulesData,
          0
        )
      }
    })

    it("Should execute mint operation with proper signatures", async function () {
      const amount = hre.ethers.parseUnits("50000000", 6) // 50M tokens
      const deadline = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now

      // Create operation data
      const operation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: amount,
        nonce: await controller.nonce(),
        deadline: deadline,
      }

      // Only officer needs to sign for small amount
      const officerSignature = await officer.signTypedData(domain, types, operation)

      // Execute operation with officer's signature
      await controller.executeOperation(operation.operationType, operation.to, operation.amount, operation.deadline, [
        officerSignature,
      ])

      // Verify IDRP balance
      expect(await idrp.balanceOf(user.address)).to.equal(amount)
    })

    it("Should execute large mint operation requiring multiple signatures", async function () {
      const amount = hre.ethers.parseUnits("1500000000", 6) // 1.5B tokens
      const deadline = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now

      // Create operation data
      const operation = {
        to: user.address,
        operationType: OperationType.Mint,
        amount: amount,
        nonce: await controller.nonce(),
        deadline: deadline,
      }

      // All roles need to sign for large amount
      const signatures = await Promise.all([
        officer.signTypedData(domain, types, operation),
        manager.signTypedData(domain, types, operation),
        director.signTypedData(domain, types, operation),
        commissioner.signTypedData(domain, types, operation),
      ])

      // Execute operation with all signatures
      await controller.executeOperation(
        operation.operationType,
        operation.to,
        operation.amount,
        operation.deadline,
        signatures
      )

      // Verify IDRP balance
      expect(await idrp.balanceOf(user.address)).to.equal(amount)
    })
  })

  describe("Token Withdrawal via Safe", function () {
    it("Should allow token withdrawal via Safe transaction", async function () {
      // First, deploy a test token and send some to the controller
      const TestTokenFactory = await hre.ethers.getContractFactory("IDRP")
      const testToken = await hre.upgrades.deployProxy(TestTokenFactory, [deployer.address])
      await testToken.waitForDeployment()

      // Mint some tokens to the deployer
      await testToken.mint(deployer.address, hre.ethers.parseUnits("1000", 6))

      // Transfer some tokens to the controller
      const transferAmount = hre.ethers.parseUnits("100", 6)
      await testToken.transfer(await controller.getAddress(), transferAmount)

      // Safe owners withdraw the tokens
      const withdrawData = controller.interface.encodeFunctionData("withdrawToken", [
        await testToken.getAddress(),
        await owner1.getAddress(),
        transferAmount,
      ])

      await execTransaction(
        [owner1, owner2, owner3, owner4, owner5],
        safe,
        await controller.getAddress(),
        0,
        withdrawData,
        0
      )

      // Verify the tokens were withdrawn
      expect(await testToken.balanceOf(await controller.getAddress())).to.equal(0)
      expect(await testToken.balanceOf(await owner1.getAddress())).to.equal(transferAmount)
    })
  })
})
