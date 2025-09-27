// getchainlinkpricefeed.js — fetches DAI/USDC/USDT prices from Chainlink (Polygon) without using the Feed Registry

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { getProvider, rotateProvider } from "./dataprovider.js";

// ---------- ESM __dirname ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Files ----------
const OUT_FILE = path.resolve(__dirname, "chainlinkpricefeed.json");

// ---------- Polygon Chainlink Feeds ----------
const FEEDS = [
  {
    symbol: "DAI",
    tokenAddr: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    tokenDecimals: 18,
    feedAddr: "0x4746DeC9e833A82EC7C2C1356372CcF2cfcD2F3D"
  },
  {
    symbol: "USDC",
    tokenAddr: "0x2791BfD60D232150bFF86b39b7146c0eAaA2bA81",
    tokenDecimals: 6,
    feedAddr: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7"
  },
  {
    symbol: "USDT",
    tokenAddr: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    tokenDecimals: 6,
    feedAddr: "0x0A6513e40db6EB1b165753AD52E80663aeA50545"
  }
];

const FEED_ABI = [
  "function latestRoundData() external view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() external view returns (uint8)"
];

// ---------- Provider w/ rotation ----------
let provider = getProvider();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withProvider(fn) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      return await fn(provider);
    } catch (e) {
      lastErr = e;
      provider = rotateProvider();
      await sleep(150 * (i + 1));
    }
  }
  return fn(provider).catch((e) => { throw (lastErr || e); });
}

// ---------- JSON helpers ----------
function safeLoadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    return (data && typeof data === "object") ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const pretty = JSON.stringify(data, null, 2);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, pretty, "utf8");
  fs.renameSync(tmp, file);
  console.log(`💾 ${path.basename(file)} updated (${Object.keys(data).length} entries)`);
}

// ---------- Chainlink direct feed read ----------
async function readFeedPrice(feedAddr) {
  const feed = new ethers.Contract(feedAddr, FEED_ABI, provider);
  const [round, dec] = await Promise.all([
    feed.latestRoundData(),
    feed.decimals()
  ]);

  const decimals = Number(dec);
  const answer = round?.answer ?? 0n;
  const updatedAt = round?.updatedAt ?? 0n;
  const roundId = round?.roundId ?? 0n;

  const d = Number.isFinite(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 8;
  const price = (() => {
    try {
      if (typeof answer === "bigint" && answer < 0n) return 0;
      return Number(ethers.formatUnits(answer, d));
    } catch {
      return 0;
    }
  })();

  return {
    price,
    feedDecimals: d,
    roundId: String(roundId),
    updatedAt: Number(updatedAt)
  };
}

// ---------- Main ----------
async function main() {
  const prevOut = safeLoadJSON(OUT_FILE, {});
  const now = Math.floor(Date.now() / 1000);
  const updates = {};

  for (const f of FEEDS) {
    try {
      const res = await readFeedPrice(f.feedAddr);
      updates[f.tokenAddr.toLowerCase()] = {
        symbol: f.symbol,
        price: res.price,
        decimals: f.tokenDecimals,
        updatedAt: res.updatedAt || now,
        roundId: res.roundId || null,
        source: "chainlink-direct"
      };
      console.log(`✅ ${f.symbol} → $${res.price}`);
    } catch (e) {
      console.warn(`⚠️ Failed to fetch ${f.symbol}: ${e?.message || e}`);
      updates[f.tokenAddr.toLowerCase()] = {
        symbol: f.symbol,
        price: 0,
        decimals: f.tokenDecimals,
        updatedAt: now,
        roundId: null,
        source: "unavailable"
      };
    }
  }

  const merged = { ...prevOut, ...updates };
  writeJsonAtomic(OUT_FILE, merged);

  console.log("✅ chainlinkpricefeed.json updated with stablecoin prices.");
}

main().catch((e) => {
  console.error("❌ getchainlinkpricefeed error:", e?.message || e);
  process.exit(1);
});
