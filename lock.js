/**
 * Shared in-memory lock so the autonomous tick loop and the Telegram
 * command handlers never try to close the same position at the same time.
 */
const closing = new Set();

export function tryLock(position) {
  if (closing.has(position)) return false;
  closing.add(position);
  return true;
}

export function unlock(position) {
  closing.delete(position);
}

export function isLocked(position) {
  return closing.has(position);
}
