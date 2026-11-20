// Local-only fork. The upstream bridge accepts read methods only.
module.exports = {
  solidity: '0.8.28',
  networks: {
    hardhat: {
      chainId: 91342,
      hardfork: 'cancun',
      chains: {
        91342: { hardforkHistory: { cancun: 0 } },
      },
      forking: {
        url: 'http://127.0.0.1:8546',
        blockNumber: 41715770,
      },
    },
  },
};
