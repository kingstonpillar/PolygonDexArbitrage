// hybridsimulationbot.js — Ethers v6, 15 logics intact (NO WebSockets)
// READS: dataprovider.js (getReadProvider, rotateProvider, ensurePolygonNetwork)
// SENDS: private RPCs only (Rubic → Merkle → GetBlock), raw-tx submission

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import sendAlert from './telegramalert.js';
import protectionUtilities from './protectionutilities.js';

// ---- use YOUR data provider for all on-chain reads
import {
  getReadProvider,
  rotateProvider,
  ensurePolygonNetwork,
  getProvider as getCurrentReadProvider,
} from './dataprovider.js';

dotenv.config();
console.log('[ETHERS]', ethers.version);

// ===========================================================
// RPC Concurrency Limiter
// ===========================================================
const MAX_CONCURRENT_REQUESTS = 4;
const __rpcQueue = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function safeRpcCall(fn) {
  while (__rpcQueue.length >= MAX_CONCURRENT_REQUESTS) {
    await delay(50);
  }
  __rpcQueue.push(1);
  try {
    return await fn();
  } finally {
    __rpcQueue.pop();
  }
}

// ---------- Single-flight guard ----------
let __processing = false;

// ---------- JSON helpers ----------
function loadJson(filePath) {
  try {
    const abs = path.resolve(filePath);
    return JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (err) {
    console.error(`❌ Failed to load JSON: ${filePath}`, err.message);
    return null;
  }
}

// Load ABIs
const aaveABI = loadJson('./aaveABI.json');
const balancerABI = loadJson('./balancerABI.json');
if (!aaveABI) throw new Error('❌ Failed to load Aave ABI.');
if (!balancerABI) throw new Error('❌ Failed to load Balancer ABI.');

// ===========================================================
// 0) Run updateconfig.js safely
// ===========================================================
(async () => {
  try {
    const updater = await import('./updateconfig.js');
    if (typeof updater.default === 'function') {
      console.log('[INIT] Running updateconfig.js...');
      await updater.default();
      console.log('[INIT] updateconfig.js finished.');
    } else {
      console.log('[INIT] updateconfig.js found but no default export. Skipping.');
    }
  } catch (e) {
    console.warn('[INIT] No updateconfig.js or failed to run. Reason:', e.message);
  }
})();

// ===========================================================
// 1) Constants & Env
// ===========================================================
const CHAIN_ID = Number(process.env.CHAIN_ID || '137');
const PROFIT_USD = Number(process.env.PROFIT_THRESHOLD_USD || '40');
const BOT_INTERVAL_MS = Number(process.env.BOT_INTERVAL_MS || '5000');
const MAX_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || '50');

if (!process.env.AAVE_FLASHLOAN_CONTRACT) throw new Error('AAVE_FLASHLOAN_CONTRACT env missing');
if (!process.env.BALANCER_FLASHLOAN_CONTRACT) throw new Error('BALANCER_FLASHLOAN_CONTRACT env missing');

const TOKENLIST_PATH = path.join(process.cwd(), 'tokenlist.json');

// ===========================================================
// 2) Providers (READS via dataprovider, SENDS via private RPCs)
// ===========================================================
const RUBIC_RPC_URL = process.env.RUBIC_RPC_URL || 'https://rubic-polygon.rpc.blxrbdn.com';
const MERKLE_RPC_URL = process.env.MERKLE_RPC_URL || 'https://polygon.merkle.io/';
const GETBLOCK_RPC_URL = process.env.GETBLOCK_RPC_URL || 'https://go.getblock.us/...';

let baseProvider = await getReadProvider();
await ensurePolygonNetwork(baseProvider);

