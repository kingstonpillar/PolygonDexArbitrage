// dataprovider.js — global shared rotation, simple & safe
import 'dotenv/config';
import { ethers } from 'ethers';
import { POLYGON_RPCS, WRITE_RPC_URL } from './rpcConfig.js';

/* ----------------------------
   Fix for RPC leading-zero hex block arguments
   (normalizes any block/hex-like params before send)
---------------------------- */
function stripHexZeros(s) {
  if (typeof s !== 'string' || !s.startsWith('0x')) return s;
  let hex = s.slice(2).replace(/^0+/, '');
  if (hex.length === 0) hex = '0';
  return '0x' + hex.toLowerCase();
}
function toHexNoLead(n) {
  if (typeof n === 'bigint') return '0x' + n.toString(16);
  if (typeof n === 'number') return '0x' + Math.max(0, n >>> 0).toString(16);
  return n;
}
function normalizeBlockLike(x) {
  if (x == null) return x;
  if (x === 'latest' || x === 'earliest' || x === 'pending' || x === 'safe' || x === 'finalized') return x;
  if (typeof x === 'number' || typeof x === 'bigint') return toHexNoLead(x);
  if (typeof x === 'string' && /^0x[0-9a-fA-F]+$/.test(x)) return stripHexZeros(x);
  if (typeof x === 'object') {
    const y = { ...x };
    for (const k of ['blockNumber', 'blockTag', 'fromBlock', 'toBlock']) {
      if (y[k] != null) y[k] = normalizeBlockLike(y[k]);
    }
    return y;
  }
  return x;
}
function wrapProvider(p) {
  const origSend = p.send.bind(p);
  p.send = async (method, params = []) => {
    const fixedParams = params.map(normalizeBlockLike);
    return origSend(method, fixedParams);
  };
  return p;
}

/* ----------------------------
   Global provider state
---------------------------- */
let currentReadProvider = null;
let currentWriteProvider = null;
let rpcIndex = 0;
const readRpcsList = Array.isArray(POLYGON_RPCS) ? POLYGON_RPCS : [POLYGON_RPCS].filter(Boolean);
if (!readRpcsList.length) {
  throw new Error('[dataprovider] No POLYGON_RPCS configured');
}

/* ----------------------------
   Rotate to next RPC (shared globally)
---------------------------- */
function rotateReadProvider() {
  rpcIndex = (rpcIndex + 1) % readRpcsList.length;
  currentReadProvider = wrapProvider(new ethers.JsonRpcProvider(readRpcsList[rpcIndex]));
  console.log(`[dataprovider] Rotated to RPC: ${readRpcsList[rpcIndex]}`);
}

/* ----------------------------
   Get shared read provider
---------------------------- */
export async function getReadProvider() {
  if (!currentReadProvider) {
    currentReadProvider = wrapProvider(new ethers.JsonRpcProvider(readRpcsList[rpcIndex]));
  }

  try {
    // Lightweight call to verify provider is alive
    await currentReadProvider.getBlockNumber();
    return currentReadProvider;
  } catch (err) {
    console.warn(`[dataprovider] RPC failed: ${readRpcsList[rpcIndex]}, rotating...`);
    rotateReadProvider(); // rotate to the next provider
    return currentReadProvider; // return the updated provider
  }
}

/* ----------------------------
   Get safe read provider (for poolfetcher)
   - retries once if current provider fails
   - keeps same logic as getReadProvider
---------------------------- */
export async function getSafeReadProvider() {
  if (!currentReadProvider) {
    currentReadProvider = wrapProvider(new ethers.JsonRpcProvider(readRpcsList[rpcIndex]));
  }

  try {
    // Attempt lightweight call
    await currentReadProvider.getBlockNumber();
    return currentReadProvider;
  } catch (err) {
    console.warn(`[dataprovider] Safe read retry: RPC failed ${readRpcsList[rpcIndex]}`);
    // If only 1 RPC, just return same provider again
    if (readRpcsList.length > 1) {
      rotateReadProvider();
    }
    return currentReadProvider;
  }
}

/* ----------------------------
   Get write provider (single URL)
---------------------------- */
export async function getWriteProvider() {
  if (!currentWriteProvider) {
    currentWriteProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
  }
  return currentWriteProvider;
}

/* ----------------------------
   Verify first read RPC vs write provider
---------------------------- */
export async function verifySameChain() {
  const firstRpcProvider = wrapProvider(new ethers.JsonRpcProvider(readRpcsList[0])); // always first RPC
  const writeProvider = await getWriteProvider();

  const rNetwork = await firstRpcProvider.getNetwork();
  const wNetwork = await writeProvider.getNetwork();

  if (rNetwork.chainId !== wNetwork.chainId) {
    throw new Error(`First RPC and write provider are on different chains: ${rNetwork.chainId} vs ${wNetwork.chainId}`);
  }

  console.log(`[dataprovider] First RPC verified same chainId ${rNetwork.chainId} as write provider`);
  return true;
}

/* ----------------------------
   ✅ Ensure provider is on Polygon mainnet
---------------------------- */
export async function ensurePolygonNetwork(provider) {
  try {
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    if (chainId !== 137) {
      throw new Error(`Wrong chain — expected Polygon (137), got ${chainId}`);
    }
    console.log(`[dataprovider] ✅ Verified Polygon network (chainId ${chainId})`);
    return true;
  } catch (err) {
    console.error(`[dataprovider] ensurePolygonNetwork failed: ${err.message}`);
    throw err;
  }
}
