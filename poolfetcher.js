// poolfetcher.js — factory-less (dataprovider.js + routers.json + dexconfig.json)
// ethers v6, HTTP polling (no websockets), with Balancer Vault discovery + Swap poller.
// Optional Multicall3 helper (ethers v6) included but non-invasive.
// Logic order unchanged: discover -> liquidity filter -> index -> pollers -> offline arbs -> write JSON.

import { ethers } from 'ethers';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

// Provider rotation (your file)
import { getReadProvider, rotateProvider } from './dataprovider.js';

// ===================== ENV / TUNABLES =====================
const MIN_LIQUIDITY_USD = Number(process.env.MIN_LIQUIDITY_USD || 50_000);
const MIN_PROFIT_USD    = Number(process.env.MIN_PROFIT_USD    || 40);
const NOTIONAL_USD      = Number(process.env.NOTIONAL_USD      || 10_000);
const ARB_THRESHOLD     = Number(process.env.ARB_THRESHOLD     || 0.01); // 1%

const RPC_CONCURRENCY   = Math.max(1, Number(process.env.RPC_CONCURRENCY || '8'));

// Discovery pass (logs, initial bootstrap)
const DISCOVER_LOOKBACK_BLOCKS = Math.max(1000, Number(process.env.DISCOVER_LOOKBACK_BLOCKS || 5000));
const DISCOVER_MAX_RANGE       = Math.max(256,  Number(process.env.DISCOVER_MAX_RANGE || 1500));

// Pollers + queues
const POLL_MS         = Math.max(1000, Number(process.env.SWAP_POLL_MS || 4000));
const LOOKBACK_BLOCKS = Math.max(0,    Number(process.env.SWAP_LOOKBACK_BLOCKS || 6));
const MAX_RANGE       = Math.max(100,  Number(process.env.SWAP_MAX_RANGE || 2000));
const ADDR_BATCH      = Math.max(1,    Number(process.env.SWAP_ADDR_BATCH || 40));
const MAX_SEEN        = Math.max(10_000, Number(process.env.SWAP_MAX_SEEN || 100_000));
const MAX_QUEUE       = Math.max(5_000,  Number(process.env.SWAP_MAX_QUEUE || 50_000));

// CoinGecko
const CG_BASE    = 'https://api.coingecko.com/api/v3/simple/token_price/polygon-pos';
const CG_CHUNK   = Math.max(5, Number(process.env.CG_CHUNK || 50));
const CG_TIMEOUT = Math.max(5000, Number(process.env.CG_TIMEOUT_MS || 15000));
const CG_RETRY   = Math.max(1, Number(process.env.CG_RETRY || 3));

// ===================== Topics (ethers v6 — compute via keccak) =====================
const SWAP_TOPIC_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613dacf8b9baed548f383ad7bc38c5f';
// Uniswap V3 Swap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
const SWAP_TOPIC_V3 = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");

// Balancer Vault events
const BAL_TOPIC_POOL_REGISTERED = ethers.id("PoolRegistered(bytes32,address,uint8)");
const BAL_TOPIC_SWAP            = ethers.id("Swap(bytes32,address,address,uint256,uint256)");

// ===================== ABIs =====================
const DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const ERC20_ABI    = ['function balanceOf(address) view returns (uint256)'];

const PAIR_ABI_V2  = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];
const POOL_ABI_V3  = [
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

// --- Balancer Vault (pair-like via Vault) ---
const BAL_VAULT_ABI = [
  "event PoolRegistered(bytes32 indexed poolId, address indexed poolAddress, uint8 specialization)",
  "event Swap(bytes32 indexed poolId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)"
];

// --- Optional Multicall3 (ethers v6) ---
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])"
];
const MULTICALL3_ADDR = (process.env.MULTICALL3 && isAddr(process.env.MULTICALL3))
  ? process.env.MULTICALL3
  // widely deployed Multicall3 address on many chains incl. Polygon (chainId 137)
  : '0xca11bde05977b3631167028862be2a173976ca11';

// ===================== LOAD CONFIGS =====================
let dexConfig = { polygon: [] };
try {
  const jsonPath = new URL('./dexconfig.json', import.meta.url);
  dexConfig = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
} catch (e) {
  console.warn('⚠️ Could not read dexconfig.json:', e?.message || e);
}

let routers = {};
try {
  const rPath = new URL('./routers.json', import.meta.url);
  routers = JSON.parse(fs.readFileSync(rPath, 'utf-8'));
} catch (e) {
  console.warn('⚠️ Could not read routers.json:', e?.message || e);
}

// Support both nested and flat routers.json
function dexToRouter(dexName) {
  const poly = routers?.polygon;
  if (poly && poly[dexName]?.address && isAddr(poly[dexName].address)) return poly[dexName].address;
  const flat = routers?.[dexName];
  if (typeof flat === 'string' && isAddr(flat)) return flat;
  if (flat?.address && isAddr(flat.address)) return flat.address;
  return null;
}

// ===================== PROVIDER =====================
let provider = getReadProvider();

async function ensureProviderHealthy() {
  for (let i = 0; i < 4; i++) {
    try {
      const bn = await provider.getBlockNumber();
      if (Number.isFinite(Number(bn))) return true;
    } catch {}
    provider = rotateProvider();
    await sleep(200 * (i + 1));
  }
  return false;
}

