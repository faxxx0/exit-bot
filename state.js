/**
 * Standalone position tracking for exit-bot (peak PnL confirmation,
 * consecutive-tick exit-signal confirmation), persisted to its own file.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "state.json");

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

/**
 * Auto-track a position discovered on-chain that isn't in state.json yet.
 */
export function ensurePositionTracked(position_address, positionData) {
  const state = load();
  if (state.positions[position_address] && !state.positions[position_address].closed) return;

  state.positions[position_address] = {
    position: position_address,
    pool: positionData.pool || null,
    pool_name: positionData.pair || (positionData.pool || "?").slice?.(0, 8) || "?",
    base_mint: positionData.base_mint || null,
    // Snapshot of dual-sidedness taken THIS tick only (right around position
    // open, since ensurePositionTracked only runs once per position). Frozen
    // here rather than re-derived live every tick — a position deposited
    // single-sided naturally ends up holding both tokens as price moves
    // through its range and converts bin contents, which made a live
    // recompute misreport plain single-sided SOL positions as "Dual Side".
    // Unknown (null from a failed on-chain read) is treated as
    // not-dual-side, same as detectDualSided()'s documented caller contract.
    is_dual_side_at_open: positionData.is_dual_side === true,
    deployed_at: new Date().toISOString(),
    // Unlike deployed_at (re-armed by detectTopup for the grace window), this
    // never changes after creation — reports use it as the true hold-duration start.
    first_deployed_at: new Date().toISOString(),
    out_of_range_since: positionData.in_range === false ? new Date().toISOString() : null,
    closed: false,
    closed_at: null,
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_exit_action: null,
    pending_exit_count: 0,
    trailing_active: false,
    dual_side_trailing_active: false,
    last_deposit_total: positionData.deposit_total ?? null,
    last_raw_pnl_pct: positionData.pnl_pct ?? null,
    topup_settling: false,
    pre_topup_pnl_pct: null,
    topup_settling_started_at: null,
    topup_settle_confirm_count: 0,
  };
  save(state);
  log("state", `Tracked new position ${position_address.slice(0, 8)} in pool ${state.positions[position_address].pool_name}`);
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls
 * where the candidate stays above the current peak.
 */
export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    save(state);
    log("state", `Position ${position_address.slice(0, 8)} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}%`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal. Fires only after
 * `confirmTicks` consecutive polls report the SAME action.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
  }
  save(state);
  if (fire) log("state", `Position ${position_address.slice(0, 8)} exit signal "${signal}" confirmed`);
  return { fire, action: signal, count };
}

/**
 * True while a position is still within its post-open (or post-top-up)
 * settling window — see detectTopup() for why top-ups re-arm this.
 */
export function inGracePeriod(position_address, graceSec = 20) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;
  const ageSinceTrackedSec = (Date.now() - new Date(pos.deployed_at).getTime()) / 1000;
  return ageSinceTrackedSec < graceSec;
}

/**
 * Re-arm the open-grace window (deployed_at) and the topup-settling guard on
 * `pos`. Shared by detectTopup() (real deposit-jump signal) and
 * detectPnlSpike() (magnitude-based fallback signal) — both react to the
 * same underlying artifact and should suppress checks identically. Caller
 * still owns save()/logging.
 */
function armTopupSettling(pos) {
  pos.deployed_at = new Date().toISOString();
  // The fixed-length grace window above isn't always enough — the indexer's
  // balances/deposits reconciliation lag is variable and can run well past
  // it (observed 2.5min+ after back-to-back top-ups). So on top of the
  // timed grace, hold a baseline (the last confirmed-real peak) and keep
  // suppressing exit/peak checks in isTopupSettling() until the reported
  // PnL actually comes back down near that baseline, however long that takes.
  pos.topup_settling = true;
  pos.pre_topup_pnl_pct = pos.peak_pnl_pct ?? 0;
  pos.topup_settling_started_at = new Date().toISOString();
  pos.topup_settle_confirm_count = 0;
}

