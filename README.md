# HYPERPUMP

Launch coins on pump.fun with creator fees locked to a treasury. Each coin picks any Hyperliquid perp (BTC, ETH, SOL, HYPE, memecoins, stocks and every other listed market), a side and a take-profit tier. Once a coin's fees reach $50, they are meant to open a leveraged Hyperliquid position, and a win buys back and burns the coin.

Copied from YOLOPAD. **Positions are not built yet**: this server lists coins and tracks fee progress, nothing more. There is no Hyperliquid execution bot.

Zero npm dependencies. Needs Node >= 22.5.

## Run
    PINATA_JWT=... RPC_URL=https://your-paid-rpc TREASURY_ADDRESS=... node --no-warnings server.mjs
Local UI test with no external calls and eight sample coins: `MOCK=1 node --no-warnings server.mjs`

## Front end
Pages: `/` (launch and Explore), `/coin/<mint>` (one coin: fee progress and position details, from `GET /api/coin/<mint>`). Both load `style.css`. Share tags (Open Graph and X card, image `og.png`) are filled with the site's address when served.

`public/index.html` is the single page (the Arcade layout in Terminal's teal and mint colors). It reads the ids and `data-*` hooks listed at the top of `public/app.js`, which holds the wallet, launch, market picker and Explore logic. The other three explored designs were removed.

## Env
- PINATA_JWT  (required) free Pinata account JWT, used to pin the coin image and metadata
- RPC_URL     (strongly advised) a paid Solana RPC; the public one rate-limits
- DATA_DIR    where hyperpump.db (SQLite) lives; mount a persistent volume here on Railway
- TREASURY_ADDRESS  (required) public address that receives every coin's creator fees. Launching is paused until it is set
- HYPERPUMP_CA  the HYPERPUMP token's contract address. Leave it unset until the token launches; the site shows "Coming soon" in the CA bar, then the address with Copy and pump.fun buttons once it is set
- PUBLIC_URL  (advised) your site's address, e.g. https://hyperpump.xyz, used for the share-card image. If unset, the request's host is used
- PORT

## Changes from YOLOPAD
- Markets are no longer hardcoded. `GET /api/markets` returns every live Hyperliquid perp (main exchange plus builder-deployed exchanges such as stocks), with max leverage, mark price and 24h volume, cached for 5 minutes. A launch is rejected unless its market is on that list, and the coin stores the max leverage at launch. If Hyperliquid cannot be reached the server serves the last good list, or a short BTC/ETH/SOL/HYPE fallback. In `MOCK=1` it serves 44 sample markets.
- Builder markets are named `dex:COIN` (for example `xyz:TSLA`). **The naming and the `perpDexs` response shape are unverified**, because the build sandbox cannot reach api.hyperliquid.xyz. Check `curl localhost:PORT/api/markets` on your server and look for `"source":"hyperliquid"`.
- The picker shows BTC, ETH, SOL, HYPE plus the top markets by volume, and a search box finds any of them.
- Take-profit tiers are Chill 2x, Degen 5x and Hyper-Degen 10x margin (were 2x, 10x, 100x). A tier needs a price move of (tier - 1) / leverage, so the tier buttons show that move for the chosen market, and tiers needing more than 100% (`MAX_MOVE_PCT` in `server.mjs`) are switched off in the page and rejected by the server. The odds stay about 1 in the tier on any market, but a big move can take months. The fee threshold is $50.
- Fee balances convert to USD with the SOL mark price from Hyperliquid (CoinGecko as a backup). CoinGecko is no longer used for the four majors.
- The database file is `hyperpump.db`. A YOLOPAD database will not load coins with the old tiers.
- The CA bar is back as a slot for the HYPERPUMP token's own address (`HYPERPUMP_CA`). It is not the old per-coin CA bar.

## Not verified (the build sandbox could not reach Solana, pump.fun or npm)
- the PumpPortal trade-local create call, and the units of the dev buy amount
- the creator-vault PDA seed ("creator-vault") and that the vault holds plain SOL; the fee numbers in Explore depend on it
- fee numbers are per creator wallet (pump.fun pools a creator's fees across all their coins), so a creator with several coins sees the same number on each
- the web3.js and pump-sdk imports load from esm.sh in the visitor's browser

## Fee redirect
Each launch is ONE transaction: pump.fun create_v2 + create_fee_sharing_config + update_fee_shares_v2 (100% to TREASURY_ADDRESS, admin revoked). If the transaction would be too large, the page falls back to two or three sequential transactions.
The server reads the coin's sharing_config account on-chain and only lists the coin if it pays 100% to the treasury and is locked (see verify.mjs, test with `node test-verify.mjs`).
Not verified against mainnet: the SDK calls (@pump-fun/pump-sdk 4.1.0 via esm.sh), the one-transaction size, the optional initial buy via PumpPortal.

## Still to build
- the Hyperliquid bot: watch each treasury balance, open the position with an agent wallet that can trade but not withdraw, tag orders with a builder code, close at take profit, run the buyback and burn
- a funding path from SOL fees on Solana to USDC margin on Hyperliquid
- legal review: leveraged trading is restricted in places, including the U.S. and Ontario
