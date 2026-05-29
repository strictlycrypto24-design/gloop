// Keeta chain indexer. Runs as a long-lived loop inside the Node process.
//
// Strategy (works on free tier without subscriptions):
//   1. Maintain a list of known token accounts. Seeded from KEETA_FIATS_BOOTSTRAP
//      env var, expanded as we discover tokens via wallet queries.
//   2. Every POLL_INTERVAL_MS:
//        - For each token: fetch info + recent history via client.history()
//        - Diff vs last seen history → extract new transactions
//        - Update holder balances incrementally
//        - Aggregate 24h volume + holder count
//        - Insert a snapshot row
//   3. Every PRUNE_INTERVAL_MS: drop transactions older than 7 days, snapshots older than 30 days.
//
// Why polling instead of subscriptions: the KeetaNet SDK doesn't expose
// a public subscribe API yet. Polling at 60s intervals matches what most
// free-tier indexers do and stays well under any rate limits.

import KeetaNet from '@keetanetwork/keetanet-client';
import { upsertToken, insertSnapshot, insertTransaction, pruneOldData, query } from './db.js';
import { enrichWithPrices } from './prices.js';

const NETWORK = process.env.KEETA_NETWORK || 'main';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);    // 60s default
const PRUNE_INTERVAL_MS = parseInt(process.env.PRUNE_INTERVAL_MS || '3600000', 10); // 1h default

// Seed token list. Comma-separated `symbol:account_id` pairs. Override via env.
// Example: KEETA_TOKENS="USDX:keeta_aabxxx...,EURX:keeta_aabyyy..."
// We DON'T hardcode addresses because they may change pre-launch. Users
// paste theirs into Railway env vars.
function parseBootstrapTokens() {
  const raw = process.env.KEETA_TOKENS || '';
  return raw.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const [symbol, account_id] = pair.split(':').map(s => s.trim());
      return { symbol, account_id };
    })
    .filter(t => t.symbol && t.account_id);
}

// Module-level state
let userClient = null;
let lastHistoryHashByToken = new Map(); // token_id → last seen block hash

/**
 * Initialise the read-only KeetaNet client. We don't need a signer — only
 * read access — so we generate a throwaway account just to satisfy the SDK
 * constructor. The private key is never used or stored.
 */
function initKeetaClient() {
  if (userClient) return userClient;
  const seed = KeetaNet.lib.Account.generateRandomSeed({ asString: true });
  const ephemeralAccount = KeetaNet.lib.Account.fromSeed(seed, 0);
  userClient = KeetaNet.UserClient.fromNetwork(NETWORK, ephemeralAccount);
  console.log(`[indexer] connected to Keeta ${NETWORK} (ephemeral read account)`);
  return userClient;
}

/**
 * Bootstrap: ensure every token in the env var exists in the DB.
 * Pulls metadata (name, symbol, decimals, supply) from the chain on first sight.
 */
async function bootstrapTokens() {
  const client = initKeetaClient();
  const seeded = parseBootstrapTokens();
  if (seeded.length === 0) {
    console.warn('[indexer] No KEETA_TOKENS env var set. Indexer will run but track 0 tokens.');
    console.warn('[indexer] Set KEETA_TOKENS=USD:keeta_xxx,EUR:keeta_yyy on Railway and restart.');
    return;
  }

  for (const { symbol, account_id } of seeded) {
    try {
      // Categorize: ISO 4217 codes (3 uppercase letters) → fiat, KTA → base, USDC/USDT/etc → stable
      const isIso = /^[A-Z]{3}$/.test(symbol);
      const category = (symbol === 'KTA') ? 'crypto'
                     : ['USDC','USDT','DAI','USDX','GUSD','BUSD','TUSD','FRAX'].includes(symbol) ? 'stable'
                     : isIso ? 'fiat' : 'token';

      // Try to pull live info from chain
      let name = symbol;
      let decimals = 18;
      let supply = '0';
      try {
        const tokenAccount = KeetaNet.lib.Account.fromPublicKeyString(account_id);
        // The SDK exposes info via the chain query. We try the most common pattern.
        const chainInfo = await client.chain(tokenAccount).catch(() => null);
        if (chainInfo?.info?.name) name = chainInfo.info.name;
        if (chainInfo?.info?.decimals != null) decimals = chainInfo.info.decimals;
        if (chainInfo?.totalSupply != null) supply = chainInfo.totalSupply.toString().replace('n','');
      } catch (e) {
        // Chain query failed — fall back to defaults
      }

      await upsertToken({
        account_id,
        symbol,
        name,
        decimals,
        category,
        iso_code: isIso ? symbol : null,
        total_supply: supply,
        is_base_token: symbol === 'KTA'
      });
      console.log(`[indexer] bootstrapped token ${symbol} (${account_id.slice(0,12)}…)`);
    } catch (e) {
      console.warn(`[indexer] failed to bootstrap ${symbol}:`, e.message);
    }
  }
}

/**
 * Process one token: fetch recent history, extract new transactions,
 * update aggregates, and write a fresh snapshot.
 */
