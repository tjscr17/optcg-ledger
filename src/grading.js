// ============================================================================
// Grading lookup — powered by PriceCharting API (https://www.pricecharting.com)
//
// Auth: 40-character token passed as ?t=<token> (env: VITE_PRICECHARTING_TOKEN)
// Prices come back as integers in pennies. We convert to USD floats.
//
// PriceCharting reuses video-game field slots for TCG grade tiers. Verified
// mapping for One Piece TCG:
//
//   Ungraded   → loose-price
//   Grade 7    → cib-price
//   Grade 8    → new-price
//   Grade 9    → graded-price
//   Grade 9.5  → box-only-price
//   CGC 10     → condition-17-price
//   SGC 10     → condition-18-price
//   PSA 10     → manual-only-price
//   BGS 10     → bgs-10-price
//
// Caveat: Grades 7–9.5 are aggregated across grading companies — PriceCharting
// only distinguishes by company at grade 10. So PSA 9 and BGS 9 both read from
// `graded-price`. We surface this caveat in the UI.
// ============================================================================

import { store, MODE } from './storage.js';

const API = 'https://www.pricecharting.com/api';
const TOKEN = import.meta.env.VITE_PRICECHARTING_TOKEN;

const PRODUCT_CACHE_KEY = 'optcg:pc:products:v1';
const PRICE_CACHE_KEY = 'optcg:pc:prices:v1';
const IMAGE_CACHE_KEY = 'optcg:pc:images:v1';
const VARIANT_CACHE_KEY = 'optcg:pc:variants:v1';
const PRICE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const VARIANT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d — variant snapshot prices are background data

// TCGPlayer product image CDN. PriceCharting's API doesn't return image URLs
// directly, but it returns a tcg-id which maps 1:1 to a TCGPlayer product
// whose image is at this public path.
const tcgImageUrl = (tcgId) => tcgId ? `https://tcgplayer-cdn.tcgplayer.com/product/${tcgId}_in_1000x1000.jpg` : null;

export const GRADING_COMPANIES = ['PSA', 'BGS', 'CGC', 'SGC'];

// Allowed grades per company. Half-grades only meaningful at 9.5 for PSA/BGS.
export const GRADES_BY_COMPANY = {
  PSA: [10, 9.5, 9, 8, 7],
  BGS: [10, 9.5, 9, 8, 7],
  CGC: [10, 9.5, 9, 8, 7],
  SGC: [10, 9.5, 9, 8, 7],
};

// Returns the PriceCharting field name for a (company, grade) combo, or null.
export const fieldForGrade = (company, grade) => {
  const g = Number(grade);
  if (g === 10) {
    if (company === 'PSA') return 'manual-only-price';
    if (company === 'BGS') return 'bgs-10-price';
    if (company === 'CGC') return 'condition-17-price';
    if (company === 'SGC') return 'condition-18-price';
    return null;
  }
  if (g === 9.5) return 'box-only-price';
  if (g === 9) return 'graded-price';
  if (g === 8) return 'new-price';
  if (g === 7) return 'cib-price';
  return null;
};

// True when the grade tier aggregates across grading companies on PriceCharting.
export const isAggregateAcrossCompanies = (grade) => {
  const g = Number(grade);
  return g >= 7 && g < 10;
};

export const hasToken = () => Boolean(TOKEN);

const readCache = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
};

const writeCache = (key, data) => {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
};

