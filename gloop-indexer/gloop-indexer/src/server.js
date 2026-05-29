// Express API server. Exposes the indexed Keeta chain data as JSON.
//
// Endpoints:
//   GET /api/health                - liveness check (no DB)
//   GET /api/network               - network-wide stats (tokens count, total holders, 24h volume, tx/min)
//   GET /api/tokens                - all tracked tokens with current stats + prices
//   GET /api/tokens/:id            - single token detail
//   GET /api/tokens/:id/history    - snapshot history (for charts)
//   GET /api/tx/recent             - recent transactions feed (limit 50)
//   GET /api/wallet/:address       - holdings for a wallet, with USD valuations
//
// All endpoints are CORS-enabled for the dashboard. Read-only — no auth.

import express from 'express';
import cors from 'cors';
import KeetaNet from '@keetanetwork/keetanet-client';
import { bootstrapSchema, query } from './db.js';
import { enrichWithPrices, fetchCryptoPrices, fetchFiatRates } from './prices.js';
import { startIndexer } from './indexer.js';

const PORT = process.env.PORT || 8080;
const app = express();

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Serialize a BigInt-safe value. Postgres NUMERIC comes back as strings;
 * we keep them as strings to avoid JS precision loss for 18-decimal tokens.
 */
function safe(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = (typeof v === 'bigint') ? v.toString() : v;
  }
  return out;
}

/**
 * Convert a raw token amount (string of integer minor-units) to a JS number
 * using the token's decimals. Loses precision for very large numbers but
 * fine for display.
 */
function rawToFloat(rawStr, decimals) {
  if (!rawStr || rawStr === '0') return 0;
  try {
    const big = BigInt(rawStr);
    const divisor = 10n ** BigInt(decimals || 18);
    // Use a 6-decimal intermediate for fractional precision
    const whole = big / divisor;
    const remainder = big % divisor;
    return Number(whole) + Number(remainder) / Number(divisor);
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'gloop-indexer', time: new Date().toISOString() });
});

