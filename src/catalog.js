// ============================================================================
// Card catalog — TCGPlayer (via TCGCSV) as the single source of truth.
//
// We hit /api/tcgcsv?all=1 once on first load, get every product TCGPlayer
// has in the One Piece TCG category (~3000–5000 products including the
// release-event "RE" groups and tournament "ANN" prize sets that OPTCGAPI
// doesn't ship), and assemble a catalog where each card IS a TCGPlayer
// product. This means every card knows its `tcg_id` at catalog-build time —
// no per-card Resolve step is needed for the default mapping. The user-
// edited resolution layer (in pricing.js) survives as an OPTIONAL override.
//
// Cache: localStorage, keyed by `optcg:catalog:v11:<variant-fingerprint>`.
// Re-derives when the user edits printing-attribute variants.
//
// Trade-off vs the OPTCGAPI source we replaced (2026-06-01):
//   + Complete printing coverage (every TCGPlayer product, every event set).
//   + Each card already knows its tcg_id — no "unresolved" workflow.
//   − No game data: color, type, cost, power, life, counter, attribute,
//     sub_types, card text. TCGPlayer is sales metadata.
//   − Card names are sales-formatted with the parenthetical variant suffixes
//     intact (e.g., "Shanks (Parallel) (Manga Rare)"); we keep the cleaned
//     form as `name` and the full form as `fullName`.
//   − Pre-errata twins are still supported (purely user-marked), but the
//     OPTCGAPI-curated errata-set heuristic is gone.
//   − No 14-day price history (OPTCGAPI's `/twoweeks/` endpoint).
// ============================================================================

import { detectPrintingAttributes, printingAttributesFingerprint } from './printing-attributes.js';

const CATALOG_ENDPOINT = '/api/tcgcsv?all=1';
// v11 = TCGPlayer-sourced catalog (was v10 OPTCGAPI-sourced). The fingerprint
// suffix invalidates cache when the user edits variant detection rules.
const CACHE_KEY_BASE = 'optcg:catalog:v11';
const cacheKey = () => `${CACHE_KEY_BASE}:${printingAttributesFingerprint()}`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const fetchJSON = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
};

// Normalize a set abbreviation / id to a stable comparable token.
//   "OP-14"   → "OP14"
//   "OP14 RE" → "OP14RE"
//   "ST-29"   → "ST29"
const normSetToken = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Compute the leading set token from a TCGPlayer product number.
//   "OP14-118"   → "OP14"
//   "ST29-001"   → "ST29"
//   "P-001"      → "P"
const identityPrefixOf = (displayId) => {
  if (!displayId) return '';
  const m = displayId.match(/^[A-Z]+\d*/i);
  return m ? m[0].toUpperCase() : '';
};