// ===========================================================
// 3) Block listener
// ===========================================================
function listenForBlocks() {
  let activeProvider = baseProvider;
  let lastProcessedBlock = 0;

  const onBlock = async (blockNumber) => {
    if (blockNumber <= lastProcessedBlock) return;
    lastProcessedBlock = blockNumber;

    console.log('⛓️ New block (HTTP via dataprovider):', blockNumber);
    try {
      await safeRpcCall(() => processTransactions());
    } catch (e) {
      console.error('❌ processTransactions error from block feed:', e.message);
      if (/(rate|limit|timeout|429|temporarily unavailable|ECONNRESET|ETIMEDOUT)/i.test(String(e?.message))) {
        try {
          rotateProvider('block-feed error');
          activeProvider.off?.('block', onBlock);
          baseProvider = getCurrentReadProvider();
          await ensurePolygonNetwork(baseProvider).catch(() => {});
          activeProvider = baseProvider;
          activeProvider.on?.('block', onBlock);
          console.warn('[PROVIDER] Rotated READ RPC & reattached block listener');
        } catch {}
      }
    }
  };

  try {
    activeProvider.on('block', onBlock);
    return () => {
      try {
        activeProvider.off('block', onBlock);
      } catch {}
    };
  } catch (err) {
    console.error('[BLOCK_FEED] Failed to attach block listener:', err.message);
    return null;
  }
}

// ===========================================================
// 4) Wallet & Contracts
// ===========================================================
const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').trim();
let wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, baseProvider) : null;
if (wallet) console.log(`[BOT] Wallet loaded: ${wallet.address}`);

const aaveContract = new ethers.Contract(
  process.env.AAVE_FLASHLOAN_CONTRACT,
  aaveABI,
  wallet || baseProvider
);
const balancerContract = new ethers.Contract(
  process.env.BALANCER_FLASHLOAN_CONTRACT,
  balancerABI,
  wallet || baseProvider
);

// Nonce manager
let __nextNonce = null;
let __nonceLock = Promise.resolve();
async function getNextNonce() {
  if (!wallet) throw new Error('Wallet required for nonce');
  let release;
  const prev = __nonceLock;
  __nonceLock = new Promise((r) => (release = r));
  await prev;
  try {
    if (__nextNonce === null) {
      __nextNonce = await safeRpcCall(() => wallet.getNonce('pending'));
    }
    const n = __nextNonce;
    __nextNonce = n + 1;
    return n;
  } finally {
    release();
  }
}

// ===========================================================
// 5) Decimals helper & 5.75 Token Meta
// ===========================================================
const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
async function getTokenDecimals(provider = baseProvider, tokenAddress) {
  if (!tokenAddress || tokenAddress === ethers.ZeroAddress) return 18;
  try {
    const erc = new ethers.Contract(tokenAddress, ERC20_DECIMALS_ABI, provider);
    return await safeRpcCall(() => erc.decimals());
  } catch {
    return 18;
  }
}

const ERC20_META_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

const tokenMetaCache = new Map();
const persistQueue = new Map();
let persistTimer = null;
const PERSIST_DEBOUNCE_MS = 2000;

const k = (addr) => (typeof addr === 'string' ? addr.toLowerCase() : addr);

function normalizeEntry(t) {
  const address = k(t?.address || t?.addr || t?.token || t?.contract);
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const decimals =
    t?.decimals != null ? Number(t.decimals) : t?.decimal != null ? Number(t.decimal) : undefined;
  const symbol = t?.symbol || t?.ticker || undefined;
  const name = t?.name || undefined;
  return { address, decimals, symbol, name };
}

async function fetchTokenMetaOnChain(provider = baseProvider, address) {
  const addrLc = k(address);
  if (!addrLc || !/^0x[0-9a-fA-F]{40}$/.test(addrLc)) return null;
  if (tokenMetaCache.has(addrLc)) return tokenMetaCache.get(addrLc);

  try {
    const erc = new ethers.Contract(addrLc, ERC20_META_ABI, provider);
    const [dec, sym, nm] = await Promise.allSettled([
      safeRpcCall(() => erc.decimals()),
      safeRpcCall(() => erc.symbol()),
      safeRpcCall(() => erc.name()),
    ]);
    const meta = {
      address: addrLc,
      decimals: dec.status === 'fulfilled' ? Number(dec.value) : 18,
      symbol: sym.status === 'fulfilled' ? String(sym.value) : 'TKN',
      name: nm.status === 'fulfilled' ? String(nm.value) : 'Token',
    };
    tokenMetaCache.set(addrLc, meta);
    return meta;
  } catch {
    const meta = { address: addrLc, decimals: 18, symbol: 'TKN', name: 'Token' };
    tokenMetaCache.set(addrLc, meta);
    return meta;
  }
}

