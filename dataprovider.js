// dataprovider.js — single RPC, auto-recovery, leading-zero hex fix
import 'dotenv/config';
import { ethers } from 'ethers';
import { WRITE_RPC_URL } from './rpcConfig.js';

/* ----------------------------
   Fix for RPC leading-zero hex block arguments
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
  if (['latest', 'earliest', 'pending', 'safe', 'finalized'].includes(x)) return x;
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
   Single shared provider
---------------------------- */
let currentProvider = null;

/* ----------------------------
   Get shared read provider
---------------------------- */
export async function getReadProvider() {
  if (!currentProvider) {
    currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
  }
  try {
    await currentProvider.getBlockNumber(); // lightweight test
  } catch (err) {
    console.warn(`[dataprovider] Provider failed, recreating...`);
    currentProvider = wrapProvider(new ethers.JsonRpcProvider(WRITE_RPC_URL));
  }
  return currentProvider;
}

/* ----------------------------
   Verify provider is on expected chain
---------------------------- */
export async function verifySameChain() {
  const provider = await getReadProvider();
  const network = await provider.getNetwork();
  const expectedChain = Number(process.env.CHAIN_ID || 137);
  if (network.chainId !== expectedChain) {
    throw new Error(
      `[dataprovider] RPC chainId mismatch — expected ${expectedChain}, got ${network.chainId}`
    );
  }
  console.log(`[dataprovider] ✅ RPC verified on chainId ${network.chainId}`);
  return true;
}

/* ----------------------------
   Default export
---------------------------- */
export default {
  getReadProvider,
  verifySameChain,
};