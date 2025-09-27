// protectionutilities.js
// Utilities for risk checks, gas, balances, v2/v3 state, and composed guard.

import 'dotenv/config';
import fs from 'fs';
import { ethers } from 'ethers';

import { getReadProvider, rotateProvider } from './dataprovider.js';

// ---- RPC limiter hook (injected by caller) ----
let __rpcLimiter = null;
/** Caller can inject a limiter with the signature: (fn: () => Promise<any>) => Promise<any> */
export function setRpcLimiter(fn) {
  __rpcLimiter = (typeof fn === 'function') ? fn : null;
}
async function execWithLimiter(exec) {
  return __rpcLimiter ? __rpcLimiter(exec) : exec();
}

// ---------- ENV CONFIG ----------
const PROFIT_THRESHOLD_BPS     = Number(process.env.PROFIT_THRESHOLD_BPS || 100); // 1% default
const PROFIT_THRESHOLD_USD     = Number(process.env.PROFIT_THRESHOLD_USD || 0);
const COOLDOWN_MS              = Number(process.env.COOLDOWN_MS || 3000);

const MAX_SLIPPAGE_BPS         = Number(process.env.MAX_SLIPPAGE_BPS || 100);
const HIGH_GAS_WEI             = ethers.parseUnits(process.env.HIGH_GAS_GWEI || '300', 'gwei');
const GAS_LIMIT_MAX            = BigInt(process.env.GAS_LIMIT_MAX || '2000000');
const GAS_PRICE_TIMEOUT_MS     = Number(process.env.GAS_PRICE_TIMEOUT_MS || 1200);
const ESTIMATE_GAS_TIMEOUT_MS  = Number(process.env.ESTIMATE_GAS_TIMEOUT_MS || 1800);

const MEV_FILE                 = process.env.MEV_FILE || './mev_queue.json';
const MEV_LOOKBACK_MS          = Number(process.env.MEV_LOOKBACK_MS || 10_000);
const CHAINLINK_STALE_SECONDS  = Number(process.env.CHAINLINK_STALE_SECONDS || 180);

// ---------- READ HELPERS ----------
function withTimeout(promise, ms, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);
}
async function readFailover(reason = 'readCall_error') {
  try { rotateProvider(reason); } catch {}
  await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 160)));
}
async function readCall(label, fn, timeoutMs) {
  let provider = await getReadProvider();
  try {
    return await withTimeout(execWithLimiter(() => fn(provider)), timeoutMs ?? 1500, `${label}_timeout`);
  } catch (_) {
    await readFailover(label);
    provider = await getReadProvider();
    return await withTimeout(execWithLimiter(() => fn(provider)), timeoutMs ?? 1500, `${label}_timeout_retry`);
  }
}
async function readCallWithProvider(label, provider, fn, timeoutMs) {
  try {
    return await withTimeout(execWithLimiter(() => fn(provider)), timeoutMs ?? 1500, `${label}_timeout`);
  } catch (_) {
    await readFailover(label);
    const p2 = await getReadProvider();
    return await withTimeout(execWithLimiter(() => fn(p2)), timeoutMs ?? 1500, `${label}_timeout_retry`);
  }
}

// ---------- FLASH-LOAN TOKEN FALLBACK CONFIG ----------
const FLASH_FALLBACK_TOKENS = (process.env.FLASH_FALLBACK_TOKENS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function _resolveFlashFallbackTokens(runtimeList) {
  const list = (runtimeList && runtimeList.length ? runtimeList : FLASH_FALLBACK_TOKENS);
  return list.slice(0, 5);
}

// ---------- ABIs ----------
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)'
];
const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];
const V3_POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];
const AGG_V3_ABI = [
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
];

// ---------- STATE ----------
const lastActionAt = new Map();

// ============= PROTECTIONS =============

// 1) SLIPPAGE
export const validateSlippage = (expectedOut, minOut) => {
  if (expectedOut <= 0n) {
    return { ok: false, slippageBps: 10000, maxSlippageBps: MAX_SLIPPAGE_BPS, reason: 'expectedOut<=0' };
  }
  if (minOut > expectedOut) {
    return { ok: false, slippageBps: 10000, maxSlippageBps: MAX_SLIPPAGE_BPS, reason: 'minOut>expectedOut' };
  }
  const diff = expectedOut - minOut; // >= 0n
  const slippageBps = Number((diff * 10000n) / expectedOut);
  return { ok: slippageBps <= MAX_SLIPPAGE_BPS, slippageBps, maxSlippageBps: MAX_SLIPPAGE_BPS };
};

// 2) GAS (EIP-1559 aware)
export const assessGas = async (txRequest) => {
  // Get fee data (legacy + EIP-1559)
  const fee = await readCall(
    'feeData',
    async p => {
      const fd = await p.getFeeData();
      return {
        gasPrice: txRequest?.gasPrice ?? fd.gasPrice ?? null,
        maxFeePerGas: txRequest?.maxFeePerGas ?? fd.maxFeePerGas ?? null,
        maxPriorityFeePerGas: txRequest?.maxPriorityFeePerGas ?? fd.maxPriorityFeePerGas ?? null,
      };
    },
    GAS_PRICE_TIMEOUT_MS
  ).catch(() => null);

  if (!fee) return { ok: false, reason: 'feeDataNull' };

  const using1559 = fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null;

  if (!using1559 && fee.gasPrice == null) {
    return { ok: false, reason: 'noGasPriceAndNo1559' };
  }

  if (using1559) {
    try {
      const mfp = typeof fee.maxFeePerGas === 'bigint' ? fee.maxFeePerGas : BigInt(fee.maxFeePerGas);
      if (mfp > HIGH_GAS_WEI) return { ok: false, reason: 'maxFeePerGasTooHigh', maxFeePerGas: mfp };
    } catch {
      return { ok: false, reason: 'maxFeePerGasCastError' };
    }
  } else {
    try {
      const gp = typeof fee.gasPrice === 'bigint' ? fee.gasPrice : BigInt(fee.gasPrice);
      if (gp > HIGH_GAS_WEI) return { ok: false, reason: 'gasPriceTooHigh', gasPrice: gp };
    } catch {
      return { ok: false, reason: 'gasPriceCastError' };
    }
  }

  // Estimate gas (caller should set txRequest.from)
  const gasLimit = await readCall(
    'estimateGas',
    p => p.estimateGas(txRequest),
    ESTIMATE_GAS_TIMEOUT_MS
  ).catch(() => 0n);

  if (gasLimit === 0n) return { ok: false, reason: 'gasEstimationFailed', hint: 'Ensure txRequest.from/to/data/value are set and valid' };
  if (gasLimit > GAS_LIMIT_MAX) return { ok: false, reason: 'gasLimitTooHigh', gasLimit };

  return { ok: true, gasLimit, ...(using1559 ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas } : { gasPrice: fee.gasPrice }) };
};

// Small helper to evaluate profit thresholds (USD + relative bps)
export function meetsProfitThresholdUSD(profitUsd, notionalUsd) {
  const notional = Number(notionalUsd || 0);
  const profit = Number(profitUsd || 0);
  if (!Number.isFinite(profit) || !Number.isFinite(notional)) {
    return { ok: false, reason: 'invalidInputs' };
  }
  const passUsd = profit >= PROFIT_THRESHOLD_USD;
  const profitBps = notional > 0 ? Math.floor((profit / notional) * 10000) : 0;
  const passBps = profitBps >= PROFIT_THRESHOLD_BPS;
  return { ok: passUsd && passBps, profitUsd: profit, notionalUsd: notional, profitBps, thresholdBps: PROFIT_THRESHOLD_BPS, thresholdUsd: PROFIT_THRESHOLD_USD };
}

