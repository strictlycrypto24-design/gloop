-- Gloop Indexer schema. Runs idempotently every server start.
-- All tables use IF NOT EXISTS so this is safe to re-run.

CREATE TABLE IF NOT EXISTS tokens (
  account_id      TEXT PRIMARY KEY,           -- Keeta token account address (keeta_aab...)
  symbol          TEXT NOT NULL,              -- USD, EUR, KTA, USDX, etc
  name            TEXT,                       -- "US Dollar", "Keeta", etc
  decimals        INT DEFAULT 18,
  category        TEXT,                       -- 'fiat', 'stable', 'crypto', 'token'
  iso_code        TEXT,                       -- ISO 4217 code if applicable (USD/EUR/...)
  total_supply    NUMERIC(40, 0) DEFAULT 0,   -- raw integer supply
  is_base_token   BOOLEAN DEFAULT FALSE,      -- true for KTA
  first_seen      TIMESTAMPTZ DEFAULT NOW(),
  last_updated    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tokens_symbol_idx ON tokens(symbol);
CREATE INDEX IF NOT EXISTS tokens_category_idx ON tokens(category);

-- Per-token snapshots taken every poll cycle. We aggregate from these to
-- compute 24h volume, holder deltas, supply changes over time.
CREATE TABLE IF NOT EXISTS token_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES tokens(account_id) ON DELETE CASCADE,
  snapshot_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_supply    NUMERIC(40, 0),
  holder_count    INT,                        -- nullable; only filled when we scan balances
  tx_count_24h    INT DEFAULT 0,
  volume_24h_raw  NUMERIC(40, 0) DEFAULT 0,   -- sum of transfer amounts in last 24h (raw)
  price_usd       NUMERIC(20, 10),            -- nullable; filled from oracle when available
  price_change_24h NUMERIC(10, 4)             -- percent change
);

CREATE INDEX IF NOT EXISTS snapshots_account_time_idx ON token_snapshots(account_id, snapshot_time DESC);
CREATE INDEX IF NOT EXISTS snapshots_time_idx ON token_snapshots(snapshot_time DESC);

-- Recent transactions table (rolling window — older rows pruned periodically).
-- Used to power the live transaction feed and 24h volume calculation.
CREATE TABLE IF NOT EXISTS transactions (
  block_hash      TEXT PRIMARY KEY,           -- on-chain block identifier
  block_time      TIMESTAMPTZ NOT NULL,
  token_id        TEXT NOT NULL,              -- which token was transferred
  from_account    TEXT,
  to_account      TEXT,
  amount_raw      NUMERIC(40, 0),
  op_type         TEXT,                       -- SEND, RECEIVE, MINT, etc
  indexed_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tx_time_idx ON transactions(block_time DESC);
CREATE INDEX IF NOT EXISTS tx_token_time_idx ON transactions(token_id, block_time DESC);

-- Account-level tracking for holders count. Updated incrementally as we
-- see transactions. balance > 0 means this account currently holds the token.
CREATE TABLE IF NOT EXISTS holder_balances (
  account_id      TEXT NOT NULL,
  token_id        TEXT NOT NULL,
  balance_raw     NUMERIC(40, 0) DEFAULT 0,
  last_changed    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (account_id, token_id)
);

CREATE INDEX IF NOT EXISTS holders_token_idx ON holder_balances(token_id) WHERE balance_raw > 0;

-- Network-wide rollups for the homepage stat bar
CREATE TABLE IF NOT EXISTS network_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_time   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_tokens    INT,
  total_holders   INT,
  tx_count_24h    INT,
  volume_24h_usd  NUMERIC(20, 2)
);

CREATE INDEX IF NOT EXISTS network_time_idx ON network_snapshots(snapshot_time DESC);
