// updatetokenlist.js — ethers v6 safe, rotation + limiter, boolean-mismatch guard added

import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { ethers } from 'ethers';
import { getProvider, rotateProvider } from './dataprovider.js';
import { sendTelegramAlert } from './telegramalert.js';

const OUT_FILE = path.resolve('./tokenlist.json');

// ---------- Helpers ----------
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toNumberSafe(v, fallback = 18) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v); return Number.isFinite(n) ? n : fallback;
  }
  if (v && typeof v.toString === 'function') {
    const n = Number(v.toString()); return Number.isFinite(n) ? n : fallback;
  }
  const n = Number(v); return Number.isFinite(n) ? n : fallback;
}

// ---------- RPC Limiter ----------
const MAX_CONCURRENT_RPC = Math.max(1, Number(process.env.MAX_CONCURRENT_RPC || 5));
let inFlightRPC = 0;
const rpcQueue = [];

async function limitRPC(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      inFlightRPC++;
      try { resolve(await fn()); }
      catch (err) { reject(err); }
      finally {
        inFlightRPC--;
        if (rpcQueue.length > 0) rpcQueue.shift()();
      }
    };
    if (inFlightRPC < MAX_CONCURRENT_RPC) task();
    else rpcQueue.push(task);
  });
}

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
    : '0xca11bde05977b3631167028862be2a173976ca11'; // Polygon

// ---------- Axios (CoinGecko) ----------
const cg = axios.create({
  baseURL: 'https://api.coingecko.com/api/v3',
  timeout: CG_TIMEOUT,
  validateStatus: (s) => s >= 200 && s < 500,
  headers: { 'User-Agent': 'updatetokenlist/1.3 (+https://example.com)' },
});
if (process.env.COINGECKO_API_KEY) {
  const keyHeader = process.env.COINGECKO_KEY_HEADER || 'x-cg-demo-api-key';
  cg.defaults.headers.common ??= {};
  cg.defaults.headers.common[keyHeader] = process.env.COINGECKO_API_KEY;
}

// ---------- Provider rotation ----------
let provider = getProvider();

// Guard: patch ethers v6 block methods to ignore accidental boolean 2nd arg
function patchProviderBlockAPI(p) {
  if (!p) return p;
  if (typeof p.getBlock === 'function') {
    const _gb = p.getBlock.bind(p);
    p.getBlock = (tagOrNumber /*, _ignored */) => _gb(tagOrNumber);
  }
  if (typeof p.getBlockWithTransactions === 'function') {
    const _gbwt = p.getBlockWithTransactions.bind(p);
    p.getBlockWithTransactions = (tagOrNumber /*, _ignored */) => _gbwt(tagOrNumber);
  }
  return p;
}
provider = patchProviderBlockAPI(provider);

async function reinitProvider() {
  provider = patchProviderBlockAPI(rotateProvider('script-retry'));
}

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
  throw lastErr || new Error('withRotatingProvider: retries exhausted');
}

// ---------- Block helpers (no boolean passed to ethers) ----------
async function getBlockCompat(tagOrNumber, withTxs = false) {
  return withRotatingProvider(async () => {
    const p = patchProviderBlockAPI(getProvider());
    return withTxs
      ? p.getBlockWithTransactions(tagOrNumber)
      : p.getBlock(tagOrNumber);
  });
}

// ---------- Tokenlist helpers ----------
function loadExisting() {
  try {
    if (!fs.existsSync(OUT_FILE)) return [];
    const raw = fs.readFileSync(OUT_FILE, 'utf-8');
    const json = JSON.parse(raw);
    return Array.isArray(json) ? json : [];
  } catch { return []; }
}

function dedupeMerge(baseList, newList) {
  const byAddr = new Map();
  for (const t of baseList) if (isAddr(t?.address)) byAddr.set(t.address.toLowerCase(), t);
  for (const t of newList) {
    if (!isAddr(t?.address)) continue;
    const k = t.address.toLowerCase();
    const prev = byAddr.get(k) || {};
    byAddr.set(k, {
      address: k,
      symbol: t.symbol ?? prev.symbol ?? 'TKN',
      name: t.name ?? prev.name ?? 'Token',
      decimals: toNumberSafe(t.decimals ?? prev.decimals, 18),
    });
  }
  return Array.from(byAddr.values());
}

function saveJsonAtomic(file, data) {
  const tmp = `${file}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- Decimals ----------
async function getDecimalsSafe(addr) {
  if (!isAddr(addr)) return 18;
  try {
    return await withLimitedProvider(async () => {
      const p = patchProviderBlockAPI(provider);
      const c = new ethers.Contract(addr, DECIMALS_ABI, p);
      return toNumberSafe(await c.decimals(), 18);
    });
  } catch { return 18; }
}

async function getDecimalsBatch(addresses) {
  const addrs = addresses.filter(isAddr);
  if (!addrs.length) return [];
  const res = new Array(addrs.length).fill(18);

  await withLimitedProvider(async () => {
    const p = patchProviderBlockAPI(provider);
    const mc = new ethers.Contract(MULTICALL3_ADDR, MULTICALL3_ABI, p);
    for (let i = 0; i < addrs.length; i += BATCH_SIZE) {
      const slice = addrs.slice(i, i + BATCH_SIZE);
      const calls = slice.map(a => ({
        target: a,
        allowFailure: true,
        callData: IFACE_DECIMALS.encodeFunctionData('decimals', [])
      }));

      let out;
      try { out = await mc.aggregate3(calls); }
      catch {
        // fallback to singles
        await Promise.all(slice.map(async (a, j) => {
          try { res[i + j] = await getDecimalsSafe(a); } catch {}
        }));
        continue;
      }

      for (let j = 0; j < out.length; j++) {
        try {
          const item = out[j];
          const success = typeof item.success === 'boolean' ? item.success : item[0];
          const returnData = item.returnData ?? item[1];
          if (success && returnData && returnData !== '0x') {
            const decoded = IFACE_DECIMALS.decodeFunctionResult('decimals', returnData);
            res[i + j] = toNumberSafe(decoded?.[0], 18);
          }
        } catch {}
      }
    }
  });

  return res;
}

// ---------- Fetch with retry ----------
async function fetchWithRetry(configOrUrl, options = {}, retries = CG_RETRY) {
  let lastErr;
  for (let i = 0; i < Math.max(1, retries); i++) {
    try {
      if (typeof configOrUrl === 'string') return await cg.get(configOrUrl, options);
      return await cg.request(configOrUrl);
    } catch (e) { lastErr = e; await sleep(250 * (i + 1)); }
  }
  throw lastErr || new Error('fetchWithRetry failed');
}

// ---------- Exports ----------
export {
  isAddr, toNumberSafe, loadExisting, dedupeMerge, saveJsonAtomic,
  getDecimalsSafe, getDecimalsBatch,
  fetchWithRetry, withRotatingProvider, withLimitedProvider,
  getBlockCompat,
  MULTICALL3_ABI, MULTICALL3_ADDR,
  OUT_FILE, TARGET_COUNT, PER_PAGE, BATCH_SIZE, DETAIL_CONCUR, MIN_LIQ_USD,
};
