import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { ethers } from 'ethers';
import { getProvider, rotateProvider } from './dataprovider.js';
import { sendTelegramAlert } from './telegramalert.js';

const OUT_FILE = path.resolve('./tokenlist.json');

// ---------- Helpers (must be first) ----------
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toNumberSafe(v, fallback = 18) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  if (v && typeof v.toString === 'function') {
    const n = Number(v.toString());
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- RPC Concurrent Limiter ----------
const MAX_CONCURRENT_RPC = Number(process.env.MAX_CONCURRENT_RPC || 5);
let inFlightRPC = 0;
const rpcQueue = [];

async function limitRPC(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      inFlightRPC++;
      try {
        const res = await fn();
        resolve(res);
      } catch (err) {
        reject(err);
      } finally {
        inFlightRPC--;
        if (rpcQueue.length > 0) {
          const next = rpcQueue.shift();
          next();
        }
      }
    };

    if (inFlightRPC < MAX_CONCURRENT_RPC) {
      task();
    } else {
      rpcQueue.push(task);
    }
  });
}

// Helper to wrap existing provider logic with concurrency limiter
async function withLimitedProvider(fn) {
  return limitRPC(() => withRotatingProvider(fn));
}

// ---------- Config ----------
const TARGET_COUNT  = Math.max(50, Number(process.env.TARGET_COUNT || 450));
const PER_PAGE      = Math.max(100, Number(process.env.PER_PAGE || 250));
const CG_TIMEOUT    = Math.max(5000, Number(process.env.CG_TIMEOUT_MS || 15000));
const CG_RETRY      = Math.max(1, Number(process.env.CG_RETRY || 3));
const BATCH_SIZE    = Math.max(10, Number(process.env.BATCH_SIZE || 40));
const DETAIL_CONCUR = Math.min(6, Math.max(1, Number(process.env.CG_DETAIL_CONCURRENCY || 3)));
const MIN_LIQ_USD   = Math.max(0, Number(process.env.MIN_LIQ_USD || 50000));

// ---------- ABIs ----------
const DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])',
];
const IFACE_DECIMALS = new ethers.Interface(DECIMALS_ABI);

const MULTICALL3_ADDR =
  process.env.MULTICALL3 && isAddr(process.env.MULTICALL3)
    ? process.env.MULTICALL3
    : '0xca11bde05977b3631167028862be2a173976ca11';

// ---------- Axios (CoinGecko) ----------
const cg = axios.create({
  baseURL: 'https://api.coingecko.com/api/v3',
  timeout: CG_TIMEOUT,
  validateStatus: (s) => s >= 200 && s < 500,
  headers: { 'User-Agent': 'updatetokenlist/1.3 (+https://example.com)' },
});
if (process.env.COINGECKO_API_KEY) {
  const keyHeader = process.env.COINGECKO_KEY_HEADER || 'x-cg-demo-api-key';
  if (!cg.defaults.headers.common) cg.defaults.headers.common = {};
  cg.defaults.headers.common[keyHeader] = process.env.COINGECKO_API_KEY;
}

// ---------- Providers ----------
let provider = getProvider();
async function reinitProvider() { provider = rotateProvider(); }
async function withRotatingProvider(fn) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      console.warn(`Provider attempt ${i + 1} failed: ${e?.message || e}`);
      await reinitProvider();
      await sleep(150 * (i + 1));
    }
  }
  if (lastErr) throw lastErr;
}

// ---------- Existing tokenlist helpers ----------
function loadExisting() { ... }   // unchanged
function dedupeMerge(baseList, newList) { ... }  // unchanged
function saveJsonAtomic(file, data) { ... } // unchanged

// ---------- Decimals (single + batch via Multicall3) ----------
async function getDecimalsSafe(addr) {
  if (!isAddr(addr)) return 18;
  try {
    return await withLimitedProvider(async () => {
      const c = new ethers.Contract(addr, DECIMALS_ABI, provider);
      const d = await c.decimals();
      return toNumberSafe(d, 18);
    });
  } catch {
    return 18;
  }
}

async function getDecimalsBatch(addresses) {
  const addrs = addresses.filter(isAddr);
  if (addrs.length === 0) return [];
  const res = new Array(addrs.length).fill(18);

  await withLimitedProvider(async () => {
    const mc = new ethers.Contract(MULTICALL3_ADDR, MULTICALL3_ABI, provider);
    for (let i = 0; i < addrs.length; i += BATCH_SIZE) {
      const slice = addrs.slice(i, i + BATCH_SIZE);
      const calls = slice.map((a) => ({
        target: a,
        allowFailure: true,
        callData: IFACE_DECIMALS.encodeFunctionData('decimals', []),
      }));
      let out;
      try {
        out = await mc.aggregate3(calls);
      } catch (e) {
        console.warn(`Multicall3 batch failed at ${i}: ${e?.message || e}`);
        await Promise.all(slice.map(async (a, j) => {
          try {
            const d = await getDecimalsSafe(a);
            res[i + j] = d;
          } catch { }
        }));
        continue;
      }
      for (let j = 0; j < out.length; j++) {
        try {
          const item = out[j];
          const success = (typeof item.success === 'boolean') ? item.success : item[0];
          const returnData = item.returnData ?? item[1];
          if (success && returnData && returnData !== '0x') {
            const decoded = IFACE_DECIMALS.decodeFunctionResult('decimals', returnData);
            res[i + j] = toNumberSafe(decoded?.[0], 18);
          }
        } catch { }
      }
    }
  });

  return res;
}
// ---------- Exports (optional) ----------
export {
  isAddr,
  toNumberSafe,
  loadExisting,
  dedupeMerge,
  saveJsonAtomic,
  getDecimalsSafe,
  getDecimalsBatch,
  fetchWithRetry,
  withRotatingProvider,
  withLimitedProvider,       // NEW: export the RPC limiter wrapper
  MULTICALL3_ABI,
  MULTICALL3_ADDR,
  OUT_FILE,
  TARGET_COUNT,
  PER_PAGE,
  BATCH_SIZE,
  DETAIL_CONCUR,
  MIN_LIQ_USD,
};

// ---------- Other logic (fetchWithRetry, gatherPolygonTokens, main, etc.) ----------
// remains unchanged except wrap provider calls with `withLimitedProvider` where needed
