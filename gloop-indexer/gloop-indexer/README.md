# Gloop Indexer

A free-tier Keeta blockchain indexer + analytics API. Powers the deep analytics, holdings panel, transaction feed, and historical charts in the Gloop NFT dashboard.

**Architecture:** Polls the Keeta chain via the official KeetaNet SDK, aggregates per-token stats into Postgres, serves it all as JSON. Same approach as Astrup and Keetools.

---

## What this gives your dashboard

When deployed, the Gloop dashboard automatically picks up:

- ✅ Real **24h volume per token** (USD, EUR, GBP, JPY, AED, CHF, KTA, etc.)
- ✅ Real **holders count per token**
- ✅ Real **historical charts** going back as long as the indexer's been running
- ✅ Real **live transaction feed**
- ✅ Real **wallet holdings panel** with USD values, prices, and 24h changes
- ✅ Real **network-wide stats** (total tokens, total holders, network 24h volume)

If the indexer isn't deployed yet, the dashboard falls back to demo data automatically. No breakage.

---

## Deploy to Railway (free tier, ~10 minutes)

### 1. Push to GitHub

```bash
cd gloop-indexer
git init && git add . && git commit -m "initial commit"
gh repo create gloop-indexer --public --source=. --push
# (or use the GitHub website to create + push)
```

### 2. Create a Railway project

1. Go to **[railway.app](https://railway.app)** → sign in with GitHub
2. **New Project** → **Deploy from GitHub repo** → pick `gloop-indexer`
3. Railway auto-detects Node.js and runs `npm start`

### 3. Add Postgres

In the same project:
1. Click **+ New** → **Database** → **Add PostgreSQL**
2. Railway auto-injects `DATABASE_URL` into your indexer service. No config needed.

### 4. Set environment variables

In your indexer service → **Variables** tab → add:

```
KEETA_NETWORK=main
KEETA_TOKENS=KTA:keeta_aabxxx...,USD:keeta_aabyyy...,EUR:keeta_aabzzz...
```

For `KEETA_TOKENS`, paste **real Keeta token account addresses** for every fiat/token you want tracked. Format: `SYMBOL:keeta_address`, comma-separated.

You can find token addresses on:
- **[explorer.keeta.com](https://explorer.keeta.com)** — search for a token symbol
- The Keeta team's partner anchor pages
- The KeetaNet GitHub repos

### 5. Get your public URL

Railway gives you a URL like `https://gloop-indexer-production.up.railway.app`. Click **Settings → Generate Domain** if it isn't auto-generated.

Test it:
```bash
curl https://your-domain.railway.app/api/health
# → {"ok":true,"service":"gloop-indexer","time":"..."}

curl https://your-domain.railway.app/api/tokens
# → {"tokens": [...]}
```

### 6. Wire the dashboard

In `gloop-dashboard-v2.html`, find this line near the top of the script:

```js
const INDEXER_BASE_URL = '';  // paste your Railway URL here
```

Replace with your URL:
```js
const INDEXER_BASE_URL = 'https://your-domain.railway.app';
```

Re-upload the HTML. Real data is now live.

---

## Free tier limits + workarounds

Railway free tier gives you:
- **$5/month free credits** (enough for a small always-on indexer)
- **500MB RAM, 1GB disk** per service
- **Unlimited HTTPS bandwidth**

If you hit the $5 cap:
- The indexer pauses until next month
- The dashboard falls back to its demo-data path automatically — no breakage
- Upgrade to Hobby plan for $5/month for unlimited

To stay free longer:
- The indexer **prunes old data automatically** (transactions > 7 days, snapshots > 30 days)
- Lower poll frequency: set `POLL_INTERVAL_MS=120000` (2 minutes instead of 1)

---

## Local development

```bash
# Install Postgres (Mac: brew install postgresql, then `brew services start postgresql`)
createdb gloop_indexer

# Install deps
npm install

# Copy env template
cp .env.example .env
# Edit .env, set KEETA_TOKENS to your real addresses

# Run
npm start
```

Visit `http://localhost:8080/` for the API index.

---

## API reference

| Endpoint | Returns |
|---|---|
| `GET /api/health` | Liveness check |
| `GET /api/network` | Network-wide stats (token count, holders, 24h volume, tx count) |
| `GET /api/tokens` | All tracked tokens with latest stats + USD prices |
| `GET /api/tokens/:id` | Single token detail (id = symbol or account_id) |
| `GET /api/tokens/:id/history?points=48` | Snapshot history for charts (default last 48 points = 48 minutes at default poll) |
| `GET /api/tx/recent?limit=50` | Recent transactions across all tokens |
| `GET /api/wallet/:address` | Live wallet holdings with USD valuations, KTA pinned first |

All endpoints return JSON. CORS-enabled for all origins.

---

## Architecture notes

**Polling, not subscriptions.** The KeetaNet SDK doesn't expose block subscriptions yet, so the indexer polls. Default 60s interval — Astrup and Keetools poll at similar rates.

**Two price oracles, automatic fallback:**
- Crypto (KTA, USDC, USDT, etc.) → CoinGecko `/simple/price` (no API key, 30 req/min free)
- Fiat (USD, EUR, GBP, JPY, ...) → `open.er-api.com` → fallback to `frankfurter.dev`
- Stablecoins with no oracle hit → assumed $1.00 (clearly labeled `price_source: 'assumed-peg'`)

**Idempotent.** Restart the indexer anytime — re-running won't duplicate data (UPSERT on tokens, ON CONFLICT DO NOTHING on transactions).

**Schema is bootstrapped on every startup.** If you change `src/schema.sql`, the new tables/indexes appear on next deploy.

---

## Troubleshooting

**"DATABASE_URL not set"** — On Railway, click your Postgres add-on → ensure it's in the same project as your indexer service. Railway auto-injects the var across services in one project.

**"history fetch failed for KTA"** — Either the SDK version doesn't match (try `npm install @keetanetwork/keetanet-client@latest` and redeploy) or the network is unreachable. Check Railway logs.

**Dashboard still shows DEMO DATA** — Check that `INDEXER_BASE_URL` in the HTML is set correctly AND that `https://your-url/api/health` returns 200 from a browser.

**Hit the $5/month cap** — The indexer pauses, dashboard falls back to demo data. Either upgrade Railway or set `POLL_INTERVAL_MS=300000` (5min) to cut runtime CPU.
