import { PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { log } from "./logger.js";

let _DLMM = null;
async function getDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

/**
 * Close a DLMM position fully (claim fees + remove 100% liquidity + close account).
 * Mirrors the standard @meteora-ag/dlmm close pattern. Returns:
 *   { success: true, txs: [...], base_mint }
 *   { success: false, error }
 */
export async function closePositionOnChain(connection, wallet, positionAddress, poolAddress) {
  const DLMM = await getDlmmSdk();
  let pool;
  try {
    pool = await DLMM.create(connection, new PublicKey(poolAddress));
  } catch (e) {
    return { success: false, error: `Could not load pool: ${e.message}`, txs: [] };
  }
  const positionPubKey = new PublicKey(positionAddress);
  const baseMint = pool.lbPair.tokenXMint.toString();

  const claimTxHashes = [];
  const closeTxHashes = [];

  const existingAccount = await connection.getAccountInfo(positionPubKey).catch(() => "error");
  if (existingAccount === null || (existingAccount !== "error" && !existingAccount.owner.equals(pool.program.programId))) {
    log("close", `Position ${positionAddress} already closed on-chain (account missing or reassigned) — nothing to do`);
    return { success: true, txs: [], base_mint: baseMint };
  }

  try {
    log("close", `Claiming fees for ${positionAddress}`);
    const positionData = await pool.getPosition(positionPubKey);
    const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: positionData });
    for (const tx of claimTxs || []) {
      const hash = await sendAndConfirmTransaction(connection, tx, [wallet]);
      claimTxHashes.push(hash);
    }
  } catch (e) {
    log("close_warn", `Claim fees failed or nothing to claim: ${e.message}`);
  }

  let hasLiquidity = false;
  let fromBinId = -887272;
  let toBinId = 887272;
  try {
    const positionData = await pool.getPosition(positionPubKey);
    const processed = positionData?.positionData;
    if (processed) {
      fromBinId = processed.lowerBinId ?? fromBinId;
      toBinId = processed.upperBinId ?? toBinId;
      const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
      hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
    }
  } catch (e) {
    log("close_warn", `Could not read position liquidity state: ${e.message}`);
  }

  try {
    if (hasLiquidity) {
      log("close", `Removing liquidity and closing account for ${positionAddress}`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId,
        toBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });
      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        const hash = await sendAndConfirmTransaction(connection, tx, [wallet]);
        closeTxHashes.push(hash);
      }
    } else {
      log("close", `No liquidity detected, closing empty position account ${positionAddress}`);
      const closeTx = await pool.closePosition({ owner: wallet.publicKey, position: { publicKey: positionPubKey } });
      const hash = await sendAndConfirmTransaction(connection, closeTx, [wallet]);
      closeTxHashes.push(hash);
    }
  } catch (e) {
    // sendAndConfirmTransaction can throw (expired blockhash, duplicate-submit
    // races) even when the transaction actually landed. Verify on-chain
    // before declaring failure — otherwise a position that's genuinely
    // closed gets reported as a failed close and stays "open" in state
    // forever (invisible to the live API, never retried, never reconciled).
    const info = await connection.getAccountInfo(positionPubKey).catch(() => "error");
    if (info === null) {
      const txs = [...claimTxHashes, ...closeTxHashes];
      log("close", `Close tx for ${positionAddress} errored (${e.message}) but account is gone on-chain — treating as closed`);
      return { success: true, txs, base_mint: baseMint };
    }
    return { success: false, error: `Close transaction failed: ${e.message}`, txs: [...claimTxHashes, ...closeTxHashes] };
  }

  // Give RPC a moment, then verify the position account is gone.
  await new Promise((r) => setTimeout(r, 4000));
  let closedConfirmed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const info = await connection.getAccountInfo(positionPubKey).catch(() => "error");
    if (info === null) {
      closedConfirmed = true;
      break;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
  }

  const txs = [...claimTxHashes, ...closeTxHashes];
  if (!closedConfirmed) {
    return { success: false, error: "Close tx sent but position still appears open after verification window", txs, base_mint: baseMint };
  }

  log("close", `Closed ${positionAddress} — txs: ${txs.join(", ")}`);
  return { success: true, txs, base_mint: baseMint };
}
