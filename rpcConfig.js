// rpcConfig.js — Polygon RPC configuration

// Polygon Mainnet Chain ID
export const POLYGON_CHAIN_ID = 137; // Mainnet Polygon Chain ID

// Primary signer (WRITE RPC)
export const WRITE_RPC_URL =
  "https://polygon-mainnet.infura.io/v3/97f1f37afc6d4f4bb416388dee0f8b46";

// Ordered fallback RPCs (read-only + redundancy)
export const POLYGON_RPCS = [
  "https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd",
  "https://polygon-mainnet.infura.io/v3/18f4f2e1325b4831aa19e725550061f6",
  "https://polygon-mainnet.core.chainstack.com/c563a3c2726932e669d1cb5f72dfa75a",
  "https://polygon-mainnet.core.chainstack.com/e0149669ba321c1de3cd1d322d1e184d",
  "https://polygon-mainnet.infura.io/v3/62f1d3e20462487898ff7733ecdda2f4",
  "https://polygon-mainnet.core.chainstack.com/c985c973d8bb05b487cdaa92c949a595",
  "https://go.getblock.us/9135673866b74ec7aa1ea2842bacb1b7",
  "https://polygon-rpc.com",
  "https://1rpc.io/matic",
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon-heimdall-rpc.publicnode.com:443",
  "https://polygon.rpc.services.stakecraft.com",
  "https://subquery.network/rpc/list/137",
  "https://rpc.ankr.com/polygon",
  "https://polygon-mainnet.public.blastapi.io"
];
