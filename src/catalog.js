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
// v8 bumps the cache key after adding canonicalId to each card object —
// older cached entries don't have it and would break canonical-id lookups.
const CACHE_KEY = 'optcg:catalog:v8';
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

// Build the source-stable canonical id for a normalized card object.
// Format: [<sourceSet>:]<displayId>[-<variantTag>]
//   - sourceSet prefix is included only when it differs from the identity
//     set baked into displayId. So a base OP11-118 stays "OP11-118"; an OP12
//     reprint of ST01-004 becomes "OP12:ST01-004"; a PROMO printing of
//     OP09-077 becomes "PROMO:OP09-077-<tag>".
//   - variantTag is parallel-index (p1, p2…), our pre-errata flag, or the
//     slugified promo variant.
//
// Pass a card after augmentWithErrata if you want the pre-errata twin's
// canonical id (its variantTag is set there).
export const canonicalIdOf = (card) => {
  if (!card) return '';
  const display = card.displayId || card.id || '';
  // OPTCGAPI gives us set ids like "OP-12"; strip the dash so we can prefix
  // cleanly and compare against the displayId's leading set token.
  const sourceNorm = (card.setId || '').replace(/-/g, '');
  const identityPrefix = display.split('-')[0];

  // Variant tag: pre-errata flag wins, then a _p\d suffix on imageId/id, then
  // any explicit promo variantTag we already computed in normalize().
  let variantTag = '';
  if (card.variantTag === 'pre-errata') {
    variantTag = 'pre-errata';
  } else {
    const parallelMatch = (card.imageId || card.id || '').match(/_p(\d+)$/i);
    if (parallelMatch) variantTag = `p${parallelMatch[1]}`;
    else if (card.variantTag) variantTag = card.variantTag;
  }
  const variantSuffix = variantTag ? `-${variantTag}` : '';

  if (sourceNorm && identityPrefix && sourceNorm !== identityPrefix) {
    return `${sourceNorm}:${display}${variantSuffix}`;
  }
  return `${display}${variantSuffix}`;
};

// Normalize one card response into our shape
const normalize = (raw, sourceType) => {
  const baseId = raw.card_set_id || raw.card_id || raw.don_id || raw.card_image_id;
  // Only promos carry a meaningful variant suffix; sets/starters/Dons keep their parens intact
  const variant = sourceType === 'promo' ? extractParen(raw.card_name) : null;
  const tag = variant ? slugify(variant) : '';
  // id must be unique per physical printing — for sets/starters a parallel
  // (e.g. ST29-014 base vs ST29-014_p1) shares card_set_id but has a unique
  // card_image_id, so prefer that when no variant tag was derived.
  const id = tag
    ? `${baseId}__${tag}`
    : (raw.card_image_id || baseId);
  const rawName = raw.card_name || '';
  const cleanedName = variant
    ? rawName.replace(/\s*\([^)]+\)\s*$/, '').trim()
    : rawName.replace(/\s*\(\d+\)\s*$/, '').trim();
  // Promos always live in their own PROMO bucket regardless of their original
  // parent set_id — otherwise the OP09-077 promo gets mixed into the OP-09
  // booster group. We preserve the original set on `originalSetId` for ref.
  const groupSetId = sourceType === 'promo' ? 'PROMO' : (raw.set_id || defaultSetId(sourceType));
  const groupSetName = sourceType === 'promo' ? 'Promo' : (raw.set_name || defaultSetName(sourceType));
  const card = {
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
  };
  card.canonicalId = canonicalIdOf(card);
  return card;
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

    // De-dupe by imageId, which is unique per physical printing — sets and
    // starters use card_image_id (e.g. "OP01-016_p1" for the parallel of
    // OP01-016), and promos without a card_image_id fall back to our
    // disambiguated id (with the variant tag baked in via normalize()).
    // Using c.id alone collapses parallels into their base printings.
    const byKey = new Map();
    for (const c of cards) {
      const key = c.imageId || c.id;
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
        id: c.id, canonicalId: c.canonicalId, displayId: c.displayId,
        variantTag: c.variantTag, variant: c.variant,
        name: c.name, fullName: c.fullName, setId: c.setId, setName: c.setName,
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

// Strip the parallel/variant suffix off a card id so we cache history under
// the base printing's key (parallels share history with the base anyway,
// since OPTCGAPI only tracks history at the base level).
const stripVariantForApi = (cardId) => {
  if (!cardId) return cardId;
  let id = String(cardId).split('__')[0];
  id = id.replace(/_p\d+$/i, '');
  const canonical = id.match(/^[A-Z]+\d+-\d+/i);
  return canonical ? canonical[0] : id;
};

// Pull 14-day price history through our /api/optcg-history proxy. The
// proxy handles OPTCGAPI's "500 + no CORS headers" responses server-side
// and always returns 200 + a (possibly empty) points array, so the browser
// console stays quiet on cards with no history. Cache the result (including
// empty) for HISTORY_TTL_MS.
export const loadPriceHistory = async (cardId) => {
  const queryId = stripVariantForApi(cardId);
  const cacheKey = HISTORY_PREFIX + queryId;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < HISTORY_TTL_MS) return data;
    }
  } catch {}

  let points = [];
  try {
    const res = await fetch(`/api/optcg-history?id=${encodeURIComponent(queryId)}`);
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body?.points)) points = body.points;
    }
  } catch (e) {
    console.warn('[catalog] history proxy fetch failed', e);
  }

  try {
    localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: points }));
  } catch {}

  return points;
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

// ============================================================================
// Pre-errata twins. A user marks a card as having a pre-errata printing; the
// catalog then exposes both versions as separate entries (base = post-errata,
// twin = pre-errata) so they can be logged independently with their own
// prices, contributions, grading, etc. Persisted in localStorage; survives
// catalog cache bumps.
// ============================================================================

const ERRATA_KEY = 'optcg:errata:v1';
const ERRATA_SUFFIX = '__pre-errata';

const readErrataSet = () => {
  try {
    const raw = localStorage.getItem(ERRATA_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
};

export const hasPreErrata = (cardId) => readErrataSet().has(cardId);

export const togglePreErrata = (cardId) => {
  const set = readErrataSet();
  if (set.has(cardId)) set.delete(cardId); else set.add(cardId);
  try { localStorage.setItem(ERRATA_KEY, JSON.stringify([...set])); } catch {}
  return set.has(cardId);
};

// Given a catalog array, append a pre-errata twin for each card whose base id
// is in the errata set. Twins share everything with the base except:
//   - id is suffixed so React keys, entry lookups, and PriceCharting variant
//     picks stay distinct from the base post-errata printing
//   - variant/variantTag carry the "Pre-errata" label so the UI shows a pill
//   - canonicalId is recomputed against the new variantTag
export const augmentWithErrata = (catalog) => {
  const set = readErrataSet();
  if (set.size === 0) return catalog;
  const twins = [];
  for (const c of catalog) {
    if (!set.has(c.id)) continue;
    const twin = {
      ...c,
      id: `${c.id}${ERRATA_SUFFIX}`,
      variant: 'Pre-errata',
      variantTag: 'pre-errata',
    };
    twin.canonicalId = canonicalIdOf(twin);
    twins.push(twin);
  }
  return twins.length > 0 ? [...catalog, ...twins] : catalog;
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
