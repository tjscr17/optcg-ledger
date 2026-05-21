// ============================================================================
// Card catalog & pricing — powered by OPTCGAPI (https://optcgapi.com)
// Free, no auth, refreshed daily by the maintainer.
//
// We hit four "all*" endpoints once on first load and merge:
//   - /api/allSetCards/   (booster sets OP01–OP15+)
//   - /api/allSTCards/    (structure decks ST01–ST28+)
//   - /api/allPromos/     (promos — formerly /api/allPromoCards/, renamed upstream)
//   - /api/allDonCards/   (Don!! cards, including special promo variants)
// Result is cached in localStorage for 24h so we don't spam their VPS.
//
// For price history we hit /api/sets/card/twoweeks/{id}/ on demand per card.
// ============================================================================

const API = 'https://optcgapi.com/api';
const CACHE_KEY = 'optcg:catalog:v5';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const HISTORY_PREFIX = 'optcg:history:';
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const fetchJSON = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
};

const defaultSetId = (sourceType) => {
  if (sourceType === 'promo') return 'PROMO';
  if (sourceType === 'don') return 'DON';
  return '';
};
const defaultSetName = (sourceType) => {
  if (sourceType === 'promo') return 'Promo';
  if (sourceType === 'don') return 'Don!!';
  return '';
};

// Many promos reuse a base card_set_id (e.g. ST01-006 for the Gift Collection
// reprint of Chopper). The trailing parenthetical of card_name distinguishes
// them — we extract it as `variant` (display label) and `variantTag` (slug).
const slugify = (s) => (s || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const extractParen = (fullName) => {
  const m = (fullName || '').match(/\(([^)]+)\)\s*$/);
  if (!m) return null;
  if (/^\d+$/.test(m[1].trim())) return null; // ignore numbered "(1)" duplicates
  return m[1].trim();
};

// Normalize one card response into our shape
const normalize = (raw, sourceType) => {
  const baseId = raw.card_set_id || raw.card_id || raw.don_id || raw.card_image_id;
  // Only promos carry a meaningful variant suffix; sets/starters/Dons keep their parens intact
  const variant = sourceType === 'promo' ? extractParen(raw.card_name) : null;
  const tag = variant ? slugify(variant) : '';
  const id = tag ? `${baseId}__${tag}` : baseId;
  const rawName = raw.card_name || '';
  const cleanedName = variant
    ? rawName.replace(/\s*\([^)]+\)\s*$/, '').trim()
    : rawName.replace(/\s*\(\d+\)\s*$/, '').trim();
  // Promos always live in their own PROMO bucket regardless of their original
  // parent set_id — otherwise the OP09-077 promo gets mixed into the OP-09
  // booster group. We preserve the original set on `originalSetId` for ref.
  const groupSetId = sourceType === 'promo' ? 'PROMO' : (raw.set_id || defaultSetId(sourceType));
  const groupSetName = sourceType === 'promo' ? 'Promo' : (raw.set_name || defaultSetName(sourceType));
  return ({
  id,
  displayId: baseId,
  variantTag: tag,
  variant: variant || '',
  name: cleanedName,
  fullName: raw.optcg_don_name || raw.card_name,
  setId: groupSetId,
  setName: groupSetName,
  originalSetId: raw.set_id || '',
  rarity: raw.rarity,
  type: raw.card_type,
  color: raw.card_color,
  cost: raw.card_cost,
  power: raw.card_power,
  life: raw.life,
  counter: raw.counter_amount,
  attribute: raw.attribute,
  subTypes: raw.sub_types,
  text: raw.card_text,
  marketPrice: Number(raw.market_price) || 0,
  inventoryPrice: Number(raw.inventory_price) || 0,
  imageUrl: raw.card_image,
  imageId: raw.card_image_id || id,
  isParallel: /\(Parallel\)|\(Alternate\)|_p\d/i.test(raw.card_name || '') || /_p\d/i.test(raw.card_image_id || ''),
  source: sourceType,
});
};

let catalogPromise = null;

// Read whatever's in the cache, regardless of age. Returns null on miss.
const readCachedCatalog = () => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, cards } = JSON.parse(raw);
    if (Array.isArray(cards) && cards.length > 0) return { cards, age: Date.now() - ts };
  } catch {}
  return null;
};

// loadCatalog uses stale-while-revalidate:
//   - Fresh cache (<24h): return it.
//   - Stale cache: return the stale data instantly AND kick off a background
//     refetch that updates the cache for the next page load.
//   - No cache: block on the fetch (first-time visitor).
// Pass `force: true` to always block-and-refetch.
export const loadCatalog = async ({ force = false } = {}) => {
  if (!force) {
    const cached = readCachedCatalog();
    if (cached) {
      if (cached.age >= CACHE_TTL_MS) {
        // Stale — refresh in the background, don't await it.
        revalidateCatalog().catch((e) => console.warn('catalog revalidate failed', e));
      }
      return cached.cards;
    }
  }
  return revalidateCatalog();
};