// ===================== UTILS =====================
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function createLimiter(max = 12) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then((v) => { active--; resolve(v); next(); })
      .catch((e) => { active--; reject(e); next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const limitRPC = createLimiter(RPC_CONCURRENCY);

function isAddr(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }
function toNum(x, fallback = 0) { if (typeof x === 'bigint') { const n = Number(x); return Number.isFinite(n) ? n : fallback; } const n = Number(x); return Number.isFinite(n) ? n : fallback; }
function safePow10(d) { const n = Number(d); if (!Number.isFinite(n) || n < 0 || n > 36) return 1; return 10 ** n; }
function safeInv(x) { const n = Number(x); return n > 0 ? 1 / n : 0; }
function pairKey(a, b) { const A=(a||'').toLowerCase(),B=(b||'').toLowerCase(); return A<B?`${A}|${B}`:`${B}|${A}`; }

function calcPrice(reserve0, reserve1, dec0 = 18, dec1 = 18) {
  try { const n0=toNum(reserve0,0), n1=toNum(reserve1,0); const r0=n0/safePow10(dec0), r1=n1/safePow10(dec1); return r0>0 && r1>0 ? r0/r1 : 0; }
  catch { return 0; }
}
function priceFor(pool, base, quote) {
  const b=(base||'').toLowerCase(), q=(quote||'').toLowerCase();
  const t0=(pool.token0||'').toLowerCase(), t1=(pool.token1||'').toLowerCase();
  if (t0===b && t1===q) return calcPrice(pool.reserve0, pool.reserve1, pool.decimals0 ?? 18, pool.decimals1 ?? 18);
  if (t0===q && t1===b) return safeInv(calcPrice(pool.reserve0, pool.reserve1, pool.decimals0 ?? 18, pool.decimals1 ?? 18));
  return 0;
}
const rateFor = (pool, fromToken, toToken) => priceFor(pool, fromToken, toToken);
function estimateDirectEdge(a,b){ a=Number(a)||0; b=Number(b)||0; const denom=((a+b)/2)||1; const rel=Math.abs(a-b)/denom; return Number.isFinite(rel)?Math.max(rel,0):0; }
function estimateTriEdge(cycleRate){ const gross=(Number(cycleRate)||0)-1; return Number.isFinite(gross)?Math.max(gross,0):0; }
function edgeToProfitUSD(edge, notional=NOTIONAL_USD){ edge=Number(edge)||0; notional=Number(notional)||0; return edge>0?edge*notional:0; }

function writeJsonAtomic(filename, data) {
  try {
    const dir = path.dirname(filename) || '.';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filename)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filename);
  } catch (e) { console.error(`Failed to write ${filename}:`, e?.message || e); }
}
function appendJson(filename, record) {
  try {
    const dir = path.dirname(filename) || '.';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let arr = [];
    if (fs.existsSync(filename)) {
      const prev = fs.readFileSync(filename, 'utf8');
      if (prev) { try { const parsed = JSON.parse(prev); if (Array.isArray(parsed)) arr = parsed; } catch {} }
    }
    arr.push(record);
    writeJsonAtomic(filename, arr);
  } catch (e) { console.error(`Failed to append ${filename}:`, e?.message || e); }
}

// ===================== SAFE GUARDS =====================

// Safe getLogs with retries + provider rotation + exponential backoff
async function safeGetLogs(filter, attempts = 4) {
  let attempt = 0;
  while (true) {
    try {
      return await provider.getLogs(filter);
    } catch (err) {
      console.error(`safeGetLogs error (attempt ${attempt+1}):`, err?.message || err);
      attempt++;
      if (attempt >= attempts) throw err;
      provider = rotateProvider();
      await sleep(200 * (2 ** attempt));
    }
  }
}

// Safe poolId normalization
function normPoolId(poolId) {
  if (!poolId) return '';
  if (typeof poolId === 'string') return poolId.toLowerCase();
  try { return String(poolId).toLowerCase(); } catch { return ''; }
}

// ===================== OPTIONAL MULTICALL3 HELPERS =====================
function getMulticallContract() {
  try { return new ethers.Contract(MULTICALL3_ADDR, MULTICALL3_ABI, provider); }
  catch { return null; }
}

/** aggregate3(reads) -> returns decoded results (or null on failure per call) */
async function multicallAggregate3(reads) {
  const mc = getMulticallContract();
  if (!mc) throw new Error('No multicall contract');
  // reads: [{ target, allowFailure, callData }]
  return mc.aggregate3(reads);
}

// ===================== ON-CHAIN READS =====================
async function getPairInfoV2(pairAddr) {
  const c = new ethers.Contract(pairAddr, PAIR_ABI_V2, provider);
  const [t0, t1, reserves] = await Promise.all([
    limitRPC(() => c.token0()),
    limitRPC(() => c.token1()),
    limitRPC(() => c.getReserves()),
  ]);
  const reserve0 = Array.isArray(reserves) ? reserves[0] : reserves?.reserve0 ?? 0n;
  const reserve1 = Array.isArray(reserves) ? reserves[1] : reserves?.reserve1 ?? 0n;
  return { pairAddr, token0: t0, token1: t1, reserve0, reserve1 };
}

async function getPoolInfoV3(poolAddr) {
  const c = new ethers.Contract(poolAddr, POOL_ABI_V3, provider);
  const [t0, t1] = await Promise.all([
    limitRPC(() => c.token0()),
    limitRPC(() => c.token1()),
  ]);
  // reserves proxy by balances (works for UniswapV3/Kyber-like)
  const e0 = new ethers.Contract(t0, ERC20_ABI, provider);
  const e1 = new ethers.Contract(t1, ERC20_ABI, provider);
  const [bal0, bal1] = await Promise.all([
    limitRPC(() => e0.balanceOf(poolAddr)),
    limitRPC(() => e1.balanceOf(poolAddr)),
  ]);
  return { pairAddr: poolAddr, token0: t0, token1: t1, reserve0: bal0, reserve1: bal1 };
}

async function withRetry(fn, retries = 2, delayMs = 250) {
  let a = 0;
  while (true) {
    try { return await fn(); }
    catch (e) {
      if (a >= retries) throw e;
      provider = rotateProvider();
      await sleep(delayMs * (a + 1));
      a++;
    }
  }
}

// ===================== PRICES / DECIMALS =====================
const decimalsCache = Object.create(null);

async function getDecimals(tokenAddr) {
  if (!isAddr(tokenAddr)) return 18;
  const addr = tokenAddr.toLowerCase();
  if (decimalsCache[addr] !== undefined) return decimalsCache[addr];

  try {
    const dec = await limitRPC(async () => {
      const contract = new ethers.Contract(addr, DECIMALS_ABI, provider);
      return await contract.decimals();
    });
    const n = Number(dec);
    decimalsCache[addr] = Number.isFinite(n) ? n : 18;
    return decimalsCache[addr];
  } catch {
    decimalsCache[addr] = 18; return 18;
  }
}

