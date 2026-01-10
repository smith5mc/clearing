import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

describe("Tokens", function () {
  let owner: any;
  let otherAccount: any;
  let tokenA: any, tokenB: any, tokenC: any, tokenD: any, tokenE: any;

  before(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    otherAccount = signers[1];
  });

  beforeEach(async function () {
    tokenA = await ethers.deployContract("TokenA");
    tokenB = await ethers.deployContract("TokenB");
    tokenC = await ethers.deployContract("TokenC");
    tokenD = await ethers.deployContract("TokenD");
    tokenE = await ethers.deployContract("TokenE");
  });

  it("Should have correct names and symbols", async function () {
    expect(await tokenA.name()).to.equal("Token A");
    expect(await tokenA.symbol()).to.equal("TKA");
    
    expect(await tokenB.name()).to.equal("Token B");
    expect(await tokenB.symbol()).to.equal("TKB");

    expect(await tokenC.name()).to.equal("Token C");
    expect(await tokenC.symbol()).to.equal("TKC");

    expect(await tokenD.name()).to.equal("Token D");
    expect(await tokenD.symbol()).to.equal("TKD");

    expect(await tokenE.name()).to.equal("Token E");
    expect(await tokenE.symbol()).to.equal("TKE");
  });

  it("Should mint initial supply to deployer", async function () {
    const expectedSupply = ethers.parseUnits("1000000", 18);

    expect(await tokenA.totalSupply()).to.equal(expectedSupply);
    expect(await tokenA.balanceOf(owner.address)).to.equal(expectedSupply);

    expect(await tokenB.totalSupply()).to.equal(expectedSupply);
    expect(await tokenB.balanceOf(owner.address)).to.equal(expectedSupply);
    
    // Check others as well
    expect(await tokenE.balanceOf(owner.address)).to.equal(expectedSupply);
  });

  it("Should allow transfers", async function () {
    const amount = ethers.parseUnits("100", 18);
    
    await tokenA.transfer(otherAccount.address, amount);
    expect(await tokenA.balanceOf(otherAccount.address)).to.equal(amount);
    expect(await tokenA.balanceOf(owner.address)).to.equal(ethers.parseUnits("999900", 18));

    await tokenB.transfer(otherAccount.address, amount);
    expect(await tokenB.balanceOf(otherAccount.address)).to.equal(amount);
  });
});

