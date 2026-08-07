import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {};
}

const u = readJsonIfExists(USER_CONFIG_PATH);

const REQUIRED_THRESHOLD_KEYS = [
  "stopLossPct",
  "trailingTakeProfit",
  "trailingTriggerPct",
  "trailingDropPct",
  "outOfRangeWaitMinutes",
  "minFeePerTvl24h",
  "minAgeBeforeYieldCheck",
  "solMode",
];

const missing = REQUIRED_THRESHOLD_KEYS.filter((key) => u[key] === null || u[key] === undefined);
if (missing.length > 0) {
  console.error(
    `[config] Missing required threshold(s) in user-config.json: ${missing.join(", ")}. ` +
    `Fill these in before starting the bot — see user-config.example.json.`,
  );
  process.exit(1);
}

if (!process.env.WALLET_PRIVATE_KEY) {
  console.error("[config] WALLET_PRIVATE_KEY not set in .env");
  process.exit(1);
}
if (!process.env.RPC_URL) {
  console.error("[config] RPC_URL not set in .env");
  process.exit(1);
}

export const config = {
  management: {
    // Optional — null disables the instant take-profit exit until set via the Telegram Settings menu.
    takeProfitPct: u.takeProfitPct == null ? null : Number(u.takeProfitPct),
    stopLossPct: Number(u.stopLossPct),
    // When true, stop loss only fires if the position has also broken out
    // of range to the downside ("OOR kiri"). Off by default (SL fires on
    // PnL alone). Toggleable live via the Telegram Settings menu.
    stopLossRequireOorLeft: !!u.stopLossRequireOorLeft,
    trailingTakeProfit: !!u.trailingTakeProfit,
    trailingTriggerPct: Number(u.trailingTriggerPct),
    trailingDropPct: Number(u.trailingDropPct),
    // On/off switch for the out-of-range exit below — defaults to true so
    // existing installs (where this exit has always been active) keep
    // behaving the same after upgrade. Toggleable live via Telegram Settings.
    outOfRangeExitEnabled: u.outOfRangeExitEnabled == null ? true : !!u.outOfRangeExitEnabled,
    outOfRangeWaitMinutes: Number(u.outOfRangeWaitMinutes),
    minFeePerTvl24h: Number(u.minFeePerTvl24h),
    minAgeBeforeYieldCheck: Number(u.minAgeBeforeYieldCheck),
    solMode: !!u.solMode,
    exitGracePeriodSec: Number(u.exitGracePeriodSec ?? 20),
    // How close (in pct-points) reported PnL must come back to the pre-top-up
    // baseline before we trust it again after a size top-up.
    topupSettleTolerancePct: Number(u.topupSettleTolerancePct ?? 3),
    // Minimum time a top-up must settle for before a within-tolerance
    // reading is trusted, even if PnL happens to read near baseline sooner
    // (the phantom-profit spike from the indexer's balance/deposit lag can
    // show up well after top-up, not immediately).
    topupSettleMinSec: Number(u.topupSettleMinSec ?? 45),
    // Consecutive within-tolerance polls required before declaring settled,
    // so one lucky-timed reading can't clear the guard by itself.
    topupSettleConfirmTicks: Number(u.topupSettleConfirmTicks ?? 3),
    // Safety valve: stop waiting for PnL to settle after this many seconds
    // and accept whatever it reads as real (avoids stalling forever).
    topupMaxSettleSec: Number(u.topupMaxSettleSec ?? 300),
    // Global auto-exit kill-switch — toggled via Telegram /pause /resume.
    // While true, positions are still tracked/polled but no auto-close fires.
    paused: !!u.paused,
    // ── Strategi Dual Side: extra exit rules that only apply to dual-sided
    // positions (liquidity deposited on both tokens X and Y). Independent of
    // the regular TP/SL above — lets dual-sided positions use their own
    // thresholds. Toggleable live via the Telegram bot's Settings button.
    dualSideEnabled: !!u.dualSideEnabled,
    dualSideTakeProfitPct: u.dualSideTakeProfitPct == null ? null : Number(u.dualSideTakeProfitPct),
    dualSideStopLossPct: u.dualSideStopLossPct == null ? null : Number(u.dualSideStopLossPct),
    // How the SL above combines with "OOR kiri" (active bin broke below the
    // position's range): "pnl_and_oor" (both required), "oor_only" (OOR kiri
    // alone fires it, PnL ignored), "pnl_only" (PnL alone fires it, ignores OOR).
    dualSideStopLossMode: ["pnl_and_oor", "oor_only", "pnl_only"].includes(u.dualSideStopLossMode)
      ? u.dualSideStopLossMode
      : "pnl_and_oor",
    // Trailing take-profit for Dual Side positions — separate on/off +
    // trigger/drop from the regular trailingTakeProfit above, so dual-sided
    // positions can trail at different thresholds. Toggleable live via the
    // Telegram bot's Settings button.
    dualSideTrailingEnabled: !!u.dualSideTrailingEnabled,
    dualSideTrailingTriggerPct: u.dualSideTrailingTriggerPct == null ? null : Number(u.dualSideTrailingTriggerPct),
    dualSideTrailingDropPct: u.dualSideTrailingDropPct == null ? null : Number(u.dualSideTrailingDropPct),
    // How many CONSECUTIVE polling ticks an exit signal (TP/SL/trailing/OOR)
    // must keep reporting the same action before the bot actually closes the
    // position. Guards against a one-tick price spike/glitch triggering a
    // close by itself. Editable live via the Telegram Settings menu — takes
    // effect on the very next tick, no restart needed. Real-world delay from
    // "PnL first crosses the threshold" to "close fires" is roughly
    // confirmTicks × poll.intervalSec seconds.
    confirmTicks: Math.max(1, Number(u.confirmTicks ?? 2)),
  },
  poll: {
    // How often (in seconds) the bot checks position PnL. NOT editable live —
    // it's baked into a setInterval() at process start, so a change here
    // only takes effect after restarting the bot.
    intervalSec: Number(u.pollIntervalSec ?? 3),
  },
  swap: {
    autoSwapAfterClose: u.autoSwapAfterClose ?? true,
    slippageBps: Number(u.swapSlippageBps ?? 500),
  },
  tokens: {
    SOL: "So11111111111111111111111111111111111111112",
  },
};

const MANAGEMENT_KEYS = new Set(Object.keys(config.management));

/**
 * Mutate a config.management field in-memory AND persist it to
 * user-config.json, so Telegram Settings edits survive a restart.
 */
export function updateManagementSetting(key, value) {
  if (!MANAGEMENT_KEYS.has(key)) {
    throw new Error(`Unknown management setting: ${key}`);
  }
  config.management[key] = value;

  const fresh = readJsonIfExists(USER_CONFIG_PATH);
  fresh[key] = value;
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(fresh, null, 2));
}