/**
 * Meteora's DLMM indexer updates a position's live balance before it
 * updates allTimeDeposits when you add liquidity to an existing position,
 * so pnl = (balances - deposit) / deposit briefly reports the added
 * capital itself as profit (e.g. add 0.5 SOL on top of 1 SOL -> reads as
 * +50% PnL). allTimeDeposits only ever increases on a real deposit txn
 * (never on withdrawals or fee accrual), so any upward jump is a reliable
 * "size was just added" signal.
 *
 * When detected, re-arm the same open-grace window used for fresh
 * positions (deployed_at) so instant TP/SL/trailing checks and peak
 * tracking pause until the indexer catches up.
 */
export function detectTopup(position_address, positionData) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentDeposit = positionData.deposit_total;
  if (currentDeposit == null) return false;

  const prevDeposit = pos.last_deposit_total;
  pos.last_deposit_total = currentDeposit;

  if (prevDeposit == null || prevDeposit <= 0) {
    save(state);
    return false;
  }

  const jump = currentDeposit - prevDeposit;
  const isRealTopup = jump > Math.max(prevDeposit * 0.005, 0.0005);

  if (isRealTopup) {
    armTopupSettling(pos);
    save(state);
    const pct = ((jump / prevDeposit) * 100).toFixed(1);
    log(
      "state",
      `Position ${position_address.slice(0, 8)} deposit jumped +${pct}% (size top-up) — re-arming grace period to avoid reading it as PnL`,
    );
    return true;
  }

  save(state);
  return false;
}

/**
 * Fallback for detectTopup(): the indexer updates live balance (which
 * pnl_pct is derived from) BEFORE it updates allTimeDeposits, so on a
 * top-up the phantom-profit spike can show up, get confirmed as a peak
 * (confirmPeak needs just confirmTicks * pollIntervalSec — a few seconds),
 * and trigger an instant TAKE_PROFIT/trailing close before allTimeDeposits
 * ever catches up and detectTopup gets a chance to fire (observed: deposit
 * jump can lag 45s-2.5min+ behind the balance jump). detectTopup's signal
 * arrives too late to help in that case.
 *
 * This catches the same artifact by its symptom instead of its cause: an
 * implausibly large single-tick jump in reported PnL, regardless of
 * whether allTimeDeposits has moved yet. A real top-up's balance jump and a
 * genuine price spike both produce large jumps, but gating exits behind the
 * same settling window either way is the safe tradeoff — a real spike just
 * waits out the settling window before firing for real.
 */
export function detectPnlSpike(position_address, currentPnlPct, mgmtConfig) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const prevPnlPct = pos.last_raw_pnl_pct;
  pos.last_raw_pnl_pct = currentPnlPct;

  if (currentPnlPct == null || prevPnlPct == null) {
    save(state);
    return false;
  }

  const jump = currentPnlPct - prevPnlPct;
  const threshold = mgmtConfig.pnlSpikeGuardPct ?? 15;

  if (!pos.topup_settling && jump >= threshold) {
    armTopupSettling(pos);
    save(state);
    log(
      "state",
      `Position ${position_address.slice(0, 8)} PnL jumped +${jump.toFixed(2)}pp in one tick (${prevPnlPct.toFixed(2)}% -> ${currentPnlPct.toFixed(2)}%) — treating as phantom top-up spike, re-arming settling guard`,
    );
    return true;
  }

  save(state);
  return false;
}

/**
 * True while a position is still "settling" after a size top-up: the
 * reported PnL hasn't yet come back down near the pre-top-up baseline, so
 * it's still likely showing the newly-added capital as phantom profit
 * rather than real gains. Unlike inGracePeriod(), this isn't a fixed
 * timer — the indexer's balances/deposits reconciliation lag after a
 * top-up varies and can outlast a short fixed window (see detectTopup()).
 * A maxSettleSec safety valve prevents this from stalling forever on a
 * position that's genuinely mooning right after a top-up.
 *
 * Resolving "settled" requires BOTH a minimum elapsed time (minSettleSec)
 * AND several consecutive within-tolerance readings (settleConfirmTicks).
 * Without these, a single early poll — taken before the indexer has even
 * started reconciling — can read coincidentally close to baseline (e.g.
 * a freshly-opened position with baseline 0% often still reads ~0% for a
 * moment right at top-up) and clear settling instantly, before the actual
 * phantom-profit artifact shows up (observed 1-2min later in practice).
 * That left the position fully unprotected right up until the spike hit,
 * causing false TAKE_PROFIT closes on pure size top-ups.
 */
