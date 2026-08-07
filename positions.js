/**
 * Fetch open DLMM positions + PnL for a wallet using Meteora's public
 * portfolio/PnL APIs directly.
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { connection } from "./client.js";
import { log } from "./logger.js";

const PORTFOLIO_API = "https://dlmm.datapi.meteora.ag/portfolio/open";
const PNL_API = "https://dlmm.datapi.meteora.ag/positions";

let _DLMM = null;
async function getDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

/**
 * Whether a position has liquidity deposited on BOTH tokens (dual-sided) vs
 * only one ("single-sided", the usual DLMM one-sided-entry pattern). Not
 * exposed by the portfolio/PnL REST APIs, so read straight from the on-chain
 * DLMM SDK — same pattern close.js already uses to close positions.
 * `dlmmPool` is passed in so callers can reuse one instance per pool across
 * all its positions in a tick, instead of re-fetching pool state per position.
 * Returns null (unknown) on any read failure — callers should treat that as
 * "don't apply dual-side-only rules" rather than guessing true/false.
 *
 * Excludes the active bin from the totals. The active bin is, by DLMM
 * construction, always a mix of both tokens (it's the bin currently being
 * traded through) — so any position whose range merely touches the active
 * bin picks up a nonzero, usually dust-sized, amount of the "other" token
 * there even on a genuinely single-sided deposit. Confirmed on-chain: a
 * position deposited entirely in SOL across ~95 bins had totalXAmount > 0
 * only because the single active bin held ~21.78 units (6-decimal mint) of
 * the base token — every other bin in range was 100% SOL. Checking totals
 * including that bin false-positives as dual-side on nearly every position,
 * since almost all ranges are opened touching the active bin.
 */
async function detectDualSided(dlmmPool, positionAddress) {
  try {
    const { positionData } = await dlmmPool.getPosition(new PublicKey(positionAddress));
    const activeId = dlmmPool.lbPair.activeId;
    const bins = positionData?.positionBinData || [];
    let totalX = new BN(0);
    let totalY = new BN(0);
    for (const bin of bins) {
      if (bin.binId === activeId) continue;
      totalX = totalX.add(new BN(bin.positionXAmount || "0"));
      totalY = totalY.add(new BN(bin.positionYAmount || "0"));
    }
    return totalX.gt(new BN(0)) && totalY.gt(new BN(0));
  } catch (e) {
    log("positions_warn", `Dual-side check failed for ${positionAddress.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function deriveOpenPnlPct(p, solMode) {
  const deposit = solMode ? safeNum(p.allTimeDeposits?.total?.sol) : safeNum(p.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode ? safeNum(p.unrealizedPnl?.balancesSol) : safeNum(p.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode ? safeNum(p.allTimeWithdrawals?.total?.sol) : safeNum(p.allTimeWithdrawals?.total?.usd);
  const fees = solMode ? safeNum(p.allTimeFees?.total?.sol) : safeNum(p.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

async function fetchPnlForPool(poolAddress, walletAddress) {
  const url = `${PNL_API}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("positions_warn", `PnL API HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const rows = data.positions || data.data || [];
    const byAddress = {};
    for (const row of rows) {
      const addr = row.positionAddress || row.address || row.position;
      if (addr) byAddress[addr] = row;
    }
    return byAddress;
  } catch (e) {
    log("positions_warn", `PnL fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

/**
 * Returns an array of open positions with PnL/range/fee data, shaped for
 * state.js's updatePnlAndCheckExits().
 */
export async function fetchOpenPositions(walletAddress, { solMode = false, checkDualSided = false } = {}) {
  const res = await fetch(`${PORTFOLIO_API}?user=${walletAddress}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Portfolio API ${res.status}: ${body.slice(0, 200)}`);
  }
  const portfolio = await res.json();
  const pools = portfolio.pools || [];

  const positions = [];
  for (const pool of pools) {
    const pnlByAddress = await fetchPnlForPool(pool.poolAddress, walletAddress);
    const isOOR = pool.outOfRange;

    // Lazily created only if this pool actually has positions to check, and
    // shared across all of them so the pool account is only fetched once.
    let dlmmPool = null;
    let dlmmPoolFailed = false;
    async function getDlmmPool() {
      if (dlmmPool || dlmmPoolFailed) return dlmmPool;
      try {
        const DLMM = await getDlmmSdk();
        dlmmPool = await DLMM.create(connection, new PublicKey(pool.poolAddress));
      } catch (e) {
        dlmmPoolFailed = true;
        log("positions_warn", `DLMM.create failed for pool ${pool.poolAddress.slice(0, 8)}: ${e.message}`);
      }
      return dlmmPool;
    }

    for (const positionAddress of pool.listPositions || []) {
      const p = pnlByAddress[positionAddress];
      if (!p) {
        log("positions_warn", `No PnL data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — skipping this tick`);
        continue;
      }

      const reportedPnlPct = solMode ? maybeNum(p.pnlSolPctChange) : maybeNum(p.pnlPctChange);
      const derivedPnlPct = deriveOpenPnlPct(p, solMode);
      const pnlPct = reportedPnlPct ?? derivedPnlPct;
      const pnlPctSuspicious = pnlPct == null;
      const depositTotal = solMode ? safeNum(p.allTimeDeposits?.total?.sol) : safeNum(p.allTimeDeposits?.total?.usd);
      const lowerBin = p.lowerBinId ?? null;
      const upperBin = p.upperBinId ?? null;
      const activeBin = p.poolActiveBinId ?? null;
      // Which side of the range price broke out of, when out of range: bin ids
      // are ordered low-price -> high-price, so "below" (kiri) means price
      // dropped under the range (bearish break), "above" (kanan) means it
      // ran past the top (bullish break) — used to gate stop-loss on kiri only.
      const oorSide =
        lowerBin != null && upperBin != null && activeBin != null
          ? activeBin < lowerBin
            ? "below"
            : activeBin > upperBin
              ? "above"
              : null
          : null;

      let isDualSided = null;
      if (checkDualSided) {
        const activePool = await getDlmmPool();
        if (activePool) isDualSided = await detectDualSided(activePool, positionAddress);
      }

      positions.push({
        position: positionAddress,
        pool: pool.poolAddress,
        pair: `${pool.tokenX || "?"}/${pool.tokenY || "SOL"}`,
        base_mint: pool.tokenXMint || null,
        lower_bin: lowerBin,
        upper_bin: upperBin,
        active_bin: activeBin,
        oor_side: oorSide,
        is_dual_side: isDualSided,
        in_range: p.isOutOfRange != null ? !p.isOutOfRange : !(pool.positionsOutOfRange?.includes(positionAddress) ?? isOOR),
        pnl_pct: pnlPct != null ? round(pnlPct, 2) : null,
        pnl_pct_suspicious: pnlPctSuspicious,
        deposit_total: round(depositTotal, 6),
        fee_per_tvl_24h: p.feePerTvl24h != null ? round(parseFloat(p.feePerTvl24h), 2) : null,
        age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
        unclaimed_fees_usd: round(
          solMode
            ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
            : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd),
        ),
        total_value_usd: round(solMode ? safeNum(p.unrealizedPnl?.balancesSol) : safeNum(p.unrealizedPnl?.balances)),
      });
    }
  }

  return positions;
}