// Search PriceCharting for products matching a query.
// Returns the array of products (already deserialized).
const searchProducts = async (query) => {
  const url = `${API}/products?t=${encodeURIComponent(TOKEN)}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PriceCharting search returned ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.products) ? json.products : [];
};

const fetchProductById = async (productId) => {
  const url = `${API}/product?t=${encodeURIComponent(TOKEN)}&id=${encodeURIComponent(productId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PriceCharting product fetch returned ${res.status}`);
  return res.json();
};

// Search for every PriceCharting match for an OPTCG card. The UI presents
// these to the user so they can pick the correct variant — auto-picking is
// unreliable because PriceCharting's variant naming doesn't map cleanly to
// OPTCG's parallel/SR/SPR conventions.
//
// Returns enriched array: each item has the raw product fields plus a
// `priceForField(field)` helper. Sorted: One Piece genre first, then by
// loose-price desc as a rough proxy for "most relevant first".
export const searchVariants = async (card) => {
  if (!TOKEN) throw new Error('VITE_PRICECHARTING_TOKEN is not set');
  const query = card.displayId || card.id;
  const raw = await searchProducts(query);
  return raw
    .filter(p => /one piece/i.test(p.genre || '') || /one piece/i.test(p['console-name'] || ''))
    .sort((a, b) => (Number(b['loose-price']) || 0) - (Number(a['loose-price']) || 0));
};

// Read/write the per-card PriceCharting product pick.
export const getSavedPick = (cardId) => {
  const cache = readCache(PRODUCT_CACHE_KEY, {});
  return cache[cardId] || null;
};

export const savePick = (cardId, product) => {
  const cache = readCache(PRODUCT_CACHE_KEY, {});
  cache[cardId] = {
    id: String(product.id),
    name: product['product-name'],
    console: product['console-name'],
  };
  writeCache(PRODUCT_CACHE_KEY, cache);
  // saveVariantSnapshot persists the snapshot locally AND pushes to shared
  // mode (when active), so we don't need a separate shared call here.
  saveVariantSnapshot(cardId, product);
  if (product['tcg-id']) saveImage(cardId, product['tcg-id']);
};

// Image enhancement: synchronously returns the cached TCGPlayer image URL
// for a card, or null if we haven't resolved one yet. Used as a fallback
// when OPTCGAPI doesn't provide card_image.
export const getCachedImage = (cardId) => {
  const cache = readCache(IMAGE_CACHE_KEY, {});
  return cache[cardId] ? tcgImageUrl(cache[cardId]) : null;
};

const saveImage = (cardId, tcgId) => {
  if (!tcgId) return;
  const cache = readCache(IMAGE_CACHE_KEY, {});
  cache[cardId] = String(tcgId);
  writeCache(IMAGE_CACHE_KEY, cache);
};

// Tier identifiers exposed to the UI's "Price as" toggle.
export const PRICE_TIERS = [
  { value: 'raw', label: 'Raw / Ungraded', field: null },
  { value: 'psa10', label: 'PSA 10', field: 'manual-only-price' },
  { value: 'bgs10', label: 'BGS 10', field: 'bgs-10-price' },
  { value: 'cgc10', label: 'CGC 10', field: 'condition-17-price' },
  { value: 'sgc10', label: 'SGC 10', field: 'condition-18-price' },
  { value: 'grade-9.5', label: 'Grade 9.5', field: 'box-only-price' },
  { value: 'grade-9', label: 'Grade 9', field: 'graded-price' },
  { value: 'grade-8', label: 'Grade 8', field: 'new-price' },
  { value: 'grade-7', label: 'Grade 7', field: 'cib-price' },
];

const TIER_BY_VALUE = Object.fromEntries(PRICE_TIERS.map(t => [t.value, t]));

// Compact snapshot of every price field we care about, cached per card.
const snapshotProduct = (product) => ({
  product_id: String(product.id),
  product_name: product['product-name'],
  'loose-price': Number(product['loose-price']) || 0,
  'cib-price': Number(product['cib-price']) || 0,
  'new-price': Number(product['new-price']) || 0,
  'graded-price': Number(product['graded-price']) || 0,
  'box-only-price': Number(product['box-only-price']) || 0,
  'manual-only-price': Number(product['manual-only-price']) || 0,
  'bgs-10-price': Number(product['bgs-10-price']) || 0,
  'condition-17-price': Number(product['condition-17-price']) || 0,
  'condition-18-price': Number(product['condition-18-price']) || 0,
  fetched_at: Date.now(),
});

const saveVariantSnapshot = (cardId, product) => {
  const cache = readCache(VARIANT_CACHE_KEY, {});
  cache[cardId] = snapshotProduct(product);
  writeCache(VARIANT_CACHE_KEY, cache);
  variantListeners.forEach(cb => { try { cb(cardId); } catch {} });
  // Shared-mode sync (fire-and-forget). Auto-resolutions populate the shared
  // table just like manual picks, so a team's resolve work is collective.
  if (MODE === 'shared') {
    store.upsertResolution(cardId, {
      pc_product_id: String(product.id),
      pc_product_name: product['product-name'] || '',
      pc_console: product['console-name'] || '',
      tcg_id: product['tcg-id'] ? String(product['tcg-id']) : null,
      snapshot: snapshotProduct(product),
    }).catch(() => {});
  }
};

// Tiny pub/sub so UI components can re-read the cache when a variant resolves
// in the background. Subscribe once per consumer that needs to react.
const variantListeners = new Set();
export const onVariantResolved = (cb) => {
  variantListeners.add(cb);
  return () => variantListeners.delete(cb);
};

// Look up a cached price for a specific grade tier. Returns USD float or null.
export const getCachedTierPrice = (cardId, tier) => {
  const t = TIER_BY_VALUE[tier];
  if (!t || !t.field) return null;
  const cache = readCache(VARIANT_CACHE_KEY, {});
  const snap = cache[cardId];
  if (!snap) return null;
  const pennies = Number(snap[t.field]) || 0;
  return pennies > 0 ? pennies / 100 : null;
};

// Cached raw / loose (ungraded) market price from PriceCharting, in USD.
// Returns null if no variant snapshot has been resolved for this card yet —
// the caller may show 0 / "—" until the lazy resolution lands.
export const getCachedLoosePrice = (cardId) => {
  const cache = readCache(VARIANT_CACHE_KEY, {});
  const snap = cache[cardId];
  if (!snap) return null;
  const pennies = Number(snap['loose-price']) || 0;
  return pennies > 0 ? pennies / 100 : null;
};

// True if we have a variant snapshot for this card (regardless of staleness).
export const hasCachedVariant = (cardId) => {
  const cache = readCache(VARIANT_CACHE_KEY, {});
  return Boolean(cache[cardId]);
};

// True if the cached variant snapshot is fresh enough that we shouldn't refetch.
export const isVariantSnapshotFresh = (cardId) => {
  const cache = readCache(VARIANT_CACHE_KEY, {});
  const snap = cache[cardId];
  return snap ? Date.now() - (snap.fetched_at || 0) < VARIANT_TTL_MS : false;
};

// Hydrate localStorage caches from the shared backend. Run once on app boot
// when MODE === 'shared'. Returns the count of resolutions pulled. In solo
// mode this is a no-op (returns 0).
export const hydrateFromShared = async () => {
  if (MODE !== 'shared') return 0;
  let rows;
  try { rows = await store.listResolutions(); } catch { return 0; }
  if (!rows || rows.length === 0) return 0;
  const variantCache = readCache(VARIANT_CACHE_KEY, {});
  const productCache = readCache(PRODUCT_CACHE_KEY, {});
  const imageCache = readCache(IMAGE_CACHE_KEY, {});
  for (const row of rows) {
    if (!row.card_id) continue;
    if (row.snapshot) variantCache[row.card_id] = row.snapshot;
    if (row.pc_product_id) {
      productCache[row.card_id] = {
        id: row.pc_product_id,
        name: row.pc_product_name || '',
        console: row.pc_console || '',
      };
    }
    if (row.tcg_id) imageCache[row.card_id] = String(row.tcg_id);
  }
  writeCache(VARIANT_CACHE_KEY, variantCache);
  writeCache(PRODUCT_CACHE_KEY, productCache);
  writeCache(IMAGE_CACHE_KEY, imageCache);
  // Notify listeners that variant data is now available so visible tiles
  // re-read the cache and update their tier prices.
  for (const row of rows) {
    if (row.card_id) variantListeners.forEach(cb => { try { cb(row.card_id); } catch {} });
  }
  return rows.length;
};

// Subscribe to real-time resolution updates from teammates. Returns an
// unsubscribe function. Updates local cache and emits the variant-resolved
// event so tiles re-render.
export const subscribeResolutions = () => {
  if (MODE !== 'shared') return () => {};
  return store.subscribeResolutions((payload) => {
    const row = payload?.new || payload?.record;
    if (!row || !row.card_id) return;
    if (row.snapshot) {
      const variantCache = readCache(VARIANT_CACHE_KEY, {});
      variantCache[row.card_id] = row.snapshot;
      writeCache(VARIANT_CACHE_KEY, variantCache);
    }
    if (row.pc_product_id) {
      const productCache = readCache(PRODUCT_CACHE_KEY, {});
      productCache[row.card_id] = {
        id: row.pc_product_id,
        name: row.pc_product_name || '',
        console: row.pc_console || '',
      };
      writeCache(PRODUCT_CACHE_KEY, productCache);
    }
    if (row.tcg_id) {
      const imageCache = readCache(IMAGE_CACHE_KEY, {});
      imageCache[row.card_id] = String(row.tcg_id);
      writeCache(IMAGE_CACHE_KEY, imageCache);
    }
    variantListeners.forEach(cb => { try { cb(row.card_id); } catch {} });
  });
};

// Resolve an enhanced image for a card with a missing OPTCGAPI image.
// Searches PriceCharting once, caches the tcg-id AND a full price snapshot
// (so the "Price as" toggle can show graded prices without an extra call),
// returns the CDN URL.
export const resolveEnhancedImage = async (card) => {
  if (!TOKEN) return null;
  const cached = getCachedImage(card.id);
  if (cached) return cached;
  try {
    const matches = await searchVariants(card);
    if (matches.length === 0) return null;
    const best = matches.find(m => m['tcg-id']) || matches[0];
    saveVariantSnapshot(card.id, best);
    if (!best['tcg-id']) return null;
    saveImage(card.id, best['tcg-id']);
    return tcgImageUrl(best['tcg-id']);
  } catch {
    return null;
  }
};

// Resolve and cache the PriceCharting variant snapshot for a card without
// needing image data. Used when the OPTCGAPI image is already present but
// we still need graded prices for the "Price as" toggle.
export const resolveVariantSnapshot = async (card) => {
  if (!TOKEN) return false;
  if (isVariantSnapshotFresh(card.id)) return true;
  try {
    const matches = await searchVariants(card);
    if (matches.length === 0) return false;
    const best = matches.find(m => m['tcg-id']) || matches[0];
    saveVariantSnapshot(card.id, best);
    if (best['tcg-id']) saveImage(card.id, best['tcg-id']);
    return true;
  } catch {
    return false;
  }
};

// Get the priced field from a product, returning 0 if missing/non-positive.
export const priceFromProduct = (product, gradingCompany, grade) => {
  const field = fieldForGrade(gradingCompany, grade);
  if (!field) return { price: 0, field: null };
  const pennies = Number(product[field]);
  if (!Number.isFinite(pennies) || pennies <= 0) return { price: 0, field };
  return { price: pennies / 100, field };
};

// Fetch a graded price for a specific PriceCharting product ID + company + grade.
// Pass the productId explicitly — caller is responsible for resolving the product
// via searchVariants() + savePick() first.
// Returns: { price, field, source, fetched_at, product_id, product_name } or null.
export const fetchGradedPrice = async ({ productId, productName, gradingCompany, grade }) => {
  if (!TOKEN) throw new Error('VITE_PRICECHARTING_TOKEN is not set');
  if (!productId) return null;

  const field = fieldForGrade(gradingCompany, grade);
  if (!field) return null;

  const cacheKey = `${productId}:${field}`;
  const priceCache = readCache(PRICE_CACHE_KEY, {});
  const cached = priceCache[cacheKey];
  if (cached && Date.now() - cached.fetched_ts < PRICE_TTL_MS) {
    const { fetched_ts, ...rest } = cached;
    return rest;
  }

  const fresh = await fetchProductById(productId);
  const pennies = Number(fresh[field]);
  const result = {
    field,
    source: 'pricecharting',
    product_id: String(productId),
    product_name: fresh['product-name'] || productName || '',
    fetched_at: new Date().toISOString(),
    price: Number.isFinite(pennies) && pennies > 0 ? pennies / 100 : 0,
    missing: !(Number.isFinite(pennies) && pennies > 0),
  };
  priceCache[cacheKey] = { ...result, fetched_ts: Date.now() };
  writeCache(PRICE_CACHE_KEY, priceCache);
  return result;
};