// 3) PROFIT THRESHOLD via CHAINLINK feeds (with stale/zero guards)
export const meetsProfitThresholdUSD_Chainlink = async (provider, {
  profitToken, profitAmountWei, notionalToken, notionalAmountWei, feedMap
}) => {
  try {
    async function fetchPrice(token) {
      const feedAddr = feedMap?.[token];
      if (!feedAddr) return null;
      return await readCallWithProvider(
        `chainlink.latest:${feedAddr}`,
        provider,
        async (p) => {
          const c = new ethers.Contract(feedAddr, AGG_V3_ABI, p);
          const [decRaw, rd] = await Promise.all([
            c.decimals(),
            c.latestRoundData()
          ]);
          const dec = Number(decRaw);
          const answer = Number(rd[1]);
          const updatedAt = Number(rd[3]);

          if (!Number.isFinite(dec) || dec < 0) return null;
          if (!Number.isFinite(answer) || answer <= 0) return null;
          if (CHAINLINK_STALE_SECONDS > 0) {
            const nowS = Math.floor(Date.now() / 1000);
            if (nowS - updatedAt > CHAINLINK_STALE_SECONDS) return null;
          }
          return answer / (10 ** dec);
        },
        GAS_PRICE_TIMEOUT_MS
      ).catch(() => null);
    }

    async function fetchTokenDecimals(token) {
      // Handle native token gracefully
      if (!token || token === ethers.ZeroAddress) return 18;
      return await readCallWithProvider(
        `erc20.decimals:${token}`,
        provider,
        async (p) => {
          try {
            const c = new ethers.Contract(token, ERC20_ABI, p);
            const decRaw = await c.decimals();
            const dec = Number(decRaw);
            return Number.isFinite(dec) ? dec : 18;
          } catch { return 18; }
        },
        1500
      ).catch(() => 18);
    }

    const [profitPrice, notionalPrice, profitDec, notionalDec] = await Promise.all([
      fetchPrice(profitToken),
      fetchPrice(notionalToken),
      fetchTokenDecimals(profitToken),
      fetchTokenDecimals(notionalToken)
    ]);

    if (profitPrice == null || notionalPrice == null) {
      return { ok: false, reason: 'missingOrStaleFeed' };
    }

    const profitUsd   = Number(ethers.formatUnits(profitAmountWei ?? 0n,  profitDec)) * profitPrice;
    const notionalUsd = Number(ethers.formatUnits(notionalAmountWei ?? 0n, notionalDec)) * notionalPrice;

    return meetsProfitThresholdUSD(profitUsd, notionalUsd);
  } catch {
    return { ok: false, reason: 'chainlinkError' };
  }
};

// 4) COOLDOWN
export const enforceCooldown = (key) => {
  const now = Date.now();
  const last = lastActionAt.get(key) || 0;
  if (now - last < COOLDOWN_MS) return { ok: false, msRemaining: COOLDOWN_MS - (now - last) };
  lastActionAt.set(key, now);
  return { ok: true };
};

// 5) FLASHLOAN AVAILABILITY
export const isFlashLoanAvailable = async (candidates = []) => {
  const AAVE_LOAN = (process.env.AAVE_LOAN || 'false').toLowerCase() === 'true';
  const BAL_LOAN  = (process.env.BAL_LOAN || 'false').toLowerCase() === 'true';

  if (!AAVE_LOAN && !BAL_LOAN) {
    return { ok: false, reason: 'loansDisabledInEnv' };
  }

  async function checkBalance(token, addr, needed) {
    return await readCall(
      `erc20.balanceOf:${token}`,
      async p => {
        const bal = await new ethers.Contract(token, ERC20_ABI, p).balanceOf(addr);
        return bal >= BigInt(needed);
      },
      1500
    ).catch(() => false);
  }

  let aaveOk = false;
  let balOk = false;

  if (AAVE_LOAN) {
    const aaveCandidates = candidates.filter(c => c.type === 'aave');
    for (const c of aaveCandidates) {
      if (await checkBalance(c.token, c.addr, c.needed)) { aaveOk = true; break; }
    }
  }

  if (BAL_LOAN) {
    const balCandidates = candidates.filter(c => c.type === 'balancer');
    for (const c of balCandidates) {
      if (await checkBalance(c.token, c.addr, c.needed)) { balOk = true; break; }
    }
  }

  if (aaveOk || balOk) {
    return { ok: true, aave: aaveOk, balancer: balOk };
  } else {
    return { ok: false, reason: 'noLiquidity', aave: aaveOk, balancer: balOk };
  }
};

// 6) FALLBACK TOKEN
export const chooseFallbackToken = async (wallet, tokens, minAmt = 0n) => {
  for (const t of tokens) {
    const res = await readCall(
      `erc20.balanceOf:${t}`,
      p => new ethers.Contract(t, ERC20_ABI, p).balanceOf(wallet),
      1500
    ).catch(() => null);
    if (res && res > minAmt) return { ok: true, token: t, balance: res };
  }
  return { ok: false };
};

