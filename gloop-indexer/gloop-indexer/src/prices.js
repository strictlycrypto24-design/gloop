// Price oracle. Wraps two free APIs with sensible caching:
//   - CoinGecko /simple/price for crypto (KTA, USDC, etc.)
//   - open.er-api.com for fiat-to-USD rates (USD, EUR, GBP, JPY, etc.)
//   - Frankfurter.dev as FX fallback
//
// All prices cached for 60 seconds to stay well under free-tier rate limits.

const CACHE_TTL_MS = 60 * 1000;

// In-memory caches keyed by query signature
const cryptoCache = new Map(); // key: id, value: { ts, price_usd, change_24h }
const fxCache = { ts: 0, rates: null }; // rates: { EUR: 0.92, GBP: 0.79, ... }

/**
 * Fetch crypto prices from CoinGecko. `ids` is a comma-separated list of
 * CoinGecko coin IDs (e.g., 'keeta,usd-coin,tether').
 *
 * Returns { 'keeta': {usd: 0.42, usd_24h_change: 2.1}, ... }
 * Returns {} on failure — caller should treat missing entries as null.
 */
export async function fetchCryptoPrices(ids) {
  const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
  if (idList.length === 0) return {};

  // Serve from cache where possible
  const now = Date.now();
  const result = {};
  const missing = [];
  for (const id of idList) {
    const cached = cryptoCache.get(id);
    if (cached && (now - cached.ts) < CACHE_TTL_MS) {
      result[id] = cached.data;
    } else {
      missing.push(id);
    }
  }
  if (missing.length === 0) return result;

  // Fetch the rest
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${missing.join(',')}&vs_currencies=usd&include_24hr_change=true`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      console.warn(`[prices] CoinGecko returned ${res.status}`);
      return result;
    }
    const data = await res.json();
    for (const id of missing) {
      if (data[id]) {
        const entry = { usd: data[id].usd, usd_24h_change: data[id].usd_24h_change };
        cryptoCache.set(id, { ts: now, data: entry });
        result[id] = entry;
      }
    }
  } catch (e) {
    console.warn('[prices] CoinGecko fetch failed:', e.message);
  }
  return result;
}

/**
 * Fetch fiat-vs-USD rates. Returns { EUR: 0.92, GBP: 0.79, JPY: 149.5, ... }
 * meaning "1 USD = N units of currency X".
 * To convert a fiat amount to USD: amount_usd = amount_fiat / rates[fiat_code].
 *
 * Tries open.er-api.com first, falls back to frankfurter.dev.
 */
export async function fetchFiatRates() {
  const now = Date.now();
  if (fxCache.rates && (now - fxCache.ts) < CACHE_TTL_MS) {
    return fxCache.rates;
  }

  // Primary: open.er-api.com (no key, CORS-enabled, 166 currencies)
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.result === 'success' && data.rates) {
        fxCache.ts = now;
        fxCache.rates = data.rates;
        return data.rates;
      }
    }
  } catch (e) {
    console.warn('[prices] open.er-api failed:', e.message);
  }

  // Fallback: frankfurter.dev (ECB-backed, no key, no quota)
  try {
    const res = await fetch('https://api.frankfurter.dev/v2/rates?base=USD', {
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.rates) {
        const rates = { USD: 1, ...data.rates };
        fxCache.ts = now;
        fxCache.rates = rates;
        return rates;
      }
    }
  } catch (e) {
    console.warn('[prices] frankfurter fallback failed:', e.message);
  }

  // Last resort: serve stale cache if we have one, otherwise return USD=1 only
  if (fxCache.rates) return fxCache.rates;
  return { USD: 1 };
}

/**
 * Map a token symbol to a CoinGecko coin ID for known tokens.
 * Returns null if we don't have a mapping (price unavailable).
 */
export function symbolToCoinGeckoId(symbol) {
  const map = {
    KTA: 'keeta',
    USDC: 'usd-coin',
    USDT: 'tether',
    DAI: 'dai',
    WETH: 'weth',
    BTC: 'bitcoin',
    ETH: 'ethereum',
  };
  return map[symbol?.toUpperCase()] || null;
}

/**
 * For a list of token records, attach price_usd + change_24h fields.
 * Crypto tokens use CoinGecko; fiat tokens use FX rates (assumed pegged 1:1
 * to their fiat currency, so price_usd = 1 / fx_rate[iso_code]).
 *
 * Mutates the input array in place AND returns it.
 */
export async function enrichWithPrices(tokens) {
  // Group by source needed
  const cgIds = [];
  for (const tok of tokens) {
    const id = symbolToCoinGeckoId(tok.symbol);
    if (id && !cgIds.includes(id)) cgIds.push(id);
  }

  const [cryptoPrices, fxRates] = await Promise.all([
    cgIds.length ? fetchCryptoPrices(cgIds.join(',')) : Promise.resolve({}),
    fetchFiatRates()
  ]);

  for (const tok of tokens) {
    // Crypto first
    const cgId = symbolToCoinGeckoId(tok.symbol);
    if (cgId && cryptoPrices[cgId]) {
      tok.price_usd = cryptoPrices[cgId].usd;
      tok.price_change_24h = cryptoPrices[cgId].usd_24h_change ?? 0;
      tok.price_source = 'coingecko';
      continue;
    }
    // Fiat via FX (token's iso_code, or the symbol itself if it's an ISO code)
    const iso = tok.iso_code || tok.symbol;
    if (iso && fxRates[iso.toUpperCase()]) {
      const rate = fxRates[iso.toUpperCase()];
      tok.price_usd = rate > 0 ? (1 / rate) : null;
      tok.price_change_24h = 0; // FX free tier doesn't include 24h change
      tok.price_source = 'fx';
      continue;
    }
    // Stablecoin assumption: if category=stable but no oracle hit, assume $1.00
    if (tok.category === 'stable') {
      tok.price_usd = 1.00;
      tok.price_change_24h = 0;
      tok.price_source = 'assumed-peg';
      continue;
    }
    // Unknown: leave null
    tok.price_usd = null;
    tok.price_change_24h = null;
    tok.price_source = null;
  }
  return tokens;
}