export function isTopupSettling(position_address, currentPnlPct, mgmtConfig) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || !pos.topup_settling) return false;

  const maxSettleSec = mgmtConfig.topupMaxSettleSec ?? 300;
  const minSettleSec = mgmtConfig.topupSettleMinSec ?? 45;
  const settleConfirmTicks = Math.max(1, mgmtConfig.topupSettleConfirmTicks ?? 3);
  const elapsedSec = (Date.now() - new Date(pos.topup_settling_started_at).getTime()) / 1000;
  if (elapsedSec >= maxSettleSec) {
    pos.topup_settling = false;
    pos.topup_settle_confirm_count = 0;
    save(state);
    log(
      "state",
      `Position ${position_address.slice(0, 8)} topup settling window timed out after ${Math.floor(elapsedSec)}s — resuming normal PnL tracking (current reading accepted as real)`,
    );
    return false;
  }

  if (currentPnlPct == null) return true;

  const baseline = pos.pre_topup_pnl_pct ?? 0;
  const tolerancePct = mgmtConfig.topupSettleTolerancePct ?? 3;
  const withinTolerance = currentPnlPct - baseline <= tolerancePct;

  if (withinTolerance && elapsedSec >= minSettleSec) {
    pos.topup_settle_confirm_count = (pos.topup_settle_confirm_count ?? 0) + 1;
    if (pos.topup_settle_confirm_count >= settleConfirmTicks) {
      pos.topup_settling = false;
      pos.topup_settle_confirm_count = 0;
      save(state);
      log(
        "state",
        `Position ${position_address.slice(0, 8)} PnL settled to ${currentPnlPct.toFixed(2)}% (baseline ${baseline.toFixed(2)}%) — resuming normal PnL tracking`,
      );
      return false;
    }
    save(state);
    return true;
  }

  if (pos.topup_settle_confirm_count) {
    pos.topup_settle_confirm_count = 0;
    save(state);
  }

  return true;
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates out_of_range_since / trailing_active as a side effect.
 * Returns { action, reason } or null.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, oor_side, fee_per_tvl_24h, age_minutes } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;
  // Frozen at position-open (see ensurePositionTracked) — NOT positionData's
  // live is_dual_side, which drifts as price moves through the range and
  // converts a single-sided deposit's bins into a mix of both tokens.
  const isDualSideAtOpen = pos.is_dual_side_at_open === true;

  let changed = false;

  // Dual-side positions get their own trailing (dualSideTrailing* below)
  // when dual side is enabled — skip arming the regular trailing so it
  // can't race the dual-side one and fire TRAILING_TP instead of
  // DUAL_SIDE_TRAILING_TP.
  if (
    mgmtConfig.trailingTakeProfit &&
    !pos.trailing_active &&
    !(mgmtConfig.dualSideEnabled && isDualSideAtOpen) &&
    (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct
  ) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address.slice(0, 8)} trailing TP activated (peak: ${pos.peak_pnl_pct}%)`);
  }

  if (
    mgmtConfig.dualSideEnabled &&
    mgmtConfig.dualSideTrailingEnabled &&
    isDualSideAtOpen &&
    !pos.dual_side_trailing_active &&
    mgmtConfig.dualSideTrailingTriggerPct != null &&
    (pos.peak_pnl_pct ?? 0) >= mgmtConfig.dualSideTrailingTriggerPct
  ) {
    pos.dual_side_trailing_active = true;
    changed = true;
    log("state", `Position ${position_address.slice(0, 8)} dual side trailing TP activated (peak: ${pos.peak_pnl_pct}%)`);
  }

  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
  }

  if (changed) save(state);

  // ── Grace period after deploy ──
  // Meteora's DLMM indexer records the deposit before it reflects real
  // balances, so a freshly-opened position can briefly report ~-100% PnL
  // (balances=0 vs a real deposit) even though nothing was actually lost.
  // Suppress instant-close checks until the indexer has had time to catch up.
  if (inGracePeriod(position_address, mgmtConfig.exitGracePeriodSec ?? 20)) {
    return null;
  }

  // ── Settling after a size top-up ──
  // Time-based grace above may have already elapsed, but the top-up's
  // phantom-PnL artifact can outlast it — see isTopupSettling().
  if (isTopupSettling(position_address, currentPnlPct, mgmtConfig)) {
    return null;
  }

  // ── Strategi Dual Side (dual-sided positions only) ──
  // Independent TP/SL for positions deposited with liquidity on both tokens
  // X and Y at open. SL mode controls how PnL and "OOR kiri" combine — see config.js.
  if (mgmtConfig.dualSideEnabled && isDualSideAtOpen) {
    if (
      !pnl_pct_suspicious &&
      currentPnlPct != null &&
      mgmtConfig.dualSideTakeProfitPct != null &&
      currentPnlPct >= mgmtConfig.dualSideTakeProfitPct
    ) {
      return {
        action: "DUAL_SIDE_TP",
        reason: `Dual side TP: PnL ${currentPnlPct.toFixed(2)}% >= ${mgmtConfig.dualSideTakeProfitPct}%`,
      };
    }

    if (
      mgmtConfig.dualSideTrailingEnabled &&
      pos.dual_side_trailing_active &&
      !pnl_pct_suspicious &&
      currentPnlPct != null &&
      mgmtConfig.dualSideTrailingDropPct != null
    ) {
      const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
      if (dropFromPeak >= mgmtConfig.dualSideTrailingDropPct) {
        return {
          action: "DUAL_SIDE_TRAILING_TP",
          reason:
            `Dual side trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}%` +
            ` (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.dualSideTrailingDropPct}%)`,
        };
      }
    }

    const slMode = mgmtConfig.dualSideStopLossMode ?? "pnl_and_oor";
    const pnlHit =
      !pnl_pct_suspicious &&
      currentPnlPct != null &&
      mgmtConfig.dualSideStopLossPct != null &&
      currentPnlPct <= mgmtConfig.dualSideStopLossPct;
    const oorHit = oor_side === "below";
    const slFire = slMode === "oor_only" ? oorHit : slMode === "pnl_only" ? pnlHit : pnlHit && oorHit;

    if (slFire) {
      const modeLabel = slMode === "oor_only" ? "OOR kiri only" : slMode === "pnl_only" ? "PnL only" : "PnL + OOR kiri";
      return {
        action: "DUAL_SIDE_SL",
        reason:
          `Dual side SL (mode: ${modeLabel}): PnL ${currentPnlPct != null ? currentPnlPct.toFixed(2) + "%" : "?"}` +
          `, OOR kiri: ${oorHit ? "yes" : "no"}`,
      };
    }
  }

  // ── Take profit (instant close, unconditional) ──
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.takeProfitPct != null && currentPnlPct >= mgmtConfig.takeProfitPct) {
    return {
      action: "TAKE_PROFIT",
      reason: `Take profit: PnL ${currentPnlPct.toFixed(2)}% >= ${mgmtConfig.takeProfitPct}%`,
    };
  }

  // ── Stop loss (instant close) ──
  // Optionally gated on the position having broken out of range to the
  // downside ("OOR kiri" — active bin fell below lower_bin), so a PnL dip
  // that's still inside range doesn't get stopped out.
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    const oorLeftOk = !mgmtConfig.stopLossRequireOorLeft || oor_side === "below";
    if (oorLeftOk) {
      return {
        action: "STOP_LOSS",
        reason:
          `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%` +
          (mgmtConfig.stopLossRequireOorLeft ? " (OOR kiri confirmed)" : ""),
      };
    }
  }

  // ── Trailing TP ──
  // Same dual-side exclusion as the activation check above.
  if (
    !pnl_pct_suspicious &&
    pos.trailing_active &&
    !(mgmtConfig.dualSideEnabled && isDualSideAtOpen) &&
    currentPnlPct != null
  ) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
      };
    }
  }

  // ── Out of range too long ──
  if (mgmtConfig.outOfRangeExitEnabled && pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ──
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

export function recordClose(position_address, action, reason, pnlPct = null) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.close_action = action || null;
  pos.close_reason = reason || null;
  pos.close_pnl_pct = pnlPct;
  save(state);
  log("state", `Position ${position_address.slice(0, 8)} marked closed: ${reason}`);
}

