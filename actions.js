/**
 * Shared close-position action, used by both the autonomous tick loop
 * (index.js) and the Telegram command handlers (bot-commands.js) — one
 * code path so behavior (swap, notify, state) is always consistent, and
 * one lock so they never race on the same position.
 */
import { connection, wallet } from "./client.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { closePositionOnChain } from "./close.js";
import { getTokenBalance, swapToSol } from "./jupiter.js";
import { recordClose } from "./state.js";
import { sendTelegram, escapeHtml } from "./telegram.js";
import { tryLock, unlock } from "./lock.js";

function formatPnl(pct) {
  if (pct == null) return "?";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/**
 * Close a position, auto-swap leftover base token to SOL, record state,
 * and notify Telegram. Returns:
 *   { locked: false }                          — another close already in flight for this position
 *   { locked: true, success: true, txs }        — closed
 *   { locked: true, success: false, error }      — close failed
 */
export async function performClose(position, action, reason, { source = "auto" } = {}) {
  if (!tryLock(position.position)) {
    log("exit-bot", `Skip ${action} for ${position.pair} — close already in progress`);
    return { locked: false };
  }

  try {
    log("exit-bot", `${action} triggered for ${position.pair} (${position.position}) [${source}]: ${reason}`);
    const result = await closePositionOnChain(connection, wallet, position.position, position.pool);

    if (!result.success) {
      log("exit-bot_error", `Close failed for ${position.pair} (${position.position}): ${result.error}`);
      await sendTelegram(
        `⚠️ <b>Close FAILED</b> — ${escapeHtml(position.pair)}\n` +
        `Signal: ${escapeHtml(action)}\n` +
        `Error: ${escapeHtml(result.error)}\n` +
        `Position: <code>${escapeHtml(position.position)}</code>`,
      );
      return { locked: true, success: false, error: result.error };
    }

    recordClose(position.position, action, reason, position.pnl_pct);

    // Notify immediately — don't make the user wait on (or refresh past) the
    // auto-swap step below, which can take several seconds or fail/retry.
    await sendTelegram(
      `🔴 <b>Exit</b> — ${escapeHtml(position.pair)}\n` +
      `Signal: ${escapeHtml(action)}\n` +
      `PnL: ${formatPnl(position.pnl_pct)}\n` +
      `Reason: ${escapeHtml(reason)}`,
    );

    if (config.swap.autoSwapAfterClose && result.base_mint && result.base_mint !== config.tokens.SOL) {
      try {
        const { raw } = await getTokenBalance(connection, wallet.publicKey, result.base_mint);
        if (raw > 0n) {
          const swapResult = await swapToSol(wallet, result.base_mint, raw);
          if (swapResult.success && !swapResult.skipped) {
            await sendTelegram(`Swap: ${escapeHtml(result.base_mint.slice(0, 8))}… → SOL ✅ (${escapeHtml(position.pair)})`);
          } else if (!swapResult.success) {
            await sendTelegram(`⚠️ Auto-swap gagal, token sisa di wallet: ${escapeHtml(swapResult.error)} (${escapeHtml(position.pair)})`);
          }
        }
      } catch (e) {
        await sendTelegram(`⚠️ Auto-swap error: ${escapeHtml(e.message)} (${escapeHtml(position.pair)})`);
      }
    }

    return { locked: true, success: true, txs: result.txs };
  } finally {
    unlock(position.position);
  }
}