// 7) WALLET BALANCE
export const hasWalletBalance = async (wallet, token, needed) => {
  const minRequiredWei = BigInt(needed);
  if (!token || token === ethers.ZeroAddress) {
    const bal = await readCall('getBalance', p => p.getBalance(wallet), 1500).catch(() => null);
    return { ok: bal != null && bal >= minRequiredWei, balance: bal ?? 0n };
  }
  const ercBal = await readCall(
    `erc20.balanceOf:${token}`,
    p => new ethers.Contract(token, ERC20_ABI, p).balanceOf(wallet),
    1500
  ).catch(() => null);
  return { ok: ercBal != null && ercBal >= minRequiredWei, balance: ercBal ?? 0n };
};

// 8) PROFIT LOCK (integer cents to avoid FP drift)
export const lockProfit = (profitUsd, lockPct = 0.75) => {
  if (!Number.isFinite(profitUsd) || profitUsd <= 0) return { locked: 0, leftover: 0 };
  const cents = Math.round(profitUsd * 100);
  const locked = Math.round(cents * lockPct);
  return { locked: locked / 100, leftover: (cents - locked) / 100 };
};

// 9) V2 RESERVES
export const getV2Reserves = async (pair) => {
  const res = await readCall(
    `v2.getReserves:${pair}`,
    async p => {
      const c = new ethers.Contract(pair, V2_PAIR_ABI, p);
      const [t0, t1, reserves] = await Promise.all([c.token0(), c.token1(), c.getReserves()]);
      const [r0, r1, ts] = reserves;
      return { token0: t0, token1: t1, r0, r1, tsLast: Number(ts), ts: Date.now() };
    },
    2000
  ).catch(() => null);
  return res;
};

// 10) V3 STATE (tuple-robust)
export const getV3State = async (pool) => {
  const res = await readCall(
    `v3.slot0:${pool}`,
    async p => {
      const c = new ethers.Contract(pool, V3_POOL_ABI, p);
      const [slot0, liquidity, t0, t1] = await Promise.all([c.slot0(), c.liquidity(), c.token0(), c.token1()]);
      const sqrtPriceX96 = (slot0 && (slot0.sqrtPriceX96 ?? slot0[0])) ?? 0n;
      return { token0: t0, token1: t1, sqrtPriceX96, liquidity, ts: Date.now() };
    },
    2000
  ).catch(() => null);
  return res;
};

// 11) MEV RISK (with pruning)
export const isMEVRisk = () => {
  try {
    if (!fs.existsSync(MEV_FILE)) return { risk: false };
    const raw = fs.readFileSync(MEV_FILE, 'utf-8');
    const q = JSON.parse(raw);
    if (!Array.isArray(q)) return { risk: false };
    const now = Date.now();
    const keep = [];
    let recent = false;
    for (const e of q) {
      const ts = e?.timestamp ?? 0;
      if (now - ts < MEV_LOOKBACK_MS) { recent = true; keep.push(e); }
    }
    // prune old entries (best-effort, ignore write errors)
    if (keep.length !== q.length) {
      try { fs.writeFileSync(MEV_FILE, JSON.stringify(keep)); } catch {}
    }
    return { risk: recent };
  } catch {
    return { risk: true };
  }
};

// 12) RESERVE TRADE CHECK (safer math)
export const reserveTradeCheck = async ({
  provider,
  poolType,
  poolAddress,
  pairAddress,
  tokenIn,
  desiredAmount,
  slippagePercent = 1
}) => {
  try {
    slippagePercent = Math.max(0, Math.min(99, Math.floor(slippagePercent || 1)));

    if (poolType === 'V2') {
      const c = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
      const [t0, t1, reserves] = await Promise.all([c.token0(), c.token1(), c.getReserves()]);
      const r0 = BigInt(reserves[0]); const r1 = BigInt(reserves[1]);
      const reserveIn = t0.toLowerCase() === tokenIn.toLowerCase() ? r0 : r1;
      let safeAmount = (reserveIn * BigInt(100 - slippagePercent)) / 100n;
      const want = BigInt(desiredAmount);
      if (want < safeAmount) safeAmount = want;
      return { safeAmount, info: { token0: t0, token1: t1, r0, r1 } };
    }

    if (poolType === 'V3') {
      const c = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
      const [slot0, liquidity, t0, t1] = await Promise.all([c.slot0(), c.liquidity(), c.token0(), c.token1()]);
      const liq = BigInt(liquidity);
      let safeAmount = (liq * BigInt(100 - slippagePercent)) / 100n;
      const want = BigInt(desiredAmount);
      if (want < safeAmount) safeAmount = want;
      const sqrtPriceX96 = (slot0 && (slot0.sqrtPriceX96 ?? slot0[0])) ?? 0n;
      return { safeAmount, info: { token0: t0, token1: t1, liquidity: liq, sqrtPriceX96 } };
    }

    return { safeAmount: 0n, info: null };
  } catch (err) {
    console.error('Reserve trade check failed:', err);
    return { safeAmount: 0n, info: null };
  }
};

