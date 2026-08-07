import "./config.js"; // ensure .env is loaded before we read TOKEN/CHAT_ID below
import { log } from "./logger.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

export function telegramEnabled() {
  return !!(TOKEN && CHAT_ID);
}

/** The only chat this bot will ever take commands from. */
export function authorizedChatId() {
  return CHAT_ID;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function apiCall(method, params) {
  if (!API_BASE) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };
  try {
    const res = await fetch(`${API_BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      log("telegram_error", `${method} failed ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  } catch (err) {
    log("telegram_error", `${method} error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export async function sendTelegram(text) {
  if (!telegramEnabled()) {
    log("telegram_warn", "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing — skipping notification");
    return;
  }
  await apiCall("sendMessage", {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

/** Send a message with an inline keyboard. Returns the sent message's id (or null). */
export async function sendMenu(text, replyMarkup) {
  if (!telegramEnabled()) return null;
  const data = await apiCall("sendMessage", {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
  return data?.result?.message_id ?? null;
}

export async function editMenu(messageId, text, replyMarkup) {
  return apiCall("editMessageText", {
    chat_id: CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
}

export async function answerCallbackQuery(callbackQueryId, text) {
  return apiCall("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

/** Registers the "/" command menu shown by Telegram's client UI. */
export async function setMyCommands(commands) {
  return apiCall("setMyCommands", { commands });
}

/** Long-poll for updates. Returns the raw `result` array (or []). */
export async function getUpdates(offset, timeoutSec = 25) {
  const data = await apiCall("getUpdates", {
    offset,
    timeout: timeoutSec,
    allowed_updates: ["message", "callback_query"],
  });
  return data?.result || [];
}
