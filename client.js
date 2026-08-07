/**
 * Singleton wallet + RPC connection, shared by the autonomous tick loop
 * and the Telegram command handlers so there's only ever one of each.
 */
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import "./config.js"; // ensures .env is loaded (and threshold validation runs) before we touch process.env

export const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
export const connection = new Connection(process.env.RPC_URL, "confirmed");
