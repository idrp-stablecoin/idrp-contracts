// const TransparentUpgradeableProxy = artifacts.require(
//   "@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json"
// );
// const ERC1967Proxy = artifacts.require(
//   "@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json"
// );
const IDRP = artifacts.require("IDRP");
const IDRPV2 = artifacts.require("IDRPV2");

module.exports = async function (deployer) {
  try {
    // Deploy the new IDRPV2 implementation contract
    await deployer.deploy(IDRPV2);

    // Upgrade proxy contract
    const proxyContract = await IDRP.at(IDRP.address);
    // const proxyContract = await TransparentUpgradeableProxy.at(IDRP.address);
    // console.log("proxyContract", proxyContract);
    // await proxyContract.upgradeToAndCall(
    //   "TYw5cG9gHcKJ9mqBT9g3pdBuWq1pqCGqJa",
    //   "0x"
    // );
    await proxyContract.upgradeTo(IDRPV2.address);
    // await proxyContract.upgradeTo("TYw5cG9gHcKJ9mqBT9g3pdBuWq1pqCGqJa");
    console.info("Upgraded", IDRP.address);
  } catch (error) {
    console.error("UUPS: upgrade box error", error);
  }
};
