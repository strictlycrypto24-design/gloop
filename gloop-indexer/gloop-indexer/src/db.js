// Postgres connection module. Reads DATABASE_URL from env (Railway/Render
// inject this automatically when you attach a Postgres add-on).
// Bootstraps the schema on first run.

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { Pool } = pg;

// Railway / Render set DATABASE_URL automatically. For local dev, fall back
// to a sensible default that maps to a `gloop_indexer` db on localhost.
const connectionString = process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/gloop_indexer';

// SSL is required by most managed Postgres providers. Disable cert
// verification (Railway uses self-signed certs internally).
const ssl = connectionString.includes('localhost') ? false : { rejectUnauthorized: false };

export const pool = new Pool({ connectionString, ssl, max: 5 });

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

/**
 * Run a query, returning rows. Logs the timing for slow queries.
 */
export async function query(text, params = []) {
  const t0 = Date.now();
  try {
    const res = await pool.query(text, params);
    const ms = Date.now() - t0;
    if (ms > 500) console.warn(`[db] slow query (${ms}ms): ${text.slice(0, 80)}…`);
    return res.rows;
  } catch (e) {
    console.error(`[db] query failed: ${text.slice(0, 80)}…`, e.message);
    throw e;
  }
}

/**
 * Apply schema.sql. Idempotent — uses CREATE TABLE IF NOT EXISTS everywhere.
 * Called once on server startup.
 */
export async function bootstrapSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] schema bootstrapped');
}

/**
 * Upsert a token's catalog entry. Called when we discover a new token on-chain
 * or refresh an existing one with new metadata.
 */
export async function upsertToken({ account_id, symbol, name, decimals, category, iso_code, total_supply, is_base_token }) {
  await pool.query(`
    INSERT INTO tokens (account_id, symbol, name, decimals, category, iso_code, total_supply, is_base_token, last_updated)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (account_id) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      name = EXCLUDED.name,
      decimals = EXCLUDED.decimals,
      category = COALESCE(EXCLUDED.category, tokens.category),
      iso_code = COALESCE(EXCLUDED.iso_code, tokens.iso_code),
      total_supply = EXCLUDED.total_supply,
      is_base_token = EXCLUDED.is_base_token,
      last_updated = NOW()
  `, [account_id, symbol, name, decimals, category, iso_code, total_supply, is_base_token]);
}

/**
 * Insert a new snapshot row for a token. We never UPDATE snapshots —
 * they're append-only so we can chart history.
 */
export async function insertSnapshot(row) {
  await pool.query(`
    INSERT INTO token_snapshots
      (account_id, total_supply, holder_count, tx_count_24h, volume_24h_raw, price_usd, price_change_24h)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [row.account_id, row.total_supply, row.holder_count, row.tx_count_24h, row.volume_24h_raw, row.price_usd, row.price_change_24h]);
}

/**
 * Record a transaction we observed. ON CONFLICT DO NOTHING so we can safely
 * re-process the same block range (idempotent).
 */
export async function insertTransaction(tx) {
  await pool.query(`
    INSERT INTO transactions (block_hash, block_time, token_id, from_account, to_account, amount_raw, op_type)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (block_hash) DO NOTHING
  `, [tx.block_hash, tx.block_time, tx.token_id, tx.from_account, tx.to_account, tx.amount_raw, tx.op_type]);
}

/**
 * Prune transactions older than 7 days. Keeps DB size bounded.
 * Snapshots are kept for chart history (much smaller rows).
 */
export async function pruneOldData() {
  const txResult = await pool.query(`DELETE FROM transactions WHERE block_time < NOW() - INTERVAL '7 days'`);
  // Keep at most 30 days of snapshots (one per token per 5 min ≈ 8640 rows/token/month)
  const snapResult = await pool.query(`DELETE FROM token_snapshots WHERE snapshot_time < NOW() - INTERVAL '30 days'`);
  if (txResult.rowCount || snapResult.rowCount) {
    console.log(`[db] pruned ${txResult.rowCount} txs, ${snapResult.rowCount} snapshots`);
  }
}