const revalidateCatalog = async () => {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const results = await Promise.all([
      fetchJSON(`${API}/allSetCards/`).catch((e) => { console.warn('allSetCards failed', e); return []; }),
      fetchJSON(`${API}/allSTCards/`).catch((e) => { console.warn('allSTCards failed', e); return []; }),
      fetchJSON(`${API}/allPromos/`).catch((e) => { console.warn('allPromos failed', e); return []; }),
      fetchJSON(`${API}/allDonCards/`).catch((e) => { console.warn('allDonCards failed', e); return []; }),
    ]);
    const [sets, sts, promos, dons] = results;

    const cards = [
      ...sets.map(c => normalize(c, 'set')),
      ...sts.map(c => normalize(c, 'starter')),
      ...promos.map(c => normalize(c, 'promo')),
      ...dons.map(c => normalize(c, 'don')),
    ].filter(c => c.id);

    // De-dupe — id is now unique per physical variant (promos with shared
    // base card_set_id get disambiguated via variantTag in normalize()), so
    // collisions here only happen when the same card appears in two endpoints.
    const byKey = new Map();
    for (const c of cards) {
      const key = c.id;
      const existing = byKey.get(key);
      if (!existing || (c.marketPrice && !existing.marketPrice)) byKey.set(key, c);
    }

    const final = Array.from(byKey.values()).sort((a, b) => {
      if (a.setId !== b.setId) return compareSets(a, b);
      return (a.id || '').localeCompare(b.id || '');
    });

    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), cards: final }));
    } catch {
      // localStorage might be full — strip down to essentials
      const slim = final.map(c => ({
        id: c.id, name: c.name, fullName: c.fullName, setId: c.setId, setName: c.setName,
        rarity: c.rarity, type: c.type, color: c.color, cost: c.cost, power: c.power,
        life: c.life, counter: c.counter, attribute: c.attribute, subTypes: c.subTypes,
        marketPrice: c.marketPrice, inventoryPrice: c.inventoryPrice,
        imageUrl: c.imageUrl, imageId: c.imageId, isParallel: c.isParallel, source: c.source,
      }));
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), cards: slim })); } catch {}
    }

    return final;
  })().finally(() => { catalogPromise = null; });

  return catalogPromise;
};

export const refreshCard = async (cardId) => {
  // Fetch fresh data for one card (used when opening detail drawer)
  try {
    const res = await fetchJSON(`${API}/sets/card/${cardId}/`);
    if (Array.isArray(res) && res.length > 0) {
      return res.map(c => normalize(c, 'set'));
    }
  } catch {}
  return [];
};

export const loadPriceHistory = async (cardId) => {
  try {
    const cached = localStorage.getItem(HISTORY_PREFIX + cardId);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < HISTORY_TTL_MS) return data;
    }
  } catch {}

  try {
    // Try set, then starter, then promo endpoints
    let data = null;
    for (const path of [
      `${API}/sets/card/twoweeks/${cardId}/`,
      `${API}/decks/card/twoweeks/${cardId}/`,
      `${API}/promos/card/twoweeks/${cardId}/`,
    ]) {
      try {
        const res = await fetchJSON(path);
        if (Array.isArray(res) && res.length > 0) { data = res; break; }
      } catch {}
    }
    if (!data) return [];

    const points = data
      .map(d => ({
        date: d.date_scraped || d.date || d.scrape_date,
        price: Number(d.market_price ?? d.inventory_price) || 0,
      }))
      .filter(p => p.date && p.price > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    try {
      localStorage.setItem(HISTORY_PREFIX + cardId, JSON.stringify({ ts: Date.now(), data: points }));
    } catch {}

    return points;
  } catch (e) {
    console.error(e);
    return [];
  }
};

// Sort bucket: lower number = appears first.
//   1: OP main boosters (OP-01, OP-02, …)
//   2: Other sets (EB, PRB, OP##-EB##)
//   3: PROMO group
//   4: Starter decks (ST-01, ST-02, …)
//   5: DON
//   9: anything unrecognized
const bucketOfSet = (setId) => {
  if (!setId) return 9;
  if (/^OP-?\d+$/.test(setId)) return 1;
  if (setId === 'PROMO') return 3;
  if (/^ST-?\d+$/.test(setId)) return 4;
  if (setId === 'DON') return 5;
  return 2; // EB-xx, PRB-xx, OP##-EB##, anything else "setty"
};

const numericPart = (setId) => parseInt(((setId || '').match(/(\d+)/) || [])[1] || '0', 10);

export const compareSets = (a, b) => {
  const ab = bucketOfSet(a.setId);
  const bb = bucketOfSet(b.setId);
  if (ab !== bb) return ab - bb;
  // Same bucket: numeric within OP boosters and starters; alphabetical elsewhere
  if (ab === 1 || ab === 4) return numericPart(a.setId) - numericPart(b.setId);
  return (a.setId || '').localeCompare(b.setId || '');
};

export const groupBySet = (cards) => {
  const groups = new Map();
  for (const c of cards) {
    const key = c.setId || 'OTHER';
    if (!groups.has(key)) groups.set(key, { setId: key, setName: c.setName, cards: [] });
    groups.get(key).cards.push(c);
  }
  return Array.from(groups.values()).sort(compareSets);
};
