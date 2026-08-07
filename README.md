# exit-bot

Standalone exit manager for [Meteora](https://meteora.ag) DLMM positions on Solana. It watches
positions you've **already opened manually**, then closes them automatically on take-profit,
stop-loss, trailing take-profit, out-of-range, or low-yield conditions — with a Telegram menu
for manual control.

It does not open positions, screen pools, or make any trading decisions beyond exiting.

## Features

- Take-profit / stop-loss / trailing take-profit
- Out-of-range exit (with optional wait timer)
- Low-yield exit (fee/TVL threshold)
- Separate rule set for dual-sided positions
- Telegram bot: `/positions`, `/pause`, `/resume`, live settings toggles
- Auto-swap proceeds after close (via Jupiter)

## Requirements

- Node.js 18+
- A **dedicated** Solana wallet for this bot (separate from any other bot/wallet you run)
- Your own Solana RPC endpoint (e.g. [Helius](https://helius.dev)) — public RPCs will rate-limit you
- Existing Meteora DLMM position(s) opened under that wallet
- (Optional) A Telegram bot token + chat ID, from [@BotFather](https://t.me/BotFather)
- (Optional) A Jupiter API key, for higher rate limits on auto-swap

## Setup

```bash
npm install
cp .env.example .env
cp user-config.example.json user-config.json
```

Fill in `.env`:

| Variable              | Required | Notes                                      |
|-----------------------|----------|---------------------------------------------|
| `WALLET_PRIVATE_KEY`  | yes      | base58, dedicated wallet                    |
| `RPC_URL`              | yes      | your own RPC endpoint                       |
| `TELEGRAM_BOT_TOKEN`   | no       | enables Telegram notifications/control      |
| `TELEGRAM_CHAT_ID`     | no       |                                              |
| `JUPITER_API_KEY`      | no       | higher rate limits for auto-swap            |
| `LOG_LEVEL`            | no       | defaults to `info`                          |

Fill in `user-config.json` — some thresholds have **no default on purpose** (a wrong silent
default could mean no stop-loss), so the bot refuses to start until they're set:
`stopLossPct`, `trailingTakeProfit`, `trailingTriggerPct`, `trailingDropPct`,
`outOfRangeWaitMinutes`, `minFeePerTvl24h`, `minAgeBeforeYieldCheck`, `solMode`.

See the comments in `user-config.example.json` for what each field does — most others have
sane defaults and are optional.

## Running

```bash
node index.js
# or, to keep it running persistently:
pm2 start index.js --name exit-bot
```

## Credits

Exit/close logic pada bot ini banyak mengadaptasi sampel dari [Meridian](https://github.com/yunus-0x/meridian),
bot open-source milik Yunus, dengan beberapa penyesuaian tambahan untuk kebutuhan bot ini. Digunakan dengan izin.

## Disclaimer

This bot executes on-chain transactions with a private key you control. It is provided as-is,
with no warranty. Test with small position sizes first. You are responsible for your own funds
and configuration.

## License

No license is granted. All rights reserved — see repository owner for permissions.
