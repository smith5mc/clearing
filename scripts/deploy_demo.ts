import fs from "fs";
import path from "path";
import { network } from "hardhat";
import { fileURLToPath } from 'url';

async function main() {
  // Parse --network argument from command line
  const networkArg = process.argv.find(arg => arg.startsWith('--network'));
  const networkIdx = process.argv.indexOf('--network');
  const networkName = networkArg?.includes('=') 
    ? networkArg.split('=')[1] 
    : (networkIdx !== -1 ? process.argv[networkIdx + 1] : undefined);
  
  const { ethers } = await network.connect(networkName);
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

  const TokenC = await ethers.getContractFactory("TokenC");
  const tokenC = await TokenC.deploy();
  await tokenC.waitForDeployment();
  console.log("TokenC deployed to:", tokenC.target);

  const TokenD = await ethers.getContractFactory("TokenD");
  const tokenD = await TokenD.deploy();
  await tokenD.waitForDeployment();
  console.log("TokenD deployed to:", tokenD.target);

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

  // 4. Define User Configurations
  const userConfigs = [
    { tokens: [tokenA.target, tokenB.target], preferred: tokenA.target },      // User 1: prefers TokenA
    { tokens: [tokenB.target, tokenC.target], preferred: tokenB.target },      // User 2: prefers TokenB
    { tokens: [tokenC.target, tokenD.target], preferred: tokenC.target },      // User 3: prefers TokenC
    { tokens: [tokenD.target, tokenA.target], preferred: tokenD.target },      // User 4: prefers TokenD
    { tokens: [tokenA.target, tokenB.target, tokenC.target], preferred: tokenA.target }, // User 5: prefers TokenA
    { tokens: [tokenB.target, tokenC.target, tokenD.target], preferred: tokenB.target }, // User 6: prefers TokenB
    { tokens: [tokenC.target, tokenD.target, tokenA.target], preferred: tokenC.target }, // User 7: prefers TokenC
    { tokens: [tokenD.target, tokenA.target, tokenB.target], preferred: tokenD.target }, // User 8: prefers TokenD
    { tokens: [tokenA.target, tokenC.target], preferred: tokenA.target },      // User 9: prefers TokenA
    { tokens: [tokenB.target, tokenD.target], preferred: tokenB.target },      // User 10: prefers TokenB
  ];

  // 5. Distribute Tokens to test accounts (Hardhat accounts 1-10)
  const signers = await ethers.getSigners();
  const allTokens = [tokenA, tokenB, tokenC, tokenD];

  // Transfer to accounts 1-10 (Account 0 is deployer)
  for (let i = 1; i <= 10; i++) {
      if (signers[i]) {
          const amount = ethers.parseUnits("100000", 18);

          // Fund with all stablecoins
          for (const token of allTokens) {
              await token.transfer(signers[i].address, amount);
          }

          // Pre-approve ClearingHouse for all tokens
          for (const token of allTokens) {
              await token.connect(signers[i]).approve(clearingHouse.target, ethers.MaxUint256);
          }
          await bond.connect(signers[i]).setApprovalForAll(clearingHouse.target, true);
          await stock.connect(signers[i]).setApprovalForAll(clearingHouse.target, true);

          console.log(`Funded & Approved User ${i}: ${signers[i].address}`);
      }
  }

  // 6. Configure User Preferences for ClearingHouse
  console.log("\nConfiguring user preferences...");

  for (let i = 1; i <= 10; i++) {
      if (signers[i] && userConfigs[i-1]) {
          const config = userConfigs[i-1];
          await clearingHouse.connect(signers[i]).configureAcceptedStablecoins(
              config.tokens,
              config.preferred
          );
          console.log(`Configured User ${i}: accepts [${config.tokens.map(t => t.slice(-4))}], prefers ${config.preferred.slice(-4)}`);
      }
  }

  // 7. Generate Config for Frontend
  const config = {
    addresses: {
      TokenA: tokenA.target,
      TokenB: tokenB.target,
      TokenC: tokenC.target,
      TokenD: tokenD.target,
      Bond: bond.target,
      Stock: stock.target,
      ClearingHouse: clearingHouse.target,
    },
    abis: {
      TokenA: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/Tokens.sol/TokenA.json")).toString()).abi,
      TokenB: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/Tokens.sol/TokenB.json")).toString()).abi,
      TokenC: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/Tokens.sol/TokenC.json")).toString()).abi,
      TokenD: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/Tokens.sol/TokenD.json")).toString()).abi,
      Bond: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/Bond.sol/Bond.json")).toString()).abi,
      Stock: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/Stock.sol/Stock.json")).toString()).abi,
      ClearingHouse: JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/contracts/ClearingHouse.sol/ClearingHouse.json")).toString()).abi,
    },
    users: signers.slice(1, 11).map(s => s.address), // Export user addresses for UI to know who they are
    userConfigs: userConfigs // Export user configurations for reference
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