app.get('/api/network', async (req, res) => {
  try {
    const [tokensRow, holdersRow, txRow] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM tokens`),
      query(`SELECT COUNT(DISTINCT account_id)::int AS n FROM holder_balances WHERE balance_raw > 0`),
      query(`SELECT COUNT(*)::int AS n FROM transactions WHERE block_time >= NOW() - INTERVAL '24 hours'`)
    ]);

    // Compute network 24h USD volume by summing each token's volume × price
    const tokens = await query(`
      SELECT t.symbol, t.iso_code, t.decimals, t.category,
             COALESCE(s.volume_24h_raw, 0)::text AS volume_24h_raw
      FROM tokens t
      LEFT JOIN LATERAL (
        SELECT volume_24h_raw FROM token_snapshots
        WHERE account_id = t.account_id ORDER BY snapshot_time DESC LIMIT 1
      ) s ON true
    `);
    await enrichWithPrices(tokens);
    let volumeUsd = 0;
    for (const tok of tokens) {
      if (tok.price_usd && tok.volume_24h_raw) {
        volumeUsd += rawToFloat(tok.volume_24h_raw, tok.decimals) * tok.price_usd;
      }
    }

    res.json({
      total_tokens: tokensRow[0].n,
      total_holders: holdersRow[0].n,
      tx_count_24h: txRow[0].n,
      volume_24h_usd: volumeUsd,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[api] /network error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tokens', async (req, res) => {
  try {
    // Latest snapshot per token (LATERAL join → one row each)
    const rows = await query(`
      SELECT t.account_id, t.symbol, t.name, t.decimals, t.category, t.iso_code,
             t.total_supply::text AS total_supply, t.is_base_token,
             s.holder_count, s.tx_count_24h,
             s.volume_24h_raw::text AS volume_24h_raw,
             s.snapshot_time
      FROM tokens t
      LEFT JOIN LATERAL (
        SELECT * FROM token_snapshots
        WHERE account_id = t.account_id
        ORDER BY snapshot_time DESC LIMIT 1
      ) s ON true
      ORDER BY t.is_base_token DESC, t.symbol ASC
    `);
    await enrichWithPrices(rows);

    // Compute float-friendly volume/supply for the frontend
    for (const r of rows) {
      r.total_supply_float = rawToFloat(r.total_supply, r.decimals);
      r.volume_24h_float = rawToFloat(r.volume_24h_raw, r.decimals);
      r.volume_24h_usd = r.price_usd ? (r.volume_24h_float * r.price_usd) : null;
      r.market_cap_usd = r.price_usd ? (r.total_supply_float * r.price_usd) : null;
    }
    res.json({ tokens: rows.map(safe), updated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[api] /tokens error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tokens/:id', async (req, res) => {
  try {
    const [tok] = await query(`
      SELECT t.*, s.holder_count, s.tx_count_24h,
             s.volume_24h_raw::text AS volume_24h_raw,
             s.snapshot_time
      FROM tokens t
      LEFT JOIN LATERAL (
        SELECT * FROM token_snapshots
        WHERE account_id = t.account_id
        ORDER BY snapshot_time DESC LIMIT 1
      ) s ON true
      WHERE t.account_id = $1 OR t.symbol = $1
      LIMIT 1
    `, [req.params.id]);
    if (!tok) return res.status(404).json({ error: 'token not found' });

    const tokens = [tok];
    await enrichWithPrices(tokens);
    tok.total_supply_float = rawToFloat(tok.total_supply, tok.decimals);
    tok.volume_24h_float = rawToFloat(tok.volume_24h_raw, tok.decimals);

    res.json({ token: safe(tok) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tokens/:id/history', async (req, res) => {
  try {
    const points = parseInt(req.query.points || '48', 10);  // default last 48 snapshots
    const rows = await query(`
      SELECT account_id, snapshot_time,
             holder_count, tx_count_24h,
             total_supply::text AS total_supply,
             volume_24h_raw::text AS volume_24h_raw
      FROM token_snapshots
      WHERE account_id = (SELECT account_id FROM tokens WHERE account_id = $1 OR symbol = $1 LIMIT 1)
      ORDER BY snapshot_time DESC
      LIMIT $2
    `, [req.params.id, points]);
    res.json({ history: rows.reverse().map(safe) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tx/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const rows = await query(`
      SELECT tx.block_hash, tx.block_time, tx.from_account, tx.to_account,
             tx.amount_raw::text AS amount_raw, tx.op_type,
             t.symbol, t.decimals
      FROM transactions tx
      JOIN tokens t ON t.account_id = tx.token_id
      ORDER BY tx.block_time DESC
      LIMIT $1
    `, [limit]);
    for (const r of rows) {
      r.amount_float = rawToFloat(r.amount_raw, r.decimals);
    }
    res.json({ transactions: rows.map(safe) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Live wallet endpoint: hits the chain directly via SDK (no DB) so the
 * latest balances reflect the moment the request was made.
 * Used by the dashboard's Holdings panel.
 */
app.get('/api/wallet/:address', async (req, res) => {
  try {
    const seed = KeetaNet.lib.Account.generateRandomSeed({ asString: true });
    const ephemeral = KeetaNet.lib.Account.fromSeed(seed, 0);
    const client = KeetaNet.UserClient.fromNetwork(process.env.KEETA_NETWORK || 'main', ephemeral);

    const balances = await client.allBalances(req.params.address);
    if (!Array.isArray(balances)) return res.json({ holdings: [] });

    // Enrich with our DB metadata + prices
    const holdings = [];
    for (const b of balances) {
      const tokenStr = (b.token || '').toString();
      // Match token in our catalog
      const [dbTok] = await query(
        `SELECT account_id, symbol, name, decimals, category, iso_code, is_base_token
         FROM tokens WHERE account_id = $1 OR account_id LIKE '%' || $2 || '%' LIMIT 1`,
        [tokenStr, tokenStr.slice(-12) || tokenStr]
      );

      const rawBal = (b.balance ?? b.amount ?? 0).toString().replace('n', '');
      const decimals = dbTok?.decimals ?? b.info?.decimals ?? 18;
      const symbol = dbTok?.symbol || b.info?.symbol || 'UNKNOWN';
      const name = dbTok?.name || b.info?.name || symbol;

      holdings.push({
        token_id: dbTok?.account_id || tokenStr,
        symbol,
        name,
        decimals,
        category: dbTok?.category || 'token',
        iso_code: dbTok?.iso_code || null,
        is_base_token: b.isBaseToken || dbTok?.is_base_token || false,
        balance_raw: rawBal,
        balance: rawToFloat(rawBal, decimals)
      });
    }

    // Pin KTA to the top, then sort by USD value descending
    await enrichWithPrices(holdings);
    for (const h of holdings) {
      h.value_usd = h.price_usd ? h.balance * h.price_usd : null;
    }
    holdings.sort((a, b) => {
      if (a.is_base_token && !b.is_base_token) return -1;
      if (!a.is_base_token && b.is_base_token) return 1;
      return (b.value_usd || 0) - (a.value_usd || 0);
    });

    const total_value_usd = holdings.reduce((s, h) => s + (h.value_usd || 0), 0);
    res.json({ address: req.params.address, total_value_usd, holdings });
  } catch (e) {
    console.error('[api] /wallet error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Simple landing page so visitors hitting the API root see something useful
app.get('/', (req, res) => {
  res.type('text/html').send(`<!doctype html><html><body style="font-family:system-ui;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6"><h1>🟢 Gloop Indexer</h1><p>Keeta blockchain indexer + analytics API for the Gloop dashboard.</p><p>This server polls the Keeta chain, aggregates per-token stats, and serves them at <code>/api/*</code>.</p><h2>Endpoints</h2><ul><li><code><a href="/api/health">/api/health</a></code></li><li><code><a href="/api/network">/api/network</a></code></li><li><code><a href="/api/tokens">/api/tokens</a></code></li><li><code>/api/tokens/:id</code></li><li><code>/api/tokens/:id/history</code></li><li><code><a href="/api/tx/recent">/api/tx/recent</a></code></li><li><code>/api/wallet/:address</code></li></ul></body></html>`);
});

// ─────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────

(async function main() {
  try {
    await bootstrapSchema();
    await startIndexer();
    app.listen(PORT, () => {
      console.log(`[server] listening on :${PORT}`);
    });
  } catch (e) {
    console.error('[server] startup failed:', e.message);
    process.exit(1);
  }
})();
