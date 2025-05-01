```
spidey@MBP-Spidey idrp-contracts % npx hardhat run ./scripts/check-contract-state.ts --network polygon
Deployer: 0x24416E80bdaFEe83dFffcc13A4fd0726A176823B

IDRP token address: 0xADb603C1D0a1b3943C9df35a50099f22fEaCaA58

--- IDRP Token State ---
Paused: false
Depository wallet: 0x5A84cE5dd91e965b08E16809A966c83d46AB50D3

IDRPController address: 0x877538747fe8acb657C1a54A759A8e4B9cC987Bc

--- Controller State ---
Current nonce: 0n
IDRP token: 0xADb603C1D0a1b3943C9df35a50099f22fEaCaA58

--- IDRP Token Permissions ---
PAUSER_ROLE: 0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a
MINTER_ROLE: 0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6
FREEZER_ROLE: 0x92de27771f92d6942691d73358b3a4673e4880de8356f8f2cf452be87e02d363
Controller has PAUSER_ROLE: true
Controller has MINTER_ROLE: true
Controller has FREEZER_ROLE: true
Controller has PAUSER_ROLE: true
Deployer has PAUSER_ROLE: true

--- Controller Role Assignments ---

Checking roles for deployer (0x24416E80bdaFEe83dFffcc13A4fd0726A176823B):
- DEFAULT_ADMIN_ROLE: true
- ADMIN_ROLE: true
- OFFICER_ROLE: false
- MANAGER_ROLE: false
- DIRECTOR_ROLE: false
- COMMISSIONER_ROLE: false

Checking roles for officer (0x99A0AD5DF1651D8812B0b4Ca5102ad060C4DC2d3):
- DEFAULT_ADMIN_ROLE: false
- ADMIN_ROLE: false
- OFFICER_ROLE: false
- MANAGER_ROLE: false
- DIRECTOR_ROLE: false
- COMMISSIONER_ROLE: false

Checking roles for manager (0xf712A68ff897cdcdD7a0b68c1DE6886F1F8eD761):
- DEFAULT_ADMIN_ROLE: false
- ADMIN_ROLE: false
- OFFICER_ROLE: false
- MANAGER_ROLE: false
- DIRECTOR_ROLE: false
- COMMISSIONER_ROLE: false

Checking roles for director (0x5B2A48685a89458ECbaB3AEC56923e128f441995):
- DEFAULT_ADMIN_ROLE: false
- ADMIN_ROLE: false
- OFFICER_ROLE: false
- MANAGER_ROLE: false
- DIRECTOR_ROLE: false
- COMMISSIONER_ROLE: false

Checking roles for commissioner (0xb9E8412a3b35A5A75b76E679d8791EF2C75984Ed):
- DEFAULT_ADMIN_ROLE: false
- ADMIN_ROLE: false
- OFFICER_ROLE: false
- MANAGER_ROLE: false
- DIRECTOR_ROLE: false
- COMMISSIONER_ROLE: false

--- Pause Quorum Rule ---
Pause min amount: 0
Pause max amount: 115792089237316195423570985008687907853269984665640564039457584007913129639935
Pause required roles: Result(2) [
  '0x241ecf16d79d0f8dbfb92cbc07fe17840425976cf0667f022fe9877caa831b08',
  '0x15e007796fc034bf8274acdcfbd2f48124815698ba6f70c109f3423981a7052f'
]
spidey@MBP-Spidey idrp-contracts %
```