async function pollToken(token) {
  const client = initKeetaClient();
  const tokenAccount = KeetaNet.lib.Account.fromPublicKeyString(token.account_id);

  // 1. Fetch recent history (the SDK returns blocks affecting this account)
  let history = [];
  try {
    history = await client.history({ account: tokenAccount }) || [];
  } catch (e) {
    // Some SDK versions accept a positional arg or different shape — try fallback
    try {
      history = await client.history(tokenAccount) || [];
    } catch (e2) {
      console.warn(`[indexer] history fetch failed for ${token.symbol}:`, e2.message);
      return;
    }
  }

  // 2. Find new transactions since last poll
  const lastSeen = lastHistoryHashByToken.get(token.account_id);
  let newTxCount = 0;
  let volume24hRaw = 0n;
  const now = Date.now();
  const cutoff = now - 24 * 3600 * 1000;

  for (const entry of history) {
    // Each entry shape depends on SDK version. Common fields: hash, block, operations, time
    const blockHash = entry?.hash || entry?.block?.hash || JSON.stringify(entry).slice(0, 64);
    const blockTime = entry?.time ? new Date(entry.time) : new Date(now);
    const ops = entry?.block?.operations || entry?.operations || [];

    for (const op of ops) {
      // Only count transfers of THIS token
      const opTokenId = op?.token?.toString?.() || op?.token || null;
      if (opTokenId && !opTokenId.includes(token.account_id.slice(-12))) continue;

      const amount = op?.amount ? BigInt(op.amount.toString().replace('n','')) : 0n;
      const opType = op?.type || op?.opType || 'TRANSFER';
      const fromAcct = op?.from?.toString?.() || op?.from || null;
      const toAcct = op?.to?.toString?.() || op?.to || null;

      // Insert tx (idempotent on block_hash)
      await insertTransaction({
        block_hash: `${blockHash}:${opType}:${fromAcct?.slice(0,12)||'?'}->${toAcct?.slice(0,12)||'?'}`,
        block_time: blockTime,
        token_id: token.account_id,
        from_account: fromAcct,
        to_account: toAcct,
        amount_raw: amount.toString(),
        op_type: opType
      });
      newTxCount++;

      if (blockTime.getTime() >= cutoff) {
        volume24hRaw += amount;
      }
    }

    if (blockHash === lastSeen) break; // caught up to last poll
  }
  if (history[0]) {
    lastHistoryHashByToken.set(token.account_id, history[0]?.hash || history[0]?.block?.hash);
  }

  // 3. Update holder count: count distinct accounts with balance > 0 in DB
  const holderRow = await query(
    `SELECT COUNT(DISTINCT account_id)::int AS n
     FROM holder_balances WHERE token_id = $1 AND balance_raw > 0`,
    [token.account_id]
  );
  const holderCount = holderRow[0]?.n || 0;

  // 4. Get tx count in last 24h from DB
  const txCountRow = await query(
    `SELECT COUNT(*)::int AS n FROM transactions
     WHERE token_id = $1 AND block_time >= NOW() - INTERVAL '24 hours'`,
    [token.account_id]
  );
  const txCount24h = txCountRow[0]?.n || 0;

  // 5. Get 24h volume (sum) from DB — more accurate than what we accumulated this cycle
  const volRow = await query(
    `SELECT COALESCE(SUM(amount_raw), 0)::text AS vol FROM transactions
     WHERE token_id = $1 AND block_time >= NOW() - INTERVAL '24 hours'`,
    [token.account_id]
  );
  const volume24h = volRow[0]?.vol || '0';

  // 6. Write snapshot row (charts query these)
  await insertSnapshot({
    account_id: token.account_id,
    total_supply: token.total_supply || null,
    holder_count: holderCount,
    tx_count_24h: txCount24h,
    volume_24h_raw: volume24h,
    price_usd: null,        // filled at /api/tokens response time, not stored here
    price_change_24h: null
  });

  if (newTxCount > 0) {
    console.log(`[indexer] ${token.symbol}: +${newTxCount} new tx, holders=${holderCount}, 24h vol=${volume24h}`);
  }
}

/**
 * Run one full poll cycle across all tracked tokens.
 */
async function pollAllTokens() {
  const tokens = await query(`SELECT account_id, symbol, decimals, total_supply FROM tokens`);
  if (tokens.length === 0) return;
  for (const tok of tokens) {
    try {
      await pollToken(tok);
    } catch (e) {
      console.warn(`[indexer] poll failed for ${tok.symbol}:`, e.message);
    }
  }
}

/**
 * Public entry point: start the indexer loop. Returns immediately —
 * the loop runs forever in the background.
 */
export async function startIndexer() {
  await bootstrapTokens();

  // Run first poll immediately (so the dashboard has data within seconds of deploy)
  pollAllTokens().catch(e => console.error('[indexer] first poll error:', e.message));

  // Subsequent polls
  setInterval(() => {
    pollAllTokens().catch(e => console.error('[indexer] poll error:', e.message));
  }, POLL_INTERVAL_MS);

  // Periodic pruning so the DB stays small enough for the free tier
  setInterval(() => {
    pruneOldData().catch(e => console.error('[indexer] prune error:', e.message));
  }, PRUNE_INTERVAL_MS);

  console.log(`[indexer] started — polling every ${POLL_INTERVAL_MS / 1000}s, pruning every ${PRUNE_INTERVAL_MS / 60000}m`);
}
