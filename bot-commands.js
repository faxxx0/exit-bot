/**
 * Interactive Telegram menu: /positions list with inline buttons to close
 * a single position, close all, toggle trailing, and edit TP/SL/trail
 * settings. Long-polls getUpdates — no webhook server needed.
 *
 * Every incoming message/callback is checked against TELEGRAM_CHAT_ID —
 * anyone else messaging this bot is ignored.
 */
import { wallet, connection } from "./client.js";
import { config, updateManagementSetting } from "./config.js";
import { log } from "./logger.js";
import { fetchOpenPositions } from "./positions.js";
import { getTrackedPosition } from "./state.js";
import { performClose } from "./actions.js";
import { startedAt, getLastTickAt } from "./status.js";
import {
  telegramEnabled,
  authorizedChatId,
  escapeHtml,
  sendTelegram,
  sendMenu,
  editMenu,
  answerCallbackQuery,
  getUpdates,
  setMyCommands,
} from "./telegram.js";

const BOT_COMMANDS = [
  { command: "positions", description: "Lihat & kelola posisi aktif" },
  { command: "status", description: "Status bot (uptime, RPC, saldo)" },
  { command: "pause", description: "Pause auto-exit" },
  { command: "resume", description: "Resume auto-exit" },
];

let lastPositions = [];
let awaitingSetting = null; // one of: takeProfitPct | stopLossPct | trailingTriggerPct | trailingDropPct

const SETTING_LABELS = {
  takeProfitPct: "TP (instant close %)",
  stopLossPct: "SL (instant close %)",
  trailingTriggerPct: "Trailing trigger %",
  trailingDropPct: "Trailing drop %",
  outOfRangeWaitMinutes: "OOR wait (menit)",
  dualSideTakeProfitPct: "Dual Side TP %",
  dualSideStopLossPct: "Dual Side SL %",
  dualSideTrailingTriggerPct: "Dual Side Trailing trigger %",
  dualSideTrailingDropPct: "Dual Side Trailing drop %",
  confirmTicks: "Confirm ticks (jumlah tick konfirmasi)",
};

const DUAL_SIDE_SL_MODES = ["pnl_and_oor", "oor_only", "pnl_only"];
function dualSideSlModeLabel(mode) {
  if (mode === "oor_only") return "OOR kiri only";
  if (mode === "pnl_only") return "PnL only";
  return "PnL + OOR kiri";
}

