/**
 * Tiny in-memory liveness tracker, read by the /status Telegram command.
 * Separate from state.js (position tracking) since this is process-level,
 * not persisted, and resets on every restart by design.
 */
export const startedAt = Date.now();

let lastTickAt = null;

export function markTick() {
  lastTickAt = Date.now();
}

export function getLastTickAt() {
  return lastTickAt;
}