function queuePersistToken(meta) {
  const m = normalizeEntry(meta);
  if (!m) return;
  if (!persistQueue.has(m.address)) {
    persistQueue.set(m.address, m);
    schedulePersist();
  } else {
    const old = persistQueue.get(m.address);
    persistQueue.set(m.address, {
      address: m.address,
      decimals: old.decimals ?? m.decimals,
      symbol: old.symbol ?? m.symbol,
      name: old.name ?? m.name,
    });
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    try {
      const pending = Array.from(persistQueue.values());
      persistQueue.clear();
      if (!pending.length) return;
      let current = readTokenlistFile().map(normalizeEntry).filter(Boolean);
      for (const meta of pending) current = mergeTokenIntoList(current, meta);
      writeTokenlistFileSafely(current);
    } finally {
      persistTimer = null;
    }
  }, PERSIST_DEBOUNCE_MS);
}

function asArrayMaybe(list) {
  if (!list) return [];
  if (Array.isArray(list)) return list;
  if (typeof list === 'object') return Object.values(list);
  return [];
}

async function enrichTokenListForPool(provider = baseProvider, baseTokenList, pool) {
  const baseArr = asArrayMaybe(baseTokenList);
  const seen = new Set(
    baseArr.map((t) => k(t?.address || t?.addr || t?.token || t?.contract)).filter(Boolean)
  );
  const out = baseArr.map(normalizeEntry).filter(Boolean);
  const poolTokens = [pool?.token0, pool?.token1, pool?.token2, pool?.loanAsset]
    .filter(Boolean)
    .map(k);

  for (const addr of poolTokens) {
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
    if (seen.has(addr)) continue;
    const meta = await fetchTokenMetaOnChain(provider, addr);
    if (meta && meta.address) {
      out.push(meta);
      seen.add(addr);
      queuePersistToken(meta);
    }
  }
  return out;
}

