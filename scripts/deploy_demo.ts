import fs from "fs";
import path from "path";
import { network } from "hardhat";
import { fileURLToPath } from 'url';

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // 1. Deploy Tokens
  const TokenA = await ethers.getContractFactory("TokenA");
  const tokenA = await TokenA.deploy();
  await tokenA.waitForDeployment();
  console.log("TokenA deployed to:", tokenA.target);

  const TokenB = await ethers.getContractFactory("TokenB");
  const tokenB = await TokenB.deploy();
  await tokenB.waitForDeployment();
  console.log("TokenB deployed to:", tokenB.target);

  // 2. Deploy Assets
  const Bond = await ethers.getContractFactory("Bond");
  const bond = await Bond.deploy();
  await bond.waitForDeployment();
  console.log("Bond deployed to:", bond.target);

  const Stock = await ethers.getContractFactory("Stock");
  const stock = await Stock.deploy();
  await stock.waitForDeployment();
  console.log("Stock deployed to:", stock.target);

  // 3. Deploy ClearingHouse
  const ClearingHouse = await ethers.getContractFactory("ClearingHouse");
  const clearingHouse = await ClearingHouse.deploy();
  await clearingHouse.waitForDeployment();
  console.log("ClearingHouse deployed to:", clearingHouse.target);

  // 4. Distribute Tokens to test accounts (Hardhat accounts 1-10)
  const signers = await ethers.getSigners();
  // Transfer to accounts 1-10 (Account 0 is deployer)
  for (let i = 1; i <= 10; i++) {
      if (signers[i]) {
          const amount = ethers.parseUnits("100000", 18);
          await tokenA.transfer(signers[i].address, amount);
          await tokenB.transfer(signers[i].address, amount);
          
          // Pre-approve ClearingHouse
          await tokenA.connect(signers[i]).approve(clearingHouse.target, ethers.MaxUint256);
          await tokenB.connect(signers[i]).approve(clearingHouse.target, ethers.MaxUint256);
          await bond.connect(signers[i]).setApprovalForAll(clearingHouse.target, true);
          await stock.connect(signers[i]).setApprovalForAll(clearingHouse.target, true);
          
          console.log(`Funded & Approved User ${i}: ${signers[i].address}`);
      }
  }

  // 5. Generate Config for Frontend
  const config = {
    addresses: {
      TokenA: tokenA.target,
      TokenB: tokenB.target,
      Bond: bond.target,
      Stock: stock.target,
      ClearingHouse: clearingHouse.target,
    },
    abis: {
      TokenA: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/Tokens.sol/TokenA.json")).toString()).abi,
      Bond: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/Bond.sol/Bond.json")).toString()).abi,
      Stock: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/Stock.sol/Stock.json")).toString()).abi,
      ClearingHouse: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/ClearingHouse.sol/ClearingHouse.json")).toString()).abi,
    },
    users: signers.slice(1, 11).map(s => s.address) // Export user addresses for UI to know who they are
  };

  const demoSrcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../demo/src");
  if (!fs.existsSync(demoSrcDir)) {
    fs.mkdirSync(demoSrcDir, { recursive: true });
  }
  
  fs.writeFileSync(
    path.join(demoSrcDir, "config.json"),
    JSON.stringify(config, null, 2)
  );
  console.log("Frontend config written to demo/src/config.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