async function getTokenPrices(tokenAddresses) {
  if (!tokenAddresses?.length) return {};
  const uniq = Array.from(new Set(tokenAddresses.map(a => (isAddr(a) ? a.toLowerCase() : '')).filter(Boolean)));
  if (uniq.length === 0) return {};
  const out = {};
  for (let i = 0; i < uniq.length; i += CG_CHUNK) {
    const batch = uniq.slice(i, i + CG_CHUNK);
    const params = new URLSearchParams({ contract_addresses: batch.join(','), vs_currencies: 'usd' }).toString();
    let lastErr;
    for (let attempt = 0; attempt < CG_RETRY; attempt++) {
      try {
        const resp = await axios.get(`${CG_BASE}?${params}`, { timeout: CG_TIMEOUT, validateStatus: s => s >= 200 && s < 500 });
        if (resp.status === 429) { await sleep(500 * (attempt + 1)); continue; }
        const data = resp?.data; if (data && typeof data === 'object') Object.assign(out, data);
        break;
      } catch (err) { lastErr = err; await sleep(300 * (attempt + 1)); }
    }
    if (lastErr) console.error('CoinGecko batch error:', lastErr?.message || lastErr);
    await sleep(120 + Math.floor(Math.random() * 120));
  }
  return out;
}

// ===================== FACTORY-LESS DISCOVERY (V2/V3 by topics) =====================
function pickDexLabelFor(kind, configuredDexNames) {
  const names = configuredDexNames || [];
  const has = (n) => names.includes(n);
  if (kind === 'v2') {
    if (has('quickswap-v2')) return 'quickswap-v2';
    const anyV2 = names.find(n => /-v2$/i.test(n));
    return anyV2 || 'v2-generic';
  }
  if (kind === 'v3') {
    if (has('uniswap-v3'))   return 'uniswap-v3';
    if (has('quickswap-v3')) return 'quickswap-v3';
    const anyV3 = names.find(n => /-v3$/i.test(n));
    return anyV3 || 'v3-generic';
  }
  return 'unknown';
}

async function discoverByLogs() {
  let head;
  try { head = await provider.getBlockNumber(); }
  catch { provider = rotateProvider(); head = await provider.getBlockNumber(); }
  if (!Number.isFinite(Number(head))) return [];

  const fromBlock = Math.max(0, head - DISCOVER_LOOKBACK_BLOCKS);
  const ranges = [];
  for (let start = fromBlock; start <= head; start += DISCOVER_MAX_RANGE) {
    const end = Math.min(start + DISCOVER_MAX_RANGE - 1, head);
    ranges.push([start, end]);
  }

  const addrsV2 = new Set();
  const addrsV3 = new Set();

  for (const [start, end] of ranges) {
    for (const topic of [SWAP_TOPIC_V2, SWAP_TOPIC_V3]) {
      const filter = { topics: [topic], fromBlock: start, toBlock: end };
      try {
        const logs = await safeGetLogs(filter);
        for (const log of logs) {
          const addr = (log?.address || '').toLowerCase();
          if (!isAddr(addr)) continue;
          if (topic === SWAP_TOPIC_V2) addrsV2.add(addr);
          else addrsV3.add(addr);
        }
      } catch (e) {
        console.warn(`discoverByLogs getLogs failed [${start}-${end}] (${e?.message || e}); rotating...`);
        provider = rotateProvider();
      }
    }
  }

  const pools = [];
  for (const addr of addrsV2) {
    try {
      const info = await withRetry(() => getPairInfoV2(addr));
      if (info?.token0 && info?.token1) pools.push({ __kind: 'v2', ...info });
    } catch {}
  }
  for (const addr of addrsV3) {
    try {
      const info = await withRetry(() => getPoolInfoV3(addr));
      if (info?.token0 && info?.token1) pools.push({ __kind: 'v3', ...info });
    } catch {}
  }

  const configured = Array.isArray(dexConfig?.polygon) ? dexConfig.polygon : [];
  const configuredNames = configured.map(d => d?.name).filter(Boolean);

  return pools.map(p => {
    const dexLabel = pickDexLabelFor(p.__kind, configuredNames);
    return { dex: dexLabel, ...p };
  });
}

// ===================== BALANCER DISCOVERY + POLLER =====================
async function balDiscoverPools(vaultAddr, lookbackBlocks = DISCOVER_LOOKBACK_BLOCKS, maxRange = DISCOVER_MAX_RANGE) {
  if (!isAddr(vaultAddr)) return [];
  let head;
  try { head = await provider.getBlockNumber(); }
  catch { provider = rotateProvider(); head = await provider.getBlockNumber(); }
  if (!Number.isFinite(Number(head))) return [];

  const fromBlock = Math.max(0, head - lookbackBlocks);
  const out = [];
  for (let start = fromBlock; start <= head; start += maxRange) {
    const end = Math.min(start + maxRange - 1, head);
    const filter = { address: vaultAddr, topics: [BAL_TOPIC_POOL_REGISTERED], fromBlock: start, toBlock: end };
    let logs;
    try { logs = await safeGetLogs(filter); }
    catch (e) { provider = rotateProvider(); continue; }
    for (const log of logs || []) {
      try {
        // We could parse, but we only need poolId + poolAddress from topics/data;
        // using Interface here is fine (ethers v6), but not required for topics.
        const iface = new ethers.Interface(BAL_VAULT_ABI);
        const parsed = iface.parseLog(log);
        const poolId = parsed?.args?.poolId;
        const poolAddress = (parsed?.args?.poolAddress || '').toLowerCase();
        if (poolId && isAddr(poolAddress)) out.push({ poolId, poolAddress });
      } catch {}
    }
  }
  // dedupe by poolId
  const seen = new Set(); const uniq = [];
  for (const p of out) {
    const k = normPoolId(p.poolId) || p.poolId;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(p);
  }
  return uniq;
}

