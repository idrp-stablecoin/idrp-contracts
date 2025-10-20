const ethers = require("ethers");

const [
  officerAddress,
  managerAddress,
  directorAddress,
  commissionerAddress,
  adminAddress,
] = [
  "TA1hNKC3spEaEtuXnrmHRavbhL4fdwvcgH",
  "TANHwMN1gR1fTnQrALL8m4nnGTWn1Vh4nE",
  "TEnKUYsAGHZ776Z6aFBGhDP8Y9gAvD5xKk",
  "TDxunLmR6JgknrMVH3yLfWckgUeCcMqgXL",
  "TBm7Ay2ArsVA9SSPpSrmimXytrpSVLaovB",
];

const MaxUint256 = ethers.MaxUint256;

// const ONE_HUNDRED_MILLION = 100_000_000 * 10 ** 6; // 6 decimals
// const FIVE_HUNDRED_MILLION = 500_000_000 * 10 ** 6; // 6 decimals
// const ONE_BILLION = 1_000_000_000 * 10 ** 6; // 6 decimals
// const TEN_BILLION = 10_000_000_000 * 10 ** 6; // 6 decimals
const ONE_HUNDRED_MILLION = ethers.parseUnits("100000000", 6);
const FIVE_HUNDRED_MILLION = ethers.parseUnits("500000000", 6);
const ONE_BILLION = ethers.parseUnits("1000000000", 6);
const TEN_BILLION = ethers.parseUnits("10000000000", 6);
const OPERATION = {
  MINT: 0,
  BURN: 1,
  FREEZE: 2,
  UNFREEZE: 3,
  PAUSE: 4,
  UNPAUSE: 5,
};

module.exports = {
  officerAddress,
  managerAddress,
  directorAddress,
  commissionerAddress,
  adminAddress,

  ONE_HUNDRED_MILLION,
  FIVE_HUNDRED_MILLION,
  ONE_BILLION,
  TEN_BILLION,
  OPERATION,
  MaxUint256,
};
