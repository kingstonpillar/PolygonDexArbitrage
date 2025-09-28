// crash-protection.js (final with hourly ping + daily heartbeat + daily rotation)

import fs from "fs";
import path from "path";
import process from "process";
import { sendTelegramAlert } from "./telegramalert.js"; // your existing function

// Ensure logs folder exists
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const LOG_FILE = path.join(LOG_DIR, "crash.log");
const COUNT_FILE = path.join(LOG_DIR, "restart-count.txt");

// Track uptime
const startTime = Date.now();

// Load restart count (persistent across PM2 restarts)
let restartCount = 0;
if (fs.existsSync(COUNT_FILE)) {
  try {
    restartCount = parseInt(fs.readFileSync(COUNT_FILE, "utf8"), 10) || 0;
  } catch {
    restartCount = 0;
  }
}
restartCount++;
fs.writeFileSync(COUNT_FILE, String(restartCount), "utf8");

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / (1000 * 60)) % 60;
  const hr = Math.floor(ms / (1000 * 60 * 60));
  return `${hr}h ${min}m ${sec}s`;
}

function logError(type, error) {
  const uptime = formatDuration(Date.now() - startTime);
  const entry = `[${new Date().toISOString()}] [${type}] [Uptime: ${uptime}] ${error?.stack || error}\n`;
  fs.appendFileSync(LOG_FILE, entry);
  console.error(entry);

  try {
    sendTelegramAlert(
      `⚠️ [${type}] Bot error\n⏱️ Uptime before crash: ${uptime}\n\n${error?.message || error}`
    );
  } catch (e) {
    console.error("Failed to send Telegram alert:", e);
  }
}

// Catch uncaught exceptions
process.on("uncaughtException", (err) => {
  logError("UncaughtException", err);
});

// Catch unhandled promise rejections
process.on("unhandledRejection", (reason) => {
  logError("UnhandledRejection", reason);
});

// Monitor memory usage (safe limit ~1.5 GB on 2 GB VPS)
setInterval(() => {
  const used = process.memoryUsage().rss / 1024 / 1024; // MB
  if (used > 1500) {
    const uptime = formatDuration(Date.now() - startTime);
    const msg = `Memory watchdog: ${used.toFixed(2)} MB > 1500 MB\nBot uptime: ${uptime}\nBot will exit for safe restart.`;
    logError("MemoryWatchdog", msg);

    try {
      sendTelegramAlert(
        `🛑 Bot restarting due to high memory usage: ${used.toFixed(2)} MB\n⏱️ Uptime: ${uptime}`
      );
    } catch (e) {
      console.error("Failed to send memory usage alert:", e);
    }

    process.exit(1); // PM2/systemd restarts it
  }
}, 30000); // every 30s

// Helper to send alerts
function sendAlert(message) {
  try {
    sendTelegramAlert(message);
  } catch (e) {
    console.error("Failed to send alert:", e);
  }
}

// === Daily log rotation ===
setInterval(() => {
  if (fs.existsSync(LOG_FILE)) {
    const ts = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const rotated = path.join(LOG_DIR, `crash-${ts}.log`);

    try {
      // Rotate crash.log -> crash-YYYY-MM-DD.log
      fs.renameSync(LOG_FILE, rotated);
      fs.writeFileSync(LOG_FILE, ""); // fresh file
      console.log(`🌀 Rotated crash log → ${rotated}`);
    } catch (err) {
      console.error("Failed to rotate log:", err);
    }

    // Keep only last 7 rotated logs
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith("crash-") && f.endsWith(".log"))
        .sort()
        .reverse(); // newest first

      if (files.length > 7) {
        files.slice(7).forEach(f => {
          try {
            fs.unlinkSync(path.join(LOG_DIR, f));
            console.log(`🗑 Deleted old log: ${f}`);
          } catch (err) {
            console.error("Failed to delete old log:", err);
          }
        });
      }
    } catch (err) {
      console.error("Failed to clean old logs:", err);
    }
  }
}, 24 * 60 * 60 * 1000); // every 24h

// Hourly uptime ping
setInterval(() => {
  const uptime = formatDuration(Date.now() - startTime);
  sendAlert(`⏱ Hourly ping: Bot alive\nUptime: ${uptime}`);
}, 60 * 60 * 1000); // 1h

// Daily heartbeat
setInterval(() => {
  const uptime = formatDuration(Date.now() - startTime);
  sendAlert(`✅ Daily heartbeat: Bot still running\n⏱️ Uptime: ${uptime}`);
}, 24 * 60 * 60 * 1000); // 24h

export function protect() {
  console.log("✅ Crash protection with Telegram alerts enabled");

  // Send startup alert with timestamp + restart count
  const ts = new Date().toISOString();
  sendAlert(
    `🚀 Polygon Arbitrage Bot started\n🕒 ${ts}\n🔄 Restart count: ${restartCount}`
  );
}