async function balGetPairLikeInfo(vaultAddr, poolId, poolAddress) {
  try {
    const vault = new ethers.Contract(vaultAddr, BAL_VAULT_ABI, provider);
    const res = await limitRPC(() => vault.getPoolTokens(poolId));
    const tokens = res?.[0] || res?.tokens || [];
    const balances = res?.[1] || res?.balances || [];
    if (Array.isArray(tokens) && tokens.length === 2 && Array.isArray(balances) && balances.length === 2) {
      return {
        pairAddr: poolAddress,
        token0: tokens[0],
        token1: tokens[1],
        reserve0: balances[0],
        reserve1: balances[1]
      };
    }
  } catch {}
  return null;
}

function startSwapPollBalancer(vaultAddr, balancerPoolIdToAddr, poolsByAddr, poolsByPairKey, poolsByToken, edgeThreshold = 0, opts = {}) {
  if (!isAddr(vaultAddr) || !balancerPoolIdToAddr || Object.keys(balancerPoolIdToAddr).length === 0) return;

  const { pollMs = POLL_MS, lookbackBlocks = LOOKBACK_BLOCKS, maxRange = MAX_RANGE, maxSeen = MAX_SEEN } = opts;
  console.log(`🚀 Balancer: Polling Vault Swap events on ${vaultAddr} (every ${pollMs}ms)`);

  const seen = new Set(); let seenCounter = 0;
  const queue = []; let active = 0; const MAX_CONCURRENT = 4;

  const processNext = async () => {
    if (active >= MAX_CONCURRENT || queue.length === 0) return;
    active++;
    const log = queue.shift();
    try { await handleSwapLogBAL(log); } catch (e) { console.error('Balancer Swap handler error:', e?.message || e); }
    finally { active--; setImmediate(processNext); }
  };

  const handleSwapLogBAL = async (log) => {
    try {
      const iface = new ethers.Interface(BAL_VAULT_ABI);
      let parsed; try { parsed = iface.parseLog(log); } catch { return; }
      const poolId = parsed?.args?.poolId; if (!poolId) return;
      const poolAddr = balancerPoolIdToAddr[(normPoolId(poolId) || poolId)];
      if (!poolAddr) return;

      const pool = poolsByAddr[poolAddr]; if (!pool) return;
      const info = await balGetPairLikeInfo(vaultAddr, poolId, poolAddr);
      if (info?.reserve0 !== undefined) pool.reserve0 = info.reserve0;
      if (info?.reserve1 !== undefined) pool.reserve1 = info.reserve1;

      const key = pairKey(pool.token0, pool.token1);
      const [base, quote] = key.split('|');
      const group = poolsByPairKey[key] || [];
      const priceA = priceFor(pool, base, quote);

      // Direct
      for (const other of group) {
        if (!other || other.pairAddr === pool.pairAddr) continue;
        const priceB = priceFor(other, base, quote);
        const edge = estimateDirectEdge(priceA, priceB);
        if (edge > edgeThreshold) {
          const estProfitUSD = edgeToProfitUSD(edge);
          if (estProfitUSD >= MIN_PROFIT_USD) {
            appendJson('direct_pool.json', {
              token0: base, token1: quote,
              dexA: pool.dex, dexB: other.dex,
              routerA: dexToRouter(pool.dex), routerB: dexToRouter(other.dex),
              styleA: (poolsByAddr[pool.pairAddr.toLowerCase()]?.__kind || 'bal'),
              styleB: (poolsByAddr[other.pairAddr.toLowerCase()]?.__kind || 'v2'),
              feeA: null, feeB: null,
              priceA, priceB,
              poolAddrA: pool.pairAddr, poolAddrB: other.pairAddr,
              edge, estProfitUSD,
              source: 'swap_poll_balancer', tx: log.transactionHash, logIndex: log.logIndex, timestamp: Date.now()
            });
          }
        }
      }

      // Triangular
      const tokenA = pool.token0, tokenB = pool.token1;
      const fromB = poolsByToken[tokenB] || [];
      for (const p2 of fromB) {
        if (!p2 || p2.pairAddr === pool.pairAddr) continue;
        const tokenC = p2.token0 === tokenB ? p2.token1 : p2.token0;
        if (!tokenC || tokenC === tokenA) continue;

        const fromC = poolsByToken[tokenC] || [];
        for (const p3 of fromC) {
          const closes = (p3.token0 === tokenC && p3.token1 === tokenA) || (p3.token1 === tokenC && p3.token0 === tokenA);
          if (!closes) continue;

          const cycleRate = rateFor(pool, tokenA, tokenB) * rateFor(p2, tokenB, tokenC) * rateFor(p3, tokenC, tokenA);
          const edgeTri = estimateTriEdge(cycleRate);
          if (edgeTri > 0) {
            const estProfitUSD = edgeToProfitUSD(edgeTri);
            if (estProfitUSD >= MIN_PROFIT_USD) {
              appendJson('tri_pool.json', {
                route: [tokenA, tokenB, tokenC, tokenA],
                pools: [pool.pairAddr, p2.pairAddr, p3.pairAddr],
                dexs: [pool.dex, p2.dex, p3.dex],
                routers: [dexToRouter(pool.dex), dexToRouter(p2.dex), dexToRouter(p3.dex)],
                styles: [
                  (poolsByAddr[pool.pairAddr.toLowerCase()]?.__kind || 'bal'),
                  (poolsByAddr[p2.pairAddr.toLowerCase()]?.__kind || 'v2'),
                  (poolsByAddr[p3.pairAddr.toLowerCase()]?.__kind || 'v2')
                ],
                fees: [null, null, null],
                cycleRate, edge: edgeTri, estProfitUSD,
                source: 'swap_poll_balancer', tx: log.transactionHash, logIndex: log.logIndex, timestamp: Date.now()
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('Balancer Swap handler error:', e?.message || e);
    }
  };

  let lastScanned = 0, stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      let head; try { head = await provider.getBlockNumber(); }
      catch { provider = rotateProvider(); await sleep(200); head = await provider.getBlockNumber(); }
      if (!Number.isFinite(Number(head))) return;

      if (lastScanned === 0) lastScanned = Math.max(0, head - lookbackBlocks);
      const from = Math.max(0, lastScanned - lookbackBlocks + 1), to = head;

      for (let start = from; start <= to; start += maxRange) {
        const end = Math.min(start + maxRange - 1, to);
        const filter = { address: vaultAddr, topics: [BAL_TOPIC_SWAP], fromBlock: start, toBlock: end };
        let logs;
        try { logs = await safeGetLogs(filter); }
        catch (e) { provider = rotateProvider(); continue; }
        for (const log of logs || []) {
          const key = `${log.transactionHash}:${log.logIndex}`;
          if (seen.has(key)) continue;
          if (seenCounter >= maxSeen) {
            const prune = Math.floor(maxSeen / 2); let removed = 0;
            for (const k of seen) { seen.delete(k); if (++removed >= prune) break; }
            seenCounter = seen.size;
          }
          seen.add(key); seenCounter++;
          if (queue.length >= MAX_QUEUE) {
            const drop = Math.max(1, Math.floor(queue.length * 0.05));
            queue.splice(0, drop);
          }
          queue.push(log); setImmediate(processNext);
        }
      }
      lastScanned = to;
    } catch (e) {
      console.warn('Balancer poll tick error:', e?.message || e);
      provider = rotateProvider();
    } finally {
      if (!stopped) setTimeout(tick, POLL_MS);
    }
  };

  tick();
  return () => { stopped = true; };
}

// ===================== SWAP EVENT POLLERS — V2 & V3 =====================
function startSwapPollV2(pairAddrsLower, poolsByAddr, poolsByPairKey, poolsByToken, edgeThreshold = 0, opts = {}) {
  if (!Array.isArray(pairAddrsLower) || pairAddrsLower.length === 0) return;
  const { pollMs = POLL_MS, lookbackBlocks = LOOKBACK_BLOCKS, maxRange = MAX_RANGE, addrBatch = ADDR_BATCH, maxSeen = MAX_SEEN } = opts;
  console.log(`🚀 V2: Polling Swap events on ${pairAddrsLower.length} pools (every ${pollMs}ms)`);

  const seen = new Set(); let seenCounter = 0;
  const queue = []; let active = 0; const MAX_CONCURRENT = 4;

  const processNext = async () => { if (active >= MAX_CONCURRENT || queue.length === 0) return; active++; const log = queue.shift(); try { await handle(log); } catch (e) { console.error('V2 Swap handler error:', e?.message || e); } finally { active--; setImmediate(processNext); } };

  const handle = async (log) => {
    const addr = (log?.address || '').toLowerCase();
    const pool = poolsByAddr[addr];
    if (!pool) return;
    try {
      const updated = await withRetry(() => getPairInfoV2(pool.pairAddr));
      if (updated?.reserve0 !== undefined) pool.reserve0 = updated.reserve0;
      if (updated?.reserve1 !== undefined) pool.reserve1 = updated.reserve1;

      const key = pairKey(pool.token0, pool.token1);
      const [base, quote] = key.split('|');
      const group = poolsByPairKey[key] || [];
      const priceA = priceFor(pool, base, quote);

      // Direct
      for (const other of group) {
        if (!other || other.pairAddr === pool.pairAddr) continue;
        const priceB = priceFor(other, base, quote);
        const edge = estimateDirectEdge(priceA, priceB);
        if (edge > edgeThreshold) {
          const estProfitUSD = edgeToProfitUSD(edge);
          if (estProfitUSD >= MIN_PROFIT_USD) {
            appendJson('direct_pool.json', {
              token0: base, token1: quote,
              dexA: pool.dex, dexB: other.dex,
              routerA: dexToRouter(pool.dex), routerB: dexToRouter(other.dex),
              styleA: 'v2', styleB: other.__kind || 'v2',
              feeA: null, feeB: null,
              priceA, priceB,
              poolAddrA: pool.pairAddr, poolAddrB: other.pairAddr,
              edge, estProfitUSD,
              source: 'swap_poll_v2', tx: log.transactionHash, logIndex: log.logIndex, timestamp: Date.now()
            });
          }
        }
      }

      // Triangular
      const tokenA = pool.token0, tokenB = pool.token1;
      const fromB = poolsByToken[tokenB] || [];
      for (const p2 of fromB) {
        if (!p2 || p2.pairAddr === pool.pairAddr) continue;
        const tokenC = p2.token0 === tokenB ? p2.token1 : p2.token0;
        if (!tokenC || tokenC === tokenA) continue;

        const fromC = poolsByToken[tokenC] || [];
        for (const p3 of fromC) {
          const closes = (p3.token0 === tokenC && p3.token1 === tokenA) || (p3.token1 === tokenC && p3.token0 === tokenA);
          if (!closes) continue;

          const cycleRate = rateFor(pool, tokenA, tokenB) * rateFor(p2, tokenB, tokenC) * rateFor(p3, tokenC, tokenA);
          const edgeTri = estimateTriEdge(cycleRate);
          if (edgeTri > 0) {
            const estProfitUSD = edgeToProfitUSD(edgeTri);
            if (estProfitUSD >= MIN_PROFIT_USD) {
              appendJson('tri_pool.json', {
                route: [tokenA, tokenB, tokenC, tokenA],
                pools: [pool.pairAddr, p2.pairAddr, p3.pairAddr],
                dexs: [pool.dex, p2.dex, p3.dex],
                routers: [dexToRouter(pool.dex), dexToRouter(p2.dex), dexToRouter(p3.dex)],
                styles: [pool.__kind || 'v2', p2.__kind || 'v2', p3.__kind || 'v2'],
                fees: [null, null, null],
                cycleRate, edge: edgeTri, estProfitUSD,
                source: 'swap_poll_v2', tx: log.transactionHash, logIndex: log.logIndex, timestamp: Date.now()
              });
            }
          }
        }
      }
    } catch (e) { console.error('V2 Swap handler error:', e?.message || e); }
  };

  const batches = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  let lastScanned = 0, stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      let head; try { head = await provider.getBlockNumber(); } catch { provider = rotateProvider(); await sleep(200); head = await provider.getBlockNumber(); }
      if (!Number.isFinite(Number(head))) return;

      if (lastScanned === 0) lastScanned = Math.max(0, head - lookbackBlocks);
      const from = Math.max(0, lastScanned - lookbackBlocks + 1), to = head;

      for (let start = from; start <= to; start += maxRange) {
        const end = Math.min(start + maxRange - 1, to);
        for (const addrChunk of batches(pairAddrsLower, ADDR_BATCH)) {
          const filter = { address: addrChunk, topics: [SWAP_TOPIC_V2], fromBlock: start, toBlock: end };
          let logs;
          try { logs = await safeGetLogs(filter); }
          catch (e) {
            console.warn(`V2 getLogs failed [${start}-${end}] (${e?.message || e}). Rotating provider...`);
            provider = rotateProvider(); await sleep(150 + Math.floor(Math.random() * 250));
            try { logs = await provider.getLogs(filter); } catch { continue; }
          }
          for (const log of logs || []) {
            const key = `${log.transactionHash}:${log.logIndex}`;
            if (seen.has(key)) continue;
            if (seenCounter >= maxSeen) {
              const prune = Math.floor(maxSeen/2);
              let removed=0; for (const k of seen){ seen.delete(k); if (++removed>=prune) break; }
              seenCounter = seen.size;
            }
            seen.add(key); seenCounter++;
            if (queue.length >= MAX_QUEUE) { const drop = Math.max(1, Math.floor(queue.length * 0.05)); queue.splice(0, drop); }
            queue.push(log); setImmediate(processNext);
          }
        }
      }
      lastScanned = to;
    } catch (e) {
      console.warn('V2 poll tick error:', e?.message || e);
      provider = rotateProvider();
    } finally { if (!stopped) setTimeout(tick, pollMs); }
  };

  tick();
  return () => { stopped = true; };
}

function startSwapPollElastic(elasticPoolAddrsLower, poolsByAddr, poolsByPairKey, poolsByToken, edgeThreshold = 0, opts = {}) {
  if (!Array.isArray(elasticPoolAddrsLower) || elasticPoolAddrsLower.length === 0) return;

  const { pollMs = POLL_MS, lookbackBlocks = LOOKBACK_BLOCKS, maxRange = MAX_RANGE, addrBatch = ADDR_BATCH, maxSeen = MAX_SEEN } = opts;
  console.log(`🚀 Elastic: Polling Swap events on ${elasticPoolAddrsLower.length} pools (V3) (every ${pollMs}ms)`);

  const seen = new Set(); let seenCounter = 0;
  const queue = []; let active = 0; const MAX_CONCURRENT = 4;

  const processNext = async () => { if (active >= MAX_CONCURRENT || queue.length === 0) return; active++; const log = queue.shift(); try { await handle(log); } catch (e) { console.error('Elastic Swap handler error:', e?.message || e); } finally { active--; setImmediate(processNext); } };

  const handle = async (log) => {
    const addr = (log?.address || '').toLowerCase();
    const pool = poolsByAddr[addr];
    if (!pool) return;
    try {
      const info = await withRetry(() => getPoolInfoV3(pool.pairAddr));
      if (info?.reserve0 !== undefined) pool.reserve0 = info.reserve0;
      if (info?.reserve1 !== undefined) pool.reserve1 = info.reserve1;

      const key = pairKey(pool.token0, pool.token1);
      const [base, quote] = key.split('|');
      const group = poolsByPairKey[key] || [];
      const priceA = priceFor(pool, base, quote);

      // Direct
      for (const other of group) {
        if (!other || other.pairAddr === pool.pairAddr) continue;
        const priceB = priceFor(other, base, quote);
        const edge = estimateDirectEdge(priceA, priceB);
        if (edge > edgeThreshold) {
          const est = edgeToProfitUSD(edge);
          if (est >= MIN_PROFIT_USD) {
            const kA = (pool.__kind || 'v3'), kB = (other.__kind || 'v2');
            appendJson('direct_pool.json', {
              token0: base, token1: quote,
              dexA: pool.dex, dexB: other.dex,
              routerA: dexToRouter(pool.dex), routerB: dexToRouter(other.dex),
              styleA: kA, styleB: kB,
              feeA: null, feeB: null,
              priceA, priceB,
              poolAddrA: pool.pairAddr, poolAddrB: other.pairAddr,
              edge, estProfitUSD: est,
              source: 'swap_poll_elastic', tx: log.transactionHash, logIndex: log.logIndex, timestamp: Date.now()
            });
          }
        }
      }

      // Triangular
      const tokenA = pool.token0, tokenB = pool.token1;
      const fromB = poolsByToken[tokenB] || [];
      for (const p2 of fromB) {
        if (!p2 || p2.pairAddr === pool.pairAddr) continue;
        const tokenC = p2.token0 === tokenB ? p2.token1 : p2.token0;
        if (!tokenC || tokenC === tokenA) continue;
        const fromC = poolsByToken[tokenC] || [];
        for (const p3 of fromC) {
          const closes = (p3.token0 === tokenC && p3.token1 === tokenA) || (p3.token1 === tokenC && p3.token0 === tokenA);
          if (!closes) continue;
          const cycleRate = rateFor(pool, tokenA, tokenB) * rateFor(p2, tokenB, tokenC) * rateFor(p3, tokenC, tokenA);
          const edgeTri = estimateTriEdge(cycleRate);
          if (edgeTri > 0) {
            const est = edgeToProfitUSD(edgeTri);
            if (est >= MIN_PROFIT_USD) {
              const k1=(pool.__kind||'v3'),k2=(p2.__kind||'v2'),k3=(p3.__kind||'v2');
              appendJson('tri_pool.json', {
                route: [tokenA, tokenB, tokenC, tokenA],
                pools: [pool.pairAddr, p2.pairAddr, p3.pairAddr],
                dexs:  [pool.dex,      p2.dex,      p3.dex],
                routers: [dexToRouter(pool.dex), dexToRouter(p2.dex), dexToRouter(p3.dex)],
                styles: [k1, k2, k3],
                fees: [null, null, null],
                cycleRate, edge: edgeTri, estProfitUSD: est,
                source: 'swap_poll_elastic', tx: log.transactionHash, logIndex: log.logIndex, timestamp: Date.now()
              });
            }
          }
        }
      }
    } catch (e) { console.error('Elastic Swap handler error:', e?.message || e); }
  };

  const batches = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  let lastScanned = 0, stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      let head; try { head = await provider.getBlockNumber(); } catch { provider = rotateProvider(); await sleep(200); head = await provider.getBlockNumber(); }
      if (!Number.isFinite(Number(head))) return;

      if (lastScanned === 0) lastScanned = Math.max(0, head - lookbackBlocks);
      const from = Math.max(0, lastScanned - lookbackBlocks + 1), to = head;

      for (let start = from; start <= to; start += maxRange) {
        const end = Math.min(start + maxRange - 1, to);
        for (const addrChunk of batches(elasticPoolAddrsLower, ADDR_BATCH)) {
          const filter = { address: addrChunk, topics: [SWAP_TOPIC_V3], fromBlock: start, toBlock: end };
          let logs;
          try { logs = await safeGetLogs(filter); }
          catch (e) {
            console.warn(`Elastic getLogs failed [${start}-${end}] (${e?.message || e}). Rotating provider...`);
            provider = rotateProvider(); await sleep(150 + Math.floor(Math.random()*250));
            try { logs = await provider.getLogs(filter); } catch { continue; }
          }
          for (const log of logs || []) {
            const key = `${log.transactionHash}:${log.logIndex}`;
            if (seen.has(key)) continue;
            if (seenCounter >= maxSeen) {
              const prune = Math.floor(maxSeen/2);
              let removed=0; for (const k of seen){ seen.delete(k); if (++removed>=prune) break; }
              seenCounter = seen.size;
            }
            seen.add(key); seenCounter++;
            if (queue.length >= MAX_QUEUE) { const drop = Math.max(1, Math.floor(queue.length * 0.05)); queue.splice(0, drop); }
            queue.push(log); setImmediate(processNext);
          }
        }
      }
      lastScanned = to;
    } catch (e) {
      console.warn('Elastic poll tick error:', e?.message || e);
      provider = rotateProvider();
    } finally { if (!stopped) setTimeout(tick, pollMs); }
  };

  tick();
  return () => { stopped = true; };
}