// Strip TCGPlayer's parenthetical variant suffixes off the product name to
// produce a clean game-style card name.
//   "Shanks (Parallel) (Manga Rare) (Alternate Art)" → "Shanks"
//   "Monkey D. Luffy (012)"                          → "Monkey D. Luffy"
const cleanGameName = (rawName) => {
  if (!rawName) return '';
  return String(rawName)
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

// Build the source-stable canonical id for a normalized card.
// Format: `[<sourceSet>:]<displayId>[-<attributeTag>]`
//   - sourceSet prefix is included only when the card's set differs from the
//     identity baked into the displayId. So a base OP14-118 in the OP14 group
//     stays "OP14-118"; the same number in "OP14 RE" becomes "OP14RE:OP14-118".
//   - attributeTag is the sorted printing attributes joined by "-"
//     (e.g., "parallel", "manga", "manga-parallel"). Empty for base printings.
// Collisions (multiple products sharing the same canonical) get a `-<tcg_id>`
// suffix appended downstream in `finalizeCanonicalIds`.
export const canonicalIdOf = (card) => {
  if (!card) return '';
  const display = card.displayId || '';
  const sourceNorm = normSetToken(card.setId);
  const identityPrefix = identityPrefixOf(display);
  const attrs = Array.isArray(card.attributes) ? [...card.attributes].sort() : [];
  // Pre-errata twin override wins over attribute-driven tags.
  let tag = '';
  if (card.variantTag === 'pre-errata') tag = 'pre-errata';
  else if (attrs.length > 0) tag = attrs.join('-');
  const suffix = tag ? `-${tag}` : '';
  if (sourceNorm && identityPrefix && sourceNorm !== identityPrefix) {
    return `${sourceNorm}:${display}${suffix}`;
  }
  return `${display}${suffix}`;
};

// TCGPlayer product → catalog card. Game data fields (color, cost, etc.)
// stay undefined; consumers should render gracefully when absent.
const normalize = (product) => {
  const number = product.number || '';
  const setAbbr = product.group_abbreviation || '';
  const setName = product.group_name || '';
  const rawName = product.name || '';
  const card = {
    id: String(product.tcg_id),
    displayId: number,
    name: cleanGameName(product.clean_name || rawName),
    fullName: rawName,
    cleanName: product.clean_name || '',
    setId: setAbbr,
    setName,
    setAbbreviation: setAbbr,
    rarity: product.rarity || '',
    imageUrl: product.image_url || '',
    tcgplayerUrl: product.tcgplayer_url || '',
    tcg_id: Number(product.tcg_id) || 0,
    // Pricing snapshot at catalog-build time. The per-card price cache
    // (pricing.js PRICE_CACHE_KEY) is the live source — this is the
    // initial value for display before any refresh.
    marketPrice: Number(product.market_price) || 0,
    lowPrice: Number(product.low_price) || 0,
    midPrice: Number(product.mid_price) || 0,
    highPrice: Number(product.high_price) || 0,
    // Generic printing attributes from the registry (parallel, manga, plus
    // any user-defined variant). Same regex applied to TCGPlayer's full
    // product name.
    attributes: detectPrintingAttributes(rawName),
    source: 'tcgplayer',
  };
  // Derived booleans for back-compat with code that still reads them.
  card.isParallel = card.attributes.includes('parallel');
  card.isManga = card.attributes.includes('manga');
  return card;
};

// Two-pass canonical id assignment that breaks collisions (multiple products
// share the same displayId + attribute set — rare but possible) by appending
// the tcg_id to all collisions so each canonical id is globally unique.
const finalizeCanonicalIds = (cards) => {
  const baseFor = new Map();
  for (const c of cards) baseFor.set(c, canonicalIdOf(c));
  const counts = new Map();
  for (const base of baseFor.values()) counts.set(base, (counts.get(base) || 0) + 1);
  for (const c of cards) {
    const base = baseFor.get(c);
    c.canonicalId = counts.get(base) > 1 ? `${base}-${c.tcg_id}` : base;
  }
  return cards;
};

// Sort bucket: lower number = appears first in the Search view's set groups.
//   1: OP main boosters (OP01, OP02, …)
//   2: Release-event / tournament / anniversary groups (OP14 RE, OP05 ANN, …)
//   3: Extra boosters (EB, PRB)
//   4: Starter decks (ST, ST-EX)
//   5: Promos
//   6: DON
//   9: anything unrecognized
const bucketOfSet = (setId) => {
  if (!setId) return 9;
  const norm = normSetToken(setId);
  if (/^OP\d+(RE|ANN)$/.test(norm)) return 2;
  if (/^OP\d+$/.test(norm)) return 1;
  if (/^EB\d*$/.test(norm) || /^PRB\d*$/.test(norm)) return 3;
  if (/^ST/.test(norm)) return 4;
  if (/^P$/.test(norm) || /PROMO/.test(norm)) return 5;
  if (/^DON/.test(norm)) return 6;
  return 9;
};

const numericPart = (setId) => parseInt(((setId || '').match(/(\d+)/) || [])[1] || '0', 10);

// Group catalog cards by set for the Search view's set-grouped layout.
export const groupBySet = (cards) => {
  const groups = new Map();
  for (const c of cards) {
    const key = c.setId || 'OTHER';
    if (!groups.has(key)) groups.set(key, { setId: key, setName: c.setName, cards: [] });
    groups.get(key).cards.push(c);
  }
  return Array.from(groups.values()).sort(compareSets);
};

export const compareSets = (a, b) => {
  const ab = bucketOfSet(a.setId);
  const bb = bucketOfSet(b.setId);
  if (ab !== bb) return ab - bb;
  // Same bucket: numeric within OP boosters and starters; alphabetical elsewhere.
  if (ab === 1 || ab === 2 || ab === 4) return numericPart(a.setId) - numericPart(b.setId);
  return (a.setId || '').localeCompare(b.setId || '');
};

// ---------------------------------------------------------------------------
// Loader + cache
// ---------------------------------------------------------------------------

const readCachedCatalog = () => {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    const { ts, cards } = JSON.parse(raw);
    if (!Array.isArray(cards) || cards.length === 0) return null;
    return { age: Date.now() - (ts || 0), cards };
  } catch { return null; }
};

let catalogPromise = null;

export const loadCatalog = async ({ force = false } = {}) => {
  if (!force) {
    const cached = readCachedCatalog();
    if (cached) {
      if (cached.age >= CACHE_TTL_MS) {
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
    const body = await fetchJSON(CATALOG_ENDPOINT);
    const products = Array.isArray(body?.products) ? body.products : [];
    const cards = products.map(normalize).filter(c => c.id && c.displayId);
    finalizeCanonicalIds(cards);
    const final = cards.sort((a, b) => {
      if (a.setId !== b.setId) return compareSets(a, b);
      return (a.displayId || '').localeCompare(b.displayId || '');
    });

    try {
      localStorage.setItem(cacheKey(), JSON.stringify({ ts: Date.now(), cards: final }));
    } catch {
      // localStorage might be full — try a slim variant without the price
      // snapshot fields (the price cache fills those in live).
      const slim = final.map(c => ({
        id: c.id, canonicalId: c.canonicalId, displayId: c.displayId,
        name: c.name, fullName: c.fullName, cleanName: c.cleanName,
        setId: c.setId, setName: c.setName, setAbbreviation: c.setAbbreviation,
        rarity: c.rarity, imageUrl: c.imageUrl, tcgplayerUrl: c.tcgplayerUrl,
        tcg_id: c.tcg_id, attributes: c.attributes,
        isParallel: c.isParallel, isManga: c.isManga, source: c.source,
      }));
      try { localStorage.setItem(cacheKey(), JSON.stringify({ ts: Date.now(), cards: slim })); } catch {}
    }

    return final;
  })().finally(() => { catalogPromise = null; });

  return catalogPromise;
};

// ---------------------------------------------------------------------------
// Price history — OPTCGAPI's `/twoweeks/` endpoint is gone with the source
// switch. Stubbed to return `[]` so the detail drawer's trend widget shows a
// neutral "—". Could be replaced with a self-tracked snapshot table later.
// ---------------------------------------------------------------------------
export const loadPriceHistory = async () => [];

// ---------------------------------------------------------------------------
// Pre-errata twins. A user marks a card as having a pre-errata printing; the
// catalog then exposes both versions as separate entries (base = post-errata,
// twin = pre-errata) so they can be logged independently with their own
// prices, contributions, grading, etc. Persisted in localStorage; survives
// catalog cache bumps.
// ---------------------------------------------------------------------------

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
