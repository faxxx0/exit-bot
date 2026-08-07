/**
 * exit-bot — standalone Meteora DLMM exit manager.
 *
 * Fully standalone: own wallet, own RPC, own Telegram bot, own state file.
 * Only job: watch open positions for this wallet and close them on
 * take-profit / stop loss / trailing TP / out-of-range / low yield — plus
 * a Telegram menu (/positions) for manual control.
 *
 * No screening, no deploy, no LLM.
 *
 * Run:
 *   node index.js
 *   pm2 start index.js --name exit-bot
 */
import { wallet } from "./client.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { fetchOpenPositions } from "./positions.js";
import {
  ensurePositionTracked,
  confirmPeak,
  registerExitSignal,
  updatePnlAndCheckExits,
  detectTopup,
  detectPnlSpike,
  inGracePeriod,
  isTopupSettling,
} from "./state.js";
import { telegramEnabled } from "./telegram.js";
import { performClose } from "./actions.js";
import { startTelegramBot } from "./bot-commands.js";
import { markTick } from "./status.js";

const POLL_MS = config.poll.intervalSec * 1000;

log("exit-bot", `Wallet: ${wallet.publicKey.toString()}`);
log("exit-bot", `Telegram notifications: ${telegramEnabled() ? "enabled" : "DISABLED (missing token/chat id)"}`);
log("exit-bot", `Polling every ${POLL_MS}ms, confirmTicks=${config.management.confirmTicks}`);

let ticking = false;
let heartbeatSkip = 0;

async function tick() {
  if (ticking) return; // guard against overlap while a slow close is in-flight
  ticking = true;
  markTick();
  try {
    const positions = await fetchOpenPositions(wallet.publicKey.toString(), {
      solMode: config.management.solMode,
      checkDualSided: config.management.dualSideEnabled,
    });

    if (positions.length === 0) {
      if (++heartbeatSkip >= 30) {
        heartbeatSkip = 0;
        log("exit-bot", "No open positions");
      }
      return;
    }
    heartbeatSkip = 0;

    for (const p of positions) {
      ensurePositionTracked(p.position, p);
      detectTopup(p.position, p);
      detectPnlSpike(p.position, p.pnl_pct, config.management);

      const settling = isTopupSettling(p.position, p.pnl_pct, config.management);
      if (!inGracePeriod(p.position, config.management.exitGracePeriodSec) && !settling) {
        confirmPeak(p.position, p.pnl_pct, config.management.confirmTicks);
      }

      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      const { fire, action } = registerExitSignal(p.position, exit?.action ?? null, config.management.confirmTicks);

      if (fire) {
        if (config.management.paused) {
          log("exit-bot", `Exit signal ${action} for ${p.pair} suppressed — bot paused`);
        } else {
          await performClose(p, action, exit.reason, { source: "auto" });
        }
        break; // one action per tick
      }
    }
  } catch (err) {
    log("exit-bot_error", `Tick failed: ${err.stack || err.message}`);
  } finally {
    ticking = false;
  }
}

log("exit-bot", "exit-bot running...");
tick();
setInterval(tick, POLL_MS);
startTelegramBot();

process.on("SIGINT", () => {
  log("exit-bot", "Shutting down...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("exit-bot", "Shutting down...");
  process.exit(0);
});