// ===================== MAIN =====================
process.on('unhandledRejection', (r) => { console.error('[unhandledRejection]', r && (r.stack || r.message || r)); });
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err && (err.stack || err.message || err)); });

(async () => {
  try {
    const ok = await ensureProviderHealthy();
    if (!ok) throw new Error('No healthy RPC provider available after retries.');

    // Resolve Balancer Vault address (routers.json or env)
    let BALANCER_VAULT = null;
    try {
      const poly = routers?.polygon;
      if (poly?.['balancer-vault']?.address && isAddr(poly['balancer-vault'].address)) {
        BALANCER_VAULT = poly['balancer-vault'].address.toLowerCase();
      } else if (routers?.['balancer-vault'] && isAddr(routers['balancer-vault'])) {
        BALANCER_VAULT = routers['balancer-vault'].toLowerCase();
      } else if (process.env.BALANCER_VAULT && isAddr(process.env.BALANCER_VAULT)) {
        BALANCER_VAULT = process.env.BALANCER_VAULT.toLowerCase();
      }
    } catch {}

    // 1) Discover pools from logs (no factories)
    const discovered = await discoverByLogs();

    // Balancer discovery (additive) — keep only 2-token pools
    const balancerPoolIdToAddr = Object.create(null);
    if (BALANCER_VAULT) {
      try {
        const balPools = await balDiscoverPools(BALANCER_VAULT);
        for (const { poolId, poolAddress } of balPools) {
          const info = await balGetPairLikeInfo(BALANCER_VAULT, poolId, poolAddress);
          if (info && info.token0 && info.token1) {
            balancerPoolIdToAddr[(normPoolId(poolId) || poolId)] = poolAddress.toLowerCase();
            discovered.push({ dex: 'balancer-vault', __kind: 'bal', ...info });
          }
        }
      } catch (e) {
        console.warn('Balancer discovery error:', e?.message || e);
      }
    }

    // 2) Liquidity filter via CoinGecko + decimals
    const allTokens = [...new Set(discovered.flatMap(p => [p.token0, p.token1]).filter(isAddr))];
    const prices = await getTokenPrices(allTokens);

    const filteredPools = [];
    for (const p of discovered) {
      try {
        const [dec0, dec1] = await Promise.all([getDecimals(p.token0), getDecimals(p.token1)]);
        const p0 = Number(prices[p.token0?.toLowerCase()]?.usd || 0);
        const p1 = Number(prices[p.token1?.toLowerCase()]?.usd || 0);
        const r0 = toNum(p.reserve0, 0);
        const r1 = toNum(p.reserve1, 0);
        const liq0 = p0 * (r0 / safePow10(dec0));
        const liq1 = p1 * (r1 / safePow10(dec1));
        const liquidityUSD = (Number.isFinite(liq0) ? liq0 : 0) + (Number.isFinite(liq1) ? liq1 : 0);
        if (Number.isFinite(liquidityUSD) && liquidityUSD >= MIN_LIQUIDITY_USD) {
          filteredPools.push({ ...p, decimals0: dec0, decimals1: dec1 });
        }
      } catch {}
    }

    // 3) Index
    const poolsByPairKey = Object.create(null);
    const poolsByAddr    = Object.create(null);
    const poolsByToken   = Object.create(null);
    for (const p of filteredPools) {
      const key = pairKey(p.token0, p.token1);
      (poolsByPairKey[key] ||= []).push(p);
      poolsByAddr[p.pairAddr.toLowerCase()] = p;
      (poolsByToken[p.token0] ||= []).push(p);
      (poolsByToken[p.token1] ||= []).push(p);
    }

    // Address lists by style
    const v2AddrList = Object.keys(poolsByAddr).filter(a => (poolsByAddr[a].__kind || '').toLowerCase() === 'v2');
    const v3AddrList = Object.keys(poolsByAddr).filter(a => (poolsByAddr[a].__kind || '').toLowerCase() === 'v3');

    // 4) Start pollers
    const stopPollV2 = startSwapPollV2(v2AddrList, poolsByAddr, poolsByPairKey, poolsByToken, ARB_THRESHOLD, {
      pollMs: POLL_MS, lookbackBlocks: LOOKBACK_BLOCKS, maxRange: MAX_RANGE, addrBatch: ADDR_BATCH, maxSeen: MAX_SEEN
    });
    const stopPollElastic = startSwapPollElastic(v3AddrList, poolsByAddr, poolsByPairKey, poolsByToken, ARB_THRESHOLD, {
      pollMs: POLL_MS, lookbackBlocks: LOOKBACK_BLOCKS, maxRange: MAX_RANGE, addrBatch: ADDR_BATCH, maxSeen: MAX_SEEN
    });

    // Balancer poller (if discovered any)
    let stopPollBal = null;
    if (BALANCER_VAULT && Object.keys(balancerPoolIdToAddr).length > 0) {
      stopPollBal = startSwapPollBalancer(BALANCER_VAULT, balancerPoolIdToAddr, poolsByAddr, poolsByPairKey, poolsByToken, ARB_THRESHOLD, {
        pollMs: POLL_MS, lookbackBlocks: LOOKBACK_BLOCKS, maxRange: MAX_RANGE, maxSeen: MAX_SEEN
      });
    }

    // 5) Offline direct + tri arbs (unchanged)
    const directArbs = [];
    for (let i = 0; i < filteredPools.length; i++) {
      for (let j = i + 1; j < filteredPools.length; j++) {
        const A = filteredPools[i], B = filteredPools[j];
        const samePair = (A.token0 === B.token0 && A.token1 === B.token1) || (A.token0 === B.token1 && A.token1 === B.token0);
        if (!samePair) continue;

        const [base, quote] = pairKey(A.token0, A.token1).split('|');
        const priceA = priceFor(A, base, quote);
        const priceB = priceFor(B, base, quote);
        const edge = estimateDirectEdge(priceA, priceB);
        if (edge <= 0) continue;

        const est = edgeToProfitUSD(edge);
        if (est >= MIN_PROFIT_USD) {
          directArbs.push({
            token0: base, token1: quote,
            dexA: A.dex, dexB: B.dex,
            routerA: dexToRouter(A.dex), routerB: dexToRouter(B.dex),
            styleA: A.__kind || 'v2', styleB: B.__kind || 'v2',
            feeA: null, feeB: null,
            priceA, priceB, poolAddrA: A.pairAddr, poolAddrB: B.pairAddr,
            edge, estProfitUSD: est
          });
        }
      }
    }

    const triArbs = [];
    const poolsByTokenScan = Object.create(null);
    for (const pool of filteredPools) {
      (poolsByTokenScan[pool.token0] ||= []).push(pool);
      (poolsByTokenScan[pool.token1] ||= []).push(pool);
    }
    for (const tokenA of Object.keys(poolsByTokenScan)) {
      for (const p1 of poolsByTokenScan[tokenA]) {
        const tokenB = p1.token0 === tokenA ? p1.token1 : p1.token0;
        for (const p2 of (poolsByTokenScan[tokenB] || [])) {
          const tokenC = p2.token0 === tokenB ? p2.token1 : p2.token0;
          if (tokenC === tokenA) continue;
          for (const p3 of (poolsByTokenScan[tokenC] || [])) {
            const closes = (p3.token0 === tokenC && p3.token1 === tokenA) || (p3.token1 === tokenC && p3.token0 === tokenA);
            if (!closes) continue;

            const cycleRate = rateFor(p1, tokenA, tokenB) * rateFor(p2, tokenB, tokenC) * rateFor(p3, tokenC, tokenA);
            const edge = estimateTriEdge(cycleRate);
            if (edge <= 0) continue;

            const est = edgeToProfitUSD(edge);
            if (est >= MIN_PROFIT_USD) {
              triArbs.push({
                route: [tokenA, tokenB, tokenC, tokenA],
                pools: [p1.pairAddr, p2.pairAddr, p3.pairAddr],
                dexs:  [p1.dex,      p2.dex,      p3.dex],
                routers: [dexToRouter(p1.dex), dexToRouter(p2.dex), dexToRouter(p3.dex)],
                styles:  [p1.__kind || 'v2', p2.__kind || 'v2', p3.__kind || 'v2'],
                fees: [null, null, null],
                cycleRate, edge, estProfitUSD: est
              });
            }
          }
        }
      }
    }

    directArbs.sort((a,b)=>b.estProfitUSD-a.estProfitUSD);
    triArbs.sort((a,b)=>b.estProfitUSD-a.estProfitUSD);
    writeJsonAtomic('direct_pool.json', directArbs);
    writeJsonAtomic('tri_pool.json',    triArbs);
    console.log(`Saved ${directArbs.length} direct and ${triArbs.length} triangular arbs (≥ $${MIN_PROFIT_USD})`);

    // Graceful stop
    let shuttingDown = false;
    const shutdown = async (code = 0) => {
      if (shuttingDown) return; shuttingDown = true;
      console.log('[shutdown] Flushing…');
      try {
        writeJsonAtomic('direct_pool.json', directArbs);
        writeJsonAtomic('tri_pool.json',    triArbs);
        if (typeof stopPollV2 === 'function')    { try { stopPollV2(); } catch {} }
        if (typeof stopPollElastic === 'function'){ try { stopPollElastic(); } catch {} }
        if (typeof stopPollBal === 'function')   { try { stopPollBal(); } catch {} }
      } catch (e) { console.error('[shutdown] error:', e?.message || e); }
      setTimeout(() => process.exit(code), 250);
    };
    process.on('SIGINT',  () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));

  } catch (fatal) {
    console.error('Fatal error in poolfetcher:', fatal?.message || fatal);
    process.exitCode = 1;
  }
})();
