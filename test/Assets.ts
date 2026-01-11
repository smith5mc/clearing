import { expect } from "chai";
import { network } from "hardhat";

// Adapting the import style from Tokens.ts
const { ethers } = await network.connect();

describe("Asset Contracts", function () {
  let owner: any;
  let otherAccount: any;
  
  // Contracts
  let bond: any;
  let deed: any;
  let stock: any;

  before(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    otherAccount = signers[1];
  });

  describe("Bond Contract", function () {
    beforeEach(async function () {
      bond = await ethers.deployContract("Bond");
    });

    it("Should have correct name and symbol", async function () {
      expect(await bond.name()).to.equal("Corporate Bond");
      expect(await bond.symbol()).to.equal("BOND");
    });

    it("Should mint a bond with terms", async function () {
      const faceValue = 1000;
      const rate = 500; // 5%
      const maturity = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 year from now

      await bond.mint(owner.address, faceValue, rate, maturity);
      
      const tokenId = 0;
      expect(await bond.ownerOf(tokenId)).to.equal(owner.address);
      
      const terms = await bond.getBondTerms(tokenId);
      expect(terms.faceValue).to.equal(faceValue);
      expect(terms.interestRateBps).to.equal(rate);
      expect(terms.maturityDate).to.equal(maturity);
    });

    it("Should only allow owner to mint", async function () {
      const faceValue = 1000;
      const rate = 500;
      const maturity = 1234567890;

      await expect(
        bond.connect(otherAccount).mint(otherAccount.address, faceValue, rate, maturity)
      ).to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
    });
  });

  describe("DigitalDeed Contract", function () {
    beforeEach(async function () {
      deed = await ethers.deployContract("DigitalDeed");
    });

    it("Should have correct name and symbol", async function () {
      expect(await deed.name()).to.equal("Real Estate Deed");
      expect(await deed.symbol()).to.equal("DEED");
    });

    it("Should mint a deed with property details", async function () {
      const propertyDetails = "123 Blockchain Ave, Crypto City";
      
      await deed.mint(owner.address, propertyDetails);
      
      const tokenId = 0;
      expect(await deed.ownerOf(tokenId)).to.equal(owner.address);
      expect(await deed.getPropertyDetails(tokenId)).to.equal(propertyDetails);
    });
  });

  describe("Stock Contract", function () {
    beforeEach(async function () {
      stock = await ethers.deployContract("Stock");
    });

    it("Should have correct name and symbol", async function () {
      expect(await stock.name()).to.equal("Company Stock");
      expect(await stock.symbol()).to.equal("STK");
    });

    it("Should mint a stock certificate", async function () {
      const shareClass = "Common";
      const shareCount = 100;

      await stock.mint(owner.address, shareClass, shareCount);
      
      const tokenId = 0;
      expect(await stock.ownerOf(tokenId)).to.equal(owner.address);
      
      const cert = await stock.getCertificateDetails(tokenId);
      expect(cert.shareClass).to.equal(shareClass);
      expect(cert.numberOfShares).to.equal(shareCount);
    });
  });
});

