import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { log } from "./logger.js";
import { config } from "./config.js";

const ORDER_URL = "https://api.jup.ag/swap/v2/order";
const EXECUTE_URL = "https://api.jup.ag/swap/v2/execute";
const DUST_LAMPORTS = 1000n; // ignore near-zero leftover balances

function jupiterHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (process.env.JUPITER_API_KEY) headers["x-api-key"] = process.env.JUPITER_API_KEY;
  return headers;
}

/**
 * Sum SPL token balance across all token accounts owned by `owner` for `mint`.
 * Returns { raw: bigint, decimals: number }.
 */
export async function getTokenBalance(connection, owner, mint) {
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  let raw = 0n;
  let decimals = 0;
  for (const { account } of resp.value) {
    const info = account.data.parsed.info;
    raw += BigInt(info.tokenAmount.amount);
    decimals = info.tokenAmount.decimals;
  }
  return { raw, decimals };
}

const SWAP_MAX_ATTEMPTS = 3;
const SWAP_RETRY_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function swapToSolOnce(wallet, inputMint, amountRaw) {
  const orderParams = new URLSearchParams({
    inputMint,
    outputMint: config.tokens.SOL,
    amount: amountRaw.toString(),
    taker: wallet.publicKey.toString(),
    slippageBps: String(config.swap.slippageBps),
  });
  const orderRes = await fetch(`${ORDER_URL}?${orderParams.toString()}`, { headers: jupiterHeaders() });
  if (!orderRes.ok) {
    const body = await orderRes.text().catch(() => "");
    throw new Error(`order HTTP ${orderRes.status}: ${body.slice(0, 200)}`);
  }
  const order = await orderRes.json();
  if (!order.transaction) {
    throw new Error(order.errorMessage || `no route/transaction returned (errorCode: ${order.errorCode ?? "unknown"})`);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([wallet]);
  const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

  const executeRes = await fetch(EXECUTE_URL, {
    method: "POST",
    headers: jupiterHeaders(),
    body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
  });
  if (!executeRes.ok) {
    const body = await executeRes.text().catch(() => "");
    throw new Error(`execute HTTP ${executeRes.status}: ${body.slice(0, 200)}`);
  }
  const result = await executeRes.json();
  if (result.status !== "Success") {
    throw new Error(result.error || result.status || "execute failed");
  }

  return result.signature;
}

/**
 * Swap `amountRaw` of `inputMint` to SOL via Jupiter's order+execute flow
 * (api.jup.ag/swap/v2). Jupiter's own relay broadcasts & lands the tx, so
 * no local RPC send/confirm is needed. Retries up to SWAP_MAX_ATTEMPTS times
 * on failure (fresh order each attempt, since routes/blockhashes go stale).
 * Returns { success, signature } or { success:false, error }.
 */
export async function swapToSol(wallet, inputMint, amountRaw) {
  if (amountRaw <= DUST_LAMPORTS) {
    return { success: true, skipped: true, reason: "dust amount, nothing to swap" };
  }

  let lastError;
  for (let attempt = 1; attempt <= SWAP_MAX_ATTEMPTS; attempt++) {
    try {
      const signature = await swapToSolOnce(wallet, inputMint, amountRaw);
      log("swap", `Swapped ${inputMint.slice(0, 8)} → SOL, tx: ${signature}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      return { success: true, signature };
    } catch (err) {
      lastError = err;
      log("swap_error", `Swap ${inputMint.slice(0, 8)} → SOL failed (attempt ${attempt}/${SWAP_MAX_ATTEMPTS}): ${err.message}`);
      if (attempt < SWAP_MAX_ATTEMPTS) await sleep(SWAP_RETRY_DELAY_MS);
    }
  }

  return { success: false, error: lastError.message };
}