function fmtValue(n) {
  if (n == null) return "?";
  return config.management.solMode ? `◎${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function fmtAge(minutes) {
  if (minutes == null) return "?";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function fmtPnl(pct) {
  if (pct == null) return "?";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function fmtDuration(ms) {
  if (ms == null) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

async function buildStatusText() {
  const lastTickAt = getLastTickAt();
  let solBalance = null;
  let rpcOk = true;
  try {
    solBalance = (await connection.getBalance(wallet.publicKey)) / 1e9;
  } catch (e) {
    rpcOk = false;
  }

  return (
    `🤖 <b>Bot Status</b>\n` +
    `Uptime: ${fmtDuration(Date.now() - startedAt)}\n` +
    `Last tick: ${lastTickAt != null ? `${fmtDuration(Date.now() - lastTickAt)} ago` : "never"}\n` +
    `RPC: ${rpcOk ? "✅ OK" : "❌ unreachable"}\n` +
    `Wallet SOL: ${solBalance != null ? `◎${solBalance.toFixed(4)}` : "?"}\n` +
    `Auto-exit: ${config.management.paused ? "⏸ PAUSED" : "▶️ running"}\n` +
    `Trailing TP: ${config.management.trailingTakeProfit ? "ON" : "OFF"}\n` +
    `Telegram notif: ${telegramEnabled() ? "✅" : "❌"}`
  );
}

function pnlEmoji(pct) {
  if (pct == null) return "";
  if (pct >= 1) return "🔥";
  if (pct >= 0) return ""; // 0% – 0.99%
  if (pct > -1) return "⚠️"; // -0.01% – -0.99%
  return "‼️"; // <= -1%
}

/** New peak this tick (or holding at peak) vs. slipping back down from it. */
function trailingTrendEmoji(currentPct, peakPct) {
  if (currentPct == null || peakPct == null) return "";
  return currentPct >= peakPct ? "📈" : "📉";
}

function formatPositionBlock(p, idx) {
  const emoji = pnlEmoji(p.pnl_pct);
  const statusEmoji = p.in_range ? "🟢" : "🔴";
  const statusLabel = p.in_range ? "IN" : "OOR";
  const tracked = getTrackedPosition(p.position);
  const dualSideLine = tracked?.is_dual_side_at_open === true ? `⚖️ Dual Side\n` : "";
  const trailingLine = tracked?.trailing_active
    ? `Trailing active: peak ${fmtPnl(tracked.peak_pnl_pct)} ${trailingTrendEmoji(p.pnl_pct, tracked.peak_pnl_pct)}\n`
    : "";
  const dualSideTrailingLine = tracked?.dual_side_trailing_active
    ? `⚖️ Trailing active: peak ${fmtPnl(tracked.peak_pnl_pct)} ${trailingTrendEmoji(p.pnl_pct, tracked.peak_pnl_pct)}\n`
    : "";
  return (
    `<b>Posisi ${idx}</b>\n` +
    `<b>${escapeHtml(p.pair)}</b> | Age: ${fmtAge(p.age_minutes)} | Val: ${fmtValue(p.total_value_usd)} | Unclaimed: ${fmtValue(p.unclaimed_fees_usd)}\n` +
    `PnL: ${fmtPnl(p.pnl_pct)} ${emoji} | Fee/TVL24h: ${p.fee_per_tvl_24h ?? "?"}% | ${statusEmoji} ${statusLabel}\n` +
    dualSideLine +
    trailingLine +
    dualSideTrailingLine
  );
}

async function fetchAndCachePositions() {
  try {
    lastPositions = await fetchOpenPositions(wallet.publicKey.toString(), {
      solMode: config.management.solMode,
      checkDualSided: config.management.dualSideEnabled,
    });
  } catch (e) {
    log("telegram-bot_error", `fetchOpenPositions failed: ${e.message}`);
    lastPositions = [];
  }
  return lastPositions;
}

function buildPositionsText(positions, prefix = "") {
  const pauseBanner = config.management.paused ? "⏸ <b>AUTO-EXIT PAUSED</b> — posisi cuma dipantau, ga bakal auto-close.\n\n" : "";
  if (positions.length === 0) return `${pauseBanner}${prefix}Gak ada posisi aktif saat ini.`;
  return pauseBanner + prefix + positions.map((p, i) => formatPositionBlock(p, i + 1)).join("\n");
}

function buildPositionsKeyboard(positions) {
  const rows = positions.map((p, i) => [{ text: `Close ${i + 1}`, callback_data: `close_${i}` }]);
  if (positions.length > 0) {
    rows.push([{ text: "❌ Close All", callback_data: "confirm_close_all" }]);
  }
  const trailLabel = config.management.trailingTakeProfit ? "⏸ Trailing Off" : "▶️ Trailing On";
  const pauseLabel = config.management.paused ? "▶️ Resume Auto-Exit" : "⏸ Pause Auto-Exit";
  rows.push([{ text: trailLabel, callback_data: "toggle_trailing" }, { text: pauseLabel, callback_data: "toggle_pause" }]);
  rows.push([{ text: "🔄 Refresh", callback_data: "refresh" }, { text: "⚙️ Settings", callback_data: "open_settings" }]);
  return { inline_keyboard: rows };
}

function buildSettingsText() {
  const m = config.management;
  const dualSideLine = m.dualSideEnabled
    ? `TP: ${m.dualSideTakeProfitPct ?? "OFF"}% | SL: ${m.dualSideStopLossPct ?? "OFF"}% (${dualSideSlModeLabel(m.dualSideStopLossMode)})\n` +
      `Trailing: ${m.dualSideTrailingEnabled ? "ON" : "OFF"} (trigger ${m.dualSideTrailingTriggerPct ?? "?"}%, drop ${m.dualSideTrailingDropPct ?? "?"}%)\n`
    : "";
  const delaySec = config.poll.intervalSec * m.confirmTicks;
  return (
    `⚙️ <b>Setting aktif:</b>\n` +
    `TP (instant): ${m.takeProfitPct != null ? m.takeProfitPct + "%" : "OFF"}\n` +
    `SL (instant): ${m.stopLossPct}%${m.stopLossRequireOorLeft ? " (+ OOR kiri)" : ""}\n` +
    `Trailing: ${m.trailingTakeProfit ? "ON" : "OFF"} (trigger ${m.trailingTriggerPct}%, drop ${m.trailingDropPct}%)\n` +
    `OOR wait: ${m.outOfRangeExitEnabled ? `ON (${m.outOfRangeWaitMinutes}m)` : "OFF"}\n` +
    `Confirm ticks: ${m.confirmTicks}x\n` +
    `<i>Bot ngecek PnL tiap ${config.poll.intervalSec} detik. Sinyal close (TP/SL/trailing/dll) baru beneran dieksekusi kalau kondisinya masih sama selama ${m.confirmTicks}x cek berturut-turut (≈${delaySec} detik), bukan langsung di cek pertama — biar bot gak salah tembak gara-gara harga sempat lonjak/anjlok sesaat doang.</i>\n\n` +
    `⚖️ <b>Strategi Dual Side</b>: ${m.dualSideEnabled ? "ON" : "OFF"}\n` +
    dualSideLine +
    `\nTap salah satu buat ubah nilainya.`
  );
}

function buildSettingsKeyboard() {
  const m = config.management;
  const rows = [
    [
      { text: `TP: ${m.takeProfitPct ?? "OFF"}`, callback_data: "edit_tp" },
      { text: `SL: ${m.stopLossPct}%`, callback_data: "edit_sl" },
    ],
    [
      { text: `Trail trigger: ${m.trailingTriggerPct}%`, callback_data: "edit_trigger" },
      { text: `Trail drop: ${m.trailingDropPct}%`, callback_data: "edit_trail" },
    ],
    [{ text: `SL + OOR kiri: ${m.stopLossRequireOorLeft ? "ON" : "OFF"}`, callback_data: "toggle_sl_oor_left" }],
    [{ text: `OOR wait: ${m.outOfRangeExitEnabled ? "ON" : "OFF"}`, callback_data: "toggle_oor_wait" }],
    [{ text: `Confirm ticks: ${m.confirmTicks}x`, callback_data: "edit_confirm_ticks" }],
  ];
  if (m.outOfRangeExitEnabled) {
    rows.push([{ text: `OOR wait: ${m.outOfRangeWaitMinutes}m`, callback_data: "edit_oor_wait" }]);
  }
  rows.push([{ text: `⚖️ Dual Side: ${m.dualSideEnabled ? "ON" : "OFF"}`, callback_data: "toggle_dual_side" }]);
  if (m.dualSideEnabled) {
    rows.push([
      { text: `DS TP: ${m.dualSideTakeProfitPct ?? "OFF"}%`, callback_data: "edit_dual_tp" },
      { text: `DS SL: ${m.dualSideStopLossPct ?? "OFF"}%`, callback_data: "edit_dual_sl" },
    ]);
    rows.push([{ text: `DS SL mode: ${dualSideSlModeLabel(m.dualSideStopLossMode)}`, callback_data: "cycle_dual_sl_mode" }]);
    rows.push([{ text: `DS Trailing: ${m.dualSideTrailingEnabled ? "ON" : "OFF"}`, callback_data: "toggle_dual_trailing" }]);
    if (m.dualSideTrailingEnabled) {
      rows.push([
        { text: `DS Trail trigger: ${m.dualSideTrailingTriggerPct ?? "?"}%`, callback_data: "edit_dual_trail_trigger" },
        { text: `DS Trail drop: ${m.dualSideTrailingDropPct ?? "?"}%`, callback_data: "edit_dual_trail_drop" },
      ]);
    }
  }
  rows.push([{ text: "⬅️ Back", callback_data: "back_to_positions" }]);
  return { inline_keyboard: rows };
}

async function showPositions(messageId = null, prefix = "") {
  const positions = await fetchAndCachePositions();
  const text = buildPositionsText(positions, prefix);
  const keyboard = buildPositionsKeyboard(positions);
  if (messageId) await editMenu(messageId, text, keyboard);
  else await sendMenu(text, keyboard);
}

async function showSettings(messageId = null) {
  if (messageId) await editMenu(messageId, buildSettingsText(), buildSettingsKeyboard());
  else await sendMenu(buildSettingsText(), buildSettingsKeyboard());
}

function isAuthorized(chatId) {
  return String(chatId) === String(authorizedChatId());
}

async function handleMessage(msg) {
  if (!isAuthorized(msg.chat?.id)) return;
  const text = (msg.text || "").trim();

  if (awaitingSetting) {
    let value = parseFloat(text);
    if (!Number.isFinite(value)) {
      await sendTelegram("Format salah, masukin angka aja (misal 50 atau -30).");
      return;
    }
    const key = awaitingSetting;
    if (key === "confirmTicks") value = Math.max(1, Math.round(value));
    awaitingSetting = null;
    updateManagementSetting(key, value);
    log("telegram-bot", `Setting ${key} updated to ${value} via Telegram`);
    await showSettings();
    return;
  }

  if (text === "/positions" || text === "/menu" || text === "/start") {
    await showPositions();
    return;
  }

  if (text === "/status") {
    await sendTelegram(await buildStatusText());
    return;
  }

  if (text === "/pause" || text === "/resume") {
    const pause = text === "/pause";
    updateManagementSetting("paused", pause);
    log("telegram-bot", `Auto-exit ${pause ? "paused" : "resumed"} via Telegram`);
    await sendTelegram(pause ? "⏸ Auto-exit dipause. Posisi tetap dipantau, tapi ga bakal auto-close." : "▶️ Auto-exit di-resume.");
    return;
  }
}

async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (!isAuthorized(chatId)) {
    await answerCallbackQuery(query.id, "Unauthorized");
    return;
  }

  const data = query.data || "";

  if (data === "refresh" || data === "back_to_positions") {
    await answerCallbackQuery(query.id);
    await showPositions(messageId);
    return;
  }

  if (data.startsWith("close_") && data !== "close_all_execute") {
    const idx = Number(data.slice("close_".length));
    const position = lastPositions[idx];
    if (!position) {
      await answerCallbackQuery(query.id, "Posisi tidak ditemukan — refresh dulu.");
      return;
    }
    await answerCallbackQuery(query.id, "Closing...");
    await editMenu(messageId, `⏳ Closing ${escapeHtml(position.pair)}...`);
    const result = await performClose(position, "MANUAL_CLOSE", "Manual close via Telegram", { source: "manual" });
    if (result.locked === false) {
      await editMenu(messageId, `⚠️ ${escapeHtml(position.pair)} sedang diproses proses lain, coba lagi sebentar.`);
      return;
    }
    await showPositions(messageId);
    return;
  }

  if (data === "confirm_close_all") {
    await answerCallbackQuery(query.id);
    await editMenu(messageId, "⚠️ Yakin mau close SEMUA posisi? Aksi ini tidak bisa dibatalkan.", {
      inline_keyboard: [[
        { text: "✅ Yakin Close All", callback_data: "close_all_execute" },
        { text: "❌ Batal", callback_data: "back_to_positions" },
      ]],
    });
    return;
  }

  if (data === "close_all_execute") {
    await answerCallbackQuery(query.id, "Closing all...");
    await editMenu(messageId, "⏳ Closing semua posisi...");
    const positions = await fetchAndCachePositions();
    const results = [];
    for (const p of positions) {
      const r = await performClose(p, "MANUAL_CLOSE_ALL", "Manual close-all via Telegram", { source: "manual_all" });
      results.push({ pair: p.pair, ok: r.success === true, locked: r.locked });
    }
    const summary = results.length
      ? results.map((r) => `${r.ok ? "✅" : r.locked === false ? "⏭️" : "❌"} ${escapeHtml(r.pair)}`).join("\n")
      : "Tidak ada posisi.";
    await showPositions(messageId, `<b>Hasil Close All:</b>\n${summary}\n\n`);
    return;
  }

  if (data === "toggle_trailing") {
    await answerCallbackQuery(query.id);
    updateManagementSetting("trailingTakeProfit", !config.management.trailingTakeProfit);
    await showPositions(messageId);
    return;
  }

  if (data === "toggle_pause") {
    const pause = !config.management.paused;
    updateManagementSetting("paused", pause);
    log("telegram-bot", `Auto-exit ${pause ? "paused" : "resumed"} via Telegram`);
    await answerCallbackQuery(query.id, pause ? "Auto-exit paused" : "Auto-exit resumed");
    await showPositions(messageId);
    return;
  }

  if (data === "toggle_sl_oor_left") {
    await answerCallbackQuery(query.id);
    const enabled = !config.management.stopLossRequireOorLeft;
    updateManagementSetting("stopLossRequireOorLeft", enabled);
    log("telegram-bot", `SL + OOR kiri ${enabled ? "enabled" : "disabled"} via Telegram`);
    await showSettings(messageId);
    return;
  }

  if (data === "toggle_oor_wait") {
    await answerCallbackQuery(query.id);
    const enabled = !config.management.outOfRangeExitEnabled;
    updateManagementSetting("outOfRangeExitEnabled", enabled);
    log("telegram-bot", `OOR wait exit ${enabled ? "enabled" : "disabled"} via Telegram`);
    await showSettings(messageId);
    return;
  }

  if (data === "toggle_dual_side") {
    await answerCallbackQuery(query.id);
    const enabled = !config.management.dualSideEnabled;
    updateManagementSetting("dualSideEnabled", enabled);
    log("telegram-bot", `Strategi Dual Side ${enabled ? "enabled" : "disabled"} via Telegram`);
    await showSettings(messageId);
    return;
  }

  if (data === "toggle_dual_trailing") {
    await answerCallbackQuery(query.id);
    const enabled = !config.management.dualSideTrailingEnabled;
    updateManagementSetting("dualSideTrailingEnabled", enabled);
    log("telegram-bot", `Dual Side Trailing ${enabled ? "enabled" : "disabled"} via Telegram`);
    await showSettings(messageId);
    return;
  }

  if (data === "cycle_dual_sl_mode") {
    await answerCallbackQuery(query.id);
    const idx = DUAL_SIDE_SL_MODES.indexOf(config.management.dualSideStopLossMode);
    const next = DUAL_SIDE_SL_MODES[(idx + 1) % DUAL_SIDE_SL_MODES.length];
    updateManagementSetting("dualSideStopLossMode", next);
    log("telegram-bot", `Dual Side SL mode set to ${next} via Telegram`);
    await showSettings(messageId);
    return;
  }

  if (data === "open_settings") {
    await answerCallbackQuery(query.id);
    await showSettings(messageId);
    return;
  }

  if (data.startsWith("edit_")) {
    const map = {
      edit_tp: "takeProfitPct",
      edit_sl: "stopLossPct",
      edit_trigger: "trailingTriggerPct",
      edit_trail: "trailingDropPct",
      edit_oor_wait: "outOfRangeWaitMinutes",
      edit_dual_tp: "dualSideTakeProfitPct",
      edit_dual_sl: "dualSideStopLossPct",
      edit_dual_trail_trigger: "dualSideTrailingTriggerPct",
      edit_dual_trail_drop: "dualSideTrailingDropPct",
      edit_confirm_ticks: "confirmTicks",
    };
    const key = map[data];
    if (!key) {
      await answerCallbackQuery(query.id, "Unknown setting");
      return;
    }
    awaitingSetting = key;
    await answerCallbackQuery(query.id);
    const hint =
      key === "confirmTicks"
        ? `Masukin jumlah tick baru buat <b>${escapeHtml(SETTING_LABELS[key])}</b> (bilangan bulat, contoh: 2). ` +
          `Cek posisi tiap ${config.poll.intervalSec} detik — jadi kalau diisi 2, sinyal close butuh ~${config.poll.intervalSec * 2} detik konsisten dulu sebelum dieksekusi. Makin gede angkanya, makin "aman" dari harga spike sesaat tapi makin lambat reaksinya.`
        : `Masukin nilai baru buat <b>${escapeHtml(SETTING_LABELS[key])}</b> (contoh: 50 atau -30):`;
    await editMenu(messageId, hint);
    return;
  }

  await answerCallbackQuery(query.id);
}

let offset = 0;

async function pollLoop() {
  for (;;) {
    let updates;
    try {
      updates = await getUpdates(offset, 25);
    } catch (e) {
      log("telegram-bot_error", `Poll failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        if (update.message) await handleMessage(update.message);
        else if (update.callback_query) await handleCallbackQuery(update.callback_query);
      } catch (e) {
        log("telegram-bot_error", `Update handling failed: ${e.stack || e.message}`);
      }
    }
  }
}

export function startTelegramBot() {
  if (!telegramEnabled()) {
    log("telegram_warn", "Telegram command listener not started — missing token/chat id");
    return;
  }
  setMyCommands(BOT_COMMANDS).catch((e) => log("telegram-bot_error", `setMyCommands failed: ${e.message}`));
  log("telegram-bot", "Command listener starting (long-poll)...");
  pollLoop();
}