// ===========================================================
// Tokenlist file helpers
// ===========================================================
function readTokenlistFile() {
  try {
    if (!fs.existsSync(TOKENLIST_PATH)) return [];
    const raw = fs.readFileSync(TOKENLIST_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeTokenIntoList(list, meta) {
  const idx = list.findIndex((t) => k(t.address) === k(meta.address));
  if (idx === -1) return [...list, meta];
  const cur = list[idx] || {};
  const merged = {
    address: k(meta.address),
    decimals: meta.decimals ?? cur.decimals ?? 18,
    symbol: meta.symbol ?? cur.symbol ?? 'TKN',
    name: meta.name ?? cur.name ?? 'Token',
  };
  const next = list.slice();
  next[idx] = merged;
  return next;
}

function writeTokenlistFileSafely(list) {
  const tmp = `${TOKENLIST_PATH}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, TOKENLIST_PATH);
}

// ===========================================================
// 6) Process Transactions (with reserveTradeCheck added)
// ===========================================================
async function processTransactions() {
  if (__processing) return;
  __processing = true;
  try {
    const { routers, tokenList, priceFeeds, directPools, triPools } = loadAllConfigsFresh();
    const allPools = [...directPools, ...triPools];

    for (const pool of allPools) {
      const enrichedTokenList = await enrichTokenListForPool(baseProvider, tokenList, pool);
      const steps = buildSteps(pool, routers, enrichedTokenList, priceFeeds);
      if (!Array.isArray(steps) || steps.length === 0) {
        await emitTradeAlert('skip', pool, `Router mismatch`, { reason: 'router_mismatch' });
        continue;
      }

      // --- Reserve Trade Check (additional)
      if (pool.pairAddress || pool.poolAddress) {
        const reserveCheck = await protectionUtilities.reserveTradeCheck({
          provider: baseProvider,
          poolType: pool._type === 0 ? 'V2' : 'V3',
          pairAddress: pool.pairAddress || null,
          poolAddress: pool.poolAddress || null,
          tokenIn: pool.token0,
          desiredAmount: 1000n,
          slippagePercent: 1,
        });
        if (!reserveCheck.ok) {
          await emitTradeAlert('skip', pool, `Reserve trade check failed`, { reason: 'reserve_check' });
          continue;
        }
      }

      // ---- Construct protection params
      const tradeId = deriveTradeId(pool);
      const loanDec = await getTokenDecimals(baseProvider, pool.loanAsset);
      const loanAmountWei = ethers.parseUnits(String(pool.amount || 0), loanDec);
      const minOutWei = calcMinOut(pool.amount);
      const expectedOutWei = (minOutWei * 10000n) / BigInt(10000 - MAX_SLIPPAGE_BPS);

      const prot = await protectionUtilities.runProtections({
        routeKey: tradeId,
        expectedOut: expectedOutWei,
        minOut: minOutWei,
        txRequest: wallet ? { from: wallet.address } : {},
        profitUsd: undefined,
        notionalUsd: undefined,
        profitToken: pool.loanAsset,
        profitAmountWei: loanAmountWei,
        notionalToken: pool.loanAsset,
        notionalAmountWei: loanAmountWei,
        feedMap: priceFeeds,
        wallet: wallet?.address || ethers.ZeroAddress,
        v2PairAddr: null,
        v3PoolAddr: null,
        fallbackTokens: [],
        neededBalance: undefined,
        flashCandidates: [],
      });

      if (!prot.ok) {
        await emitTradeAlert('skip', pool, `Protections failed`, { reason: prot.reason });
        continue;
      }

      const estProfit = Number(prot?.details?.pt?.profitUsd ?? 0);
      if (estProfit < PROFIT_USD) {
        await emitTradeAlert('skip', pool, `Low profit`, {
          reason: 'low_profit',
          estProfitUsd: estProfit.toFixed(2),
          thresholdUsd: PROFIT_USD,
        });
        continue;
      }

      const params = { loanAsset: pool.loanAsset, loanAmount: loanAmountWei, steps };
      await executeWithPrivateSends(params, pool, estProfit);
    }
  } catch (e) {
    console.error('❌ processTransactions error:', e.message);
    if (/(rate|limit|timeout|429|temporarily unavailable|ECONNRESET|ETIMEDOUT)/i.test(String(e?.message))) {
      try {
        rotateProvider('processTransactions error');
        baseProvider = getCurrentReadProvider();
      } catch {}
    }
  } finally {
    __processing = false;
  }
}

// ===========================================================
// 7) Load configs (normalize + freeze)
// ===========================================================
function isAddrStrict(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

function normalizeRouters(json) {
  if (!json) return {};
  if (Array.isArray(json?.polygon)) {
    const m = {};
    for (const it of json.polygon) {
      if (it?.name && isAddrStrict(it?.router)) m[it.name] = it.router;
    }
    return m;
  }
  const m = {};
  for (const [k, v] of Object.entries(json)) {
    if (isAddrStrict(v)) m[k] = v;
  }
  return m;
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj)) deepFreeze(v);
  return obj;
}

function safeRequireJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), file), 'utf-8'));
  } catch {
    return null;
  }
}

function loadAllConfigsFresh() {
  const routersRaw = safeRequireJson('./routers.json') || {};
  const tokenList = safeRequireJson('./tokenlist.json') || [];
  const priceFeeds = safeRequireJson('./chainlinkpricefeed.json') || {};
  const directPools = safeRequireJson('./direct_pool.json') || [];
  const triPools = safeRequireJson('./tri_pool.json') || [];

  const routers = normalizeRouters(routersRaw);

  return {
    routers: deepFreeze(routers),
    tokenList: deepFreeze(tokenList),
    priceFeeds: deepFreeze(priceFeeds),
    directPools,
    triPools,
  };
}

// ===========================================================
// 8) Build Steps
// ===========================================================
function buildSteps(pool, routers, _tokenList, _priceFeeds) {
  const steps = [];
  const minOut = calcMinOut(pool.amount);

  const getRouter = (nameOrAddr) => {
    if (!nameOrAddr) return null;
    const addr = routers[nameOrAddr] || nameOrAddr;
    if (!isAddrStrict(addr)) return null;
    return addr;
  };

  if (pool._type === 0) {
    const r1 = getRouter(pool.router);
    const r2 = getRouter(pool.routerBack);
    if (!r1 || !r2) return [];

    steps.push({
      kind: 0,
      router: r1,
      path: [pool.token0, pool.token1],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut,
    });
    steps.push({
      kind: 0,
      router: r2,
      path: [pool.token1, pool.token0],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut,
    });
  } else {
    const rA = getRouter(pool.routerA);
    const rB = getRouter(pool.routerB);
    const rC = getRouter(pool.routerC);
    if (!rA || !rB || !rC) return [];

    steps.push({
      kind: 0,
      router: rA,
      path: [pool.token0, pool.token1],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut,
    });
    steps.push({
      kind: 0,
      router: rB,
      path: [pool.token1, pool.token2],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut,
    });
    steps.push({
      kind: 0,
      router: rC,
      path: [pool.token2, pool.token0],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut,
    });
  }
  return steps;
}

// ===========================================================
// 9) Slippage calculation
// ===========================================================
function calcMinOut(amount) {
  const amt = ethers.parseUnits(amount.toString(), 18);
  const slippage = BigInt(10000 - MAX_SLIPPAGE_BPS);
  return (amt * slippage) / 10000n;
}

// ===========================================================
// 10) Execute with private RPC fallback (send only)
// ===========================================================
async function executeWithPrivateSends(params, pool, estProfit) {
  if (!wallet) return console.error('❌ Wallet required for sending TXs');

  let txAave, txBal;

  async function shouldSkipForGas(txReq, profitEst) {
    try {
      const gasLimit = await safeRpcCall(() =>
        baseProvider.estimateGas({ ...txReq, from: wallet.address })
      );
      const feeData = await safeRpcCall(() => baseProvider.getFeeData());
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const gasCostWei = BigInt(gasLimit) * gasPrice;
      const gasEth = Number(ethers.formatUnits(gasCostWei, 18));
      const priceUsd = Number(process.env.MATIC_PRICE_USD || process.env.ETH_PRICE_USD || '2500');
      const gasCostUsd = gasEth * priceUsd;
      console.log(
        `⛽ Gas: ${gasLimit} | Cost ≈ $${gasCostUsd.toFixed(2)} | Profit ≈ $${profitEst.toFixed(2)}`
      );
      return gasCostUsd > profitEst;
    } catch {
      return false;
    }
  }

  try {
    const txAReq = await aaveContract.populateTransaction.executeArbitrage(params);
    txAReq.chainId ??= CHAIN_ID;

    if (await shouldSkipForGas(txAReq, estProfit)) {
      await emitTradeAlert('skip', pool, `Aave gas>profit | Pool: ${pool.token0}→${pool.token1}`, {
        venue: 'Aave',
        reason: 'gas_gt_profit',
      });
    } else {
      const n = await getNextNonce();
      txAReq.nonce = n;

      txAave = await sendWithRpcFallback(txAReq, n);
      if (txAave?.wait) await txAave.wait();
      await emitTradeAlert('successful', pool, `Aave executed`, {
        venue: 'Aave',
        profitUsd: estProfit.toFixed(2),
        txHash: txAave?.hash ?? 'submitted',
      });
    }
  } catch (e) {
    await emitTradeAlert('fail', pool, `Aave failed | ${e.message}`, { venue: 'Aave' });
  }

  try {
    const txBReq = await balancerContract.populateTransaction.executeArbitrage(params);
    txBReq.chainId ??= CHAIN_ID;

    if (await shouldSkipForGas(txBReq, estProfit)) {
      await emitTradeAlert(
        'skip',
        pool,
        `Balancer gas>profit | Pool: ${pool.token0}→${pool.token1}`,
        { venue: 'Balancer', reason: 'gas_gt_profit' }
      );
    } else {
      const n = await getNextNonce();
      txBReq.nonce = n;

      txBal = await sendWithRpcFallback(txBReq, n);
      if (txBal?.wait) await txBal.wait();
      await emitTradeAlert('successful', pool, `Balancer executed`, {
        venue: 'Balancer',
        profitUsd: estProfit.toFixed(2),
        txHash: txBal?.hash ?? 'submitted',
      });
    }
  } catch (e) {
    await emitTradeAlert('fail', pool, `Balancer failed | ${e.message}`, { venue: 'Balancer' });
  }

  if (!txAave && !txBal) {
    await emitTradeAlert('fail', pool, `Trade failed completely | Pool: ${pool.token0}→${pool.token1}`, {
      reason: 'both_failed',
    });
  } else if (txAave && txBal) {
    await emitTradeAlert('info', pool, `Both venues executed`, { venue: 'compare' });
  }
}

// ===========================================================
// 11) Raw TX send via private RPCs (no reads here)
// ===========================================================
const PRIVATE_RPC_TIMEOUT_MS = Number(process.env.PRIVATE_RPC_TIMEOUT_MS || 5000);

async function sendWithRpcFallback(txReq, nonce) {
  if (!wallet) throw new Error('Wallet required');

  txReq.chainId ??= CHAIN_ID;
  txReq.nonce ??= nonce;

  const populated = await wallet.populateTransaction({ ...txReq });
  const signedRaw = await wallet.signTransaction(populated);

  const order = [
    { name: 'Rubic', url: RUBIC_RPC_URL },
    { name: 'Merkle', url: MERKLE_RPC_URL },
    { name: 'GetBlock', url: GETBLOCK_RPC_URL },
  ];

  let lastError = null;

  for (const item of order) {
    try {
      const prov = new ethers.JsonRpcProvider(item.url, { name: 'polygon', chainId: CHAIN_ID });
      const txHash = await sendRawWithTimeout(prov, signedRaw, PRIVATE_RPC_TIMEOUT_MS);
      console.log(`🚀 Sent via ${item.name}: ${txHash}`);
      return {
        hash: txHash,
        wait: async (confirms = 1) =>
          safeRpcCall(() => baseProvider.waitForTransaction(txHash, confirms)),
      };
    } catch (e) {
      lastError = e;
      console.warn(`⚠️ ${item.name} send failed: ${e?.message || e}`);
    }
  }

  throw new Error(`All private RPC sends failed. Last error: ${lastError?.message ?? 'unknown'}`);
}

async function sendRawWithTimeout(provider, signedRaw, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`send timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    provider
      .send('eth_sendRawTransaction', [signedRaw])
      .then((txHash) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(txHash);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const msg = String(err?.message || err);
        if (msg.includes('already known') || msg.includes('nonce too low')) {
          try {
            const maybeHash = /0x[0-9a-fA-F]{64}/.exec(msg)?.[0];
            if (maybeHash) return resolve(maybeHash);
          } catch {}
        }
        reject(err);
      });
  });
}

// ===========================================================
// 12) Alerts
// ===========================================================
async function emitTradeAlert(status, pool, message, extra = {}) {
  const payload = {
    status,
    message,
    pool: {
      type: pool?._type,
      token0: pool?.token0,
      token1: pool?.token1,
      token2: pool?.token2,
      router: pool?.router || pool?.routerA,
    },
    ...extra,
  };
  try {
    await sendAlert(payload);
  } catch (e) {
    console.warn('[ALERT] Failed to send:', e?.message || e);
  }
}

function deriveTradeId(pool) {
  try {
    const raw = JSON.stringify({
      t: pool?._type,
      a: pool?.token0,
      b: pool?.token1,
      c: pool?.token2,
      rA: pool?.router || pool?.routerA,
      rB: pool?.routerBack || pool?.routerB,
      rC: pool?.routerC,
    });
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  } catch {
    return crypto.randomBytes(8).toString('hex');
  }
}

// ===========================================================
// 13) Start bot
// ===========================================================
console.log(
  '[BOT] hybridSimulationBot running (Reads via dataprovider; Sends via private RPCs; NO WebSockets)'
);
const stopFeed = listenForBlocks();
setInterval(() => safeRpcCall(() => processTransactions()), BOT_INTERVAL_MS);