// ---------- COMPOSED GUARD ----------
export const runProtections = async (params) => {
  const t0 = Date.now();
  const trace = [];

  function step(name) { trace.push({ name, ms: Date.now() - t0 }); }

  const {
    routeKey, expectedOut, minOut, txRequest,
    profitUsd, notionalUsd, profitToken, profitAmountWei, notionalToken, notionalAmountWei, feedMap,
    wallet, v2PairAddr, v3PoolAddr,
    fallbackTokens = [], neededBalance, flashCandidates = []
  } = params;

  const cd = enforceCooldown(routeKey);
  step('cooldown');
  if (!cd.ok) return { ok: false, reason: 'cooldown', details: cd, trace };

  const mev = isMEVRisk();
  step('mev');
  if (mev.risk) return { ok: false, reason: 'mevRisk', details: mev, trace };

  const slip = validateSlippage(expectedOut, minOut);
  step('slippage');
  if (!slip.ok) return { ok: false, reason: 'slippage', details: slip, trace };

  let pt;
  if (Number.isFinite(profitUsd) && Number.isFinite(notionalUsd)) {
    pt = meetsProfitThresholdUSD(profitUsd, notionalUsd);
  } else {
    pt = await meetsProfitThresholdUSD_Chainlink(await getReadProvider(), {
      profitToken, profitAmountWei, notionalToken, notionalAmountWei, feedMap
    });
  }
  step('profit');
  if (!pt.ok) return { ok: false, reason: 'profitBelowThreshold', details: pt, trace };

  const gas = await assessGas(txRequest);
  step('gas');
  if (!gas.ok) return { ok: false, reason: 'gasBad', details: gas, trace };

  if (neededBalance?.token) {
    const wb = await hasWalletBalance(wallet, neededBalance.token, neededBalance.amountWei);
    step('walletBalance');
    if (!wb.ok) return { ok: false, reason: 'insufficientBalance', details: wb, trace };
  } else {
    step('walletBalance');
  }

  if (flashCandidates.length) {
    const fl = await isFlashLoanAvailable(flashCandidates);
    step('flashLoan');
    if (!fl.ok) return { ok: false, reason: 'flashNotAvailable', details: fl, trace };
  } else {
    step('flashLoan');
  }

  const reserves = v2PairAddr
    ? await getV2Reserves(v2PairAddr)
    : (v3PoolAddr ? await getV3State(v3PoolAddr) : null);
  step('poolState');

  const fbTokens  = _resolveFlashFallbackTokens(fallbackTokens);
  const fallback  = fbTokens.length ? await chooseFallbackToken(wallet, fbTokens) : null;
  step('fallback');

  const lock      = lockProfit(pt.profitUsd ?? profitUsd ?? 0, 0.75);
  step('lock');

  return { ok: true, details: { slip, pt, gas, reserves, fallback, lock }, trace };
};

// ---------- DEFAULT EXPORT ----------
const _default = {
  validateSlippage,
  assessGas,
  meetsProfitThresholdUSD,
  meetsProfitThresholdUSD_Chainlink,
  enforceCooldown,
  isFlashLoanAvailable,
  chooseFallbackToken,
  hasWalletBalance,
  lockProfit,
  getV2Reserves,
  getV3State,
  isMEVRisk,
  runProtections,
  reserveTradeCheck,
  setRpcLimiter,
};
export default _default;
