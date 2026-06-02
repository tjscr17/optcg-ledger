// ============================================================================
// TCGCSV pricing client — talks to /api/tcgcsv (Vercel function in prod,
// Vite middleware in dev) to fetch the latest TCGPlayer market prices for
// One Piece TCG cards. The sole price source for this app.
//
// Lookups are keyed on TCGPlayer's `productId` (stored as `tcg_id` on
// card_resolutions and on the local resolution cache). The variant resolver
// in the Resolve view populates this mapping; users can also pick a
// printing directly from the AddCardModal flow.
//
// Caches the per-card snapshot in localStorage so a Collection view with
// hundreds of cards doesn't slam the proxy on every render. A tiny pub/sub
// (`onPriceResolved`) lets consumers re-render when a previously-pending
// price lands.
// ============================================================================

import { store, MODE } from './storage.js';
import { getPrintingAttributes, detectPrintingAttributes } from './printing-attributes.js';
import { applyAttributeOverride } from './card-attribute-overrides.js';

const PRICE_CACHE_KEY = 'optcg:tcgcsv:prices:v1';
const PRICE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — TCGCSV refreshes daily, this is generous

// Primary card_id → TCGPlayer productId cache. Written by the TCGCSV
// resolver (Stage 3) and by `runPcCleanup` (Stage 5, which promotes the
// legacy PriceCharting image cache's `card_id → tcg_id` mappings into
// here once before deleting the PC keys).
const RESOLUTION_CACHE_KEY = 'optcg:tcgcsv:resolutions:v1';

// An in-memory Map is the source of truth for resolution reads. localStorage
// is only a warm-start cache. The reason: at full-catalog scale (thousands of
// resolutions alongside the catalog + price caches) a single JSON blob blows
// past the ~5MB localStorage quota. The old code read/wrote that blob directly
// on every save inside a swallowed try/catch, so once the quota was hit every
// write threw and was silently dropped — bulk "Auto-resolve all" reported
// "3602 resolved" while the unresolved count never budged. Decoupling reads
// from localStorage (Map for reads, Supabase as the durable store in shared
// mode, best-effort debounced localStorage for warm starts) fixes that.
let resolutionMap = null;       // Map<cardId, summary> | null until hydrated
let resolutionPersistTimer = null;

// "Resolutions ready" gate. In shared mode the durable resolutions live in
// Supabase and load asynchronously (hydrateResolutionsFromShared). Until that
// lands, the Map is only warm-started from localStorage — which overflows at
// full-catalog scale and can't hold everything — so a card can look unresolved
// when it actually isn't. autoResolveCard awaits this before deciding to do a
// (redundant, network-hammering) re-resolve. Solo mode is ready immediately:
// localStorage is the only store and ensureResolutionMap reads it synchronously.
let markResolutionsReady;
const resolutionsReady = MODE === 'shared'
  ? new Promise((resolve) => { markResolutionsReady = resolve; })
  : Promise.resolve();
export const whenResolutionsReady = () => resolutionsReady;

// How many resolutions the last shared-mode hydrate pulled from Supabase.
// -1 = not hydrated yet (or solo mode). Surfaced in the Resolve view so the
// user can confirm the cloud load worked without opening the console.
let lastHydratedCount = -1;
export const getHydratedResolutionCount = () => lastHydratedCount;

const ensureResolutionMap = () => {
  if (resolutionMap) return resolutionMap;
  resolutionMap = new Map();
  try {
    const raw = localStorage.getItem(RESOLUTION_CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [cardId, summary] of Object.entries(obj)) {
        if (cardId && summary) resolutionMap.set(cardId, summary);
      }
    }
  } catch {}
  return resolutionMap;
};

// Best-effort, debounced localStorage flush. Coalesces the thousands of writes
// a bulk resolve produces into a single serialization and tolerates quota
// failures — the Map (this session) and Supabase (across sessions, shared
// mode) stay authoritative regardless.
const persistResolutionsNow = () => {
  if (!resolutionMap) return;
  try {
    const obj = {};
    for (const [cardId, summary] of resolutionMap) obj[cardId] = summary;
    localStorage.setItem(RESOLUTION_CACHE_KEY, JSON.stringify(obj));
  } catch {}
};

const scheduleResolutionPersist = () => {
  if (resolutionPersistTimer) return;
  resolutionPersistTimer = setTimeout(() => {
    resolutionPersistTimer = null;
    persistResolutionsNow();
  }, 500);
};

// Synchronous lookup: returns the TCGPlayer productId for a canonical
// card id, or null when we haven't resolved one yet. Also tries the
// legacy OPTCG-style id as a fallback key — useful right after the
// canonical migration when a row may have been keyed under either form.
export const getTcgId = (cardId, legacyId) => {
  if (!cardId && !legacyId) return null;
  const map = ensureResolutionMap();
  const hit = (cardId && map.get(cardId)?.tcg_id)
    || (legacyId && map.get(legacyId)?.tcg_id)
    || null;
  return hit ? Number(hit) : null;
};

// Synchronous lookup of the full resolution summary (name, image, parallel
// flag, etc.) saved when the user picked a product in the resolver. Returns
// null when no TCGCSV resolution exists yet. Used by the resolver UI to
// show "previously picked" state.
export const getResolution = (cardId) => {
  if (!cardId) return null;
  return ensureResolutionMap().get(cardId) || null;
};

const readCache = () => {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
};
const writeCache = (cache) => {
  try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache)); } catch {}
};

// Dedup concurrent fetches for the same tcgId across components in the same
// tick — the Collection view kicks off dozens at once on first paint.
const inFlight = new Map();

const listeners = new Set();
// Subscribe to price-resolved events. Callback receives the tcgId that
// just landed in cache. Returns an unsubscribe function.
export const onPriceResolved = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const emit = (tcgId) => {
  for (const cb of listeners) {
    try { cb(tcgId); } catch {}
  }
};

// Synchronous read of the cached snapshot for a tcgId. Returns the full
// snapshot object (`{ market_price, low_price, ... fetched_at }`) or null
// when not cached or non-positive market price (we treat 0/null as "no
// signal" so callers fall back to "—" instead of showing $0.00).
export const getCachedSnapshot = (tcgId) => {
  if (!tcgId) return null;
  const cache = readCache();
  const snap = cache[String(tcgId)];
  if (!snap) return null;
  return snap;
};

// Synchronous market-price read in dollars. Returns null if not cached or
// no usable market price.
export const getCachedMarketPrice = (tcgId) => {
  const snap = getCachedSnapshot(tcgId);
  if (!snap) return null;
  const p = Number(snap.market_price);
  return Number.isFinite(p) && p > 0 ? p : null;
};

// True if the cached snapshot is fresh enough that we shouldn't refetch.
export const isPriceFresh = (tcgId) => {
  const snap = getCachedSnapshot(tcgId);
  if (!snap?.cached_at) return false;
  return Date.now() - snap.cached_at < PRICE_TTL_MS;
};

// Fetch (or refresh) the price snapshot for a tcgId. Returns the snapshot
// or null on failure. Caches successful responses in localStorage and
// notifies subscribers via onPriceResolved.
//
// Set `force: true` to bypass the TTL.
export const fetchPriceSnapshot = async (tcgId, { force = false } = {}) => {
  if (!tcgId) return null;
  const key = String(tcgId);

  if (!force) {
    const cache = readCache();
    const cached = cache[key];
    if (cached?.cached_at && Date.now() - cached.cached_at < PRICE_TTL_MS) return cached;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const r = await fetch(`/api/tcgcsv?tcgId=${encodeURIComponent(key)}`);
      // The proxy now returns 200 + `{ not_found: true }` for unknown
      // productIds (used to be a 404 — kept the browser console noisy on
      // stale resolutions). Legacy 404 handling stays for older deploys.
      if (r.status === 404) {
        const cache = readCache();
        cache[key] = { tcg_id: Number(key), market_price: null, cached_at: Date.now(), not_found: true };
        writeCache(cache);
        emit(Number(key));
        return cache[key];
      }
      if (!r.ok) return null;
      const snap = await r.json();
      const stamped = { ...snap, cached_at: Date.now() };
      const cache = readCache();
      cache[key] = stamped;
      writeCache(cache);
      emit(Number(key));
      return stamped;
    } catch (e) {
      console.warn('[tcgcsv] fetch failed for', key, e);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
};

// Returns the effective tcg_id for a card: a user-saved resolution wins
// (override), else the catalog card's built-in `tcg_id` (TCGPlayer-source
// catalog), else null. Pre-2026-06-01 catalog cards had no built-in tcg_id
// and relied entirely on the resolution layer; that path still works.
export const effectiveTcgId = (card) => {
  if (!card) return null;
  const override = getTcgId(card.canonicalId, card.id);
  if (override) return override;
  const baked = Number(card.tcg_id);
  return Number.isFinite(baked) && baked > 0 ? baked : null;
};

// Card-level convenience: returns the TCGCSV market price for a catalog
// card. Reads from the price cache; pure (no fetch). Prefers an override
// resolution, falls back to the card's built-in tcg_id, then to the
// catalog-baked marketPrice snapshot as a last resort.
export const getMarketPriceForCard = (card) => {
  if (!card) return null;
  const tcgId = effectiveTcgId(card);
  if (tcgId) {
    const cached = getCachedMarketPrice(tcgId);
    if (cached != null) return cached;
  }
  const baked = Number(card.marketPrice);
  return Number.isFinite(baked) && baked > 0 ? baked : null;
};

// Synchronous image URL for a card whose OPTCGAPI image is missing.
// Uses the saved TCGCSV resolution's image_url; if absent but a tcg_id is
// known, constructs the TCGPlayer CDN URL directly. Returns null when no
// resolution exists.
const tcgImageUrlFromId = (tcgId) =>
  tcgId ? `https://tcgplayer-cdn.tcgplayer.com/product/${tcgId}_in_1000x1000.jpg` : null;

export const getCachedImageForCard = (card) => {
  if (!card) return null;
  // Catalog card is authoritative — TCGPlayer-sourced cards have imageUrl
  // baked in from the same product the tcgplayerUrl points to, so image and
  // link stay consistent. The resolution layer's image_url is no longer
  // consulted here (it could disagree with card.tcgplayerUrl when an old
  // autoResolveCard heuristic pick targeted a different product, e.g. SP
  // Gold's image with the catalog still linking to SP Silver).
  if (card.imageUrl) return card.imageUrl;
  const tcgId = effectiveTcgId(card);
  return tcgImageUrlFromId(tcgId);
};

// Card-level convenience: kicks off a price fetch if we have a tcg_id and
// the cache is stale. Returns the resolved snapshot (or null if nothing
// could be fetched). Fire-and-forget friendly — callers that just want to
// warm the cache can ignore the returned promise.
export const ensurePriceForCard = async (card) => {
  if (!card) return null;
  const tcgId = effectiveTcgId(card);
  if (!tcgId) return null;
  if (isPriceFresh(tcgId)) return getCachedSnapshot(tcgId);
  return fetchPriceSnapshot(tcgId);
};

// ---------------------------------------------------------------------------
// Variant resolution (Stage 3): find all TCGPlayer products matching an
// OPTCG card identity, and persist the user's pick so future price lookups
// know which printing this is.
// ---------------------------------------------------------------------------

// Strip our canonical-id format down to the bare card identity expected by
// TCGCSV's `?number=` search. Canonical id format:
//   [<sourceSet>:]<displayId>[-<variantTag>]
// We want just `<displayId>` (e.g. "ST01-004").
export const cardNumberFromCanonical = (canonicalId) => {
  if (!canonicalId) return '';
  // Drop the optional source-set prefix.
  const afterColon = canonicalId.includes(':') ? canonicalId.split(':')[1] : canonicalId;
  // Keep just the leading `<setCode>-<cardNumber>` (canonical guarantees
  // setCode is letters+digits and cardNumber is digits).
  const m = afterColon.match(/^[A-Z]+\d+-\d+/i);
  return m ? m[0].toUpperCase() : afterColon.toUpperCase();
};

// Fetch all TCGPlayer products whose extendedData.Number matches `displayId`.
// Each entry is enriched with the current price snapshot. Returns [] on
// error. Caller is responsible for any UI throttling.
export const searchTcgProducts = async (displayId) => {
  const number = (displayId || '').trim().toUpperCase();
  if (!number) return [];
  try {
    const r = await fetch(`/api/tcgcsv?number=${encodeURIComponent(number)}`);
    if (!r.ok) return [];
    const body = await r.json();
    const products = Array.isArray(body?.products) ? body.products : [];
    // Re-derive attributes client-side so user-defined variants take effect
    // even though the server's prebuilt is_parallel / is_manga hints don't
    // know about them. The proxy's hints become decorative.
    return products.map(p => ({ ...p, attributes: detectPrintingAttributes(p.name) }));
  } catch (e) {
    console.warn('[tcgcsv] product search failed for', number, e);
    return [];
  }
};

// True if the card has the given attribute. Applies per-card user overrides
// when the card carries a canonicalId; falls back to derived booleans for
// legacy card objects (pre-attributes-refactor) that lack the array.
const cardHasAttr = (card, key) => {
  if (Array.isArray(card?.attributes)) {
    const effective = card.canonicalId
      ? applyAttributeOverride(card.canonicalId, card.attributes)
      : card.attributes;
    return effective.includes(key);
  }
  if (key === 'parallel') return Boolean(card?.isParallel);
  if (key === 'manga') return Boolean(card?.isManga);
  return false;
};

// True if a product has the attribute. Products always carry `attributes`
// after searchTcgProducts decoration; fall back to the legacy is_* fields
// for cached resolution snapshots saved before the refactor.
const productHasAttr = (product, key) => {
  if (Array.isArray(product?.attributes)) return product.attributes.includes(key);
  if (key === 'parallel') return Boolean(product?.is_parallel);
  if (key === 'manga') return Boolean(product?.is_manga);
  return false;
};

// Pick the TCGPlayer product that best matches a given catalog card. Scoring
// is generic across the printing-attribute registry — every attribute key
// (parallel, manga, plus any user-defined) contributes +60 when card and
// product agree on it. Other weights:
//   +100  group_abbreviation matches the card's source set
//   + 10  has a market price (prefer products with actual pricing data)
// Ties broken by market_price desc. Returns null if products is empty.
export const pickBestMatchForCard = (card, products) => {
  if (!card || !Array.isArray(products) || products.length === 0) return null;
  const cardSetNorm = (card.setId || '').replace(/-/g, '').toUpperCase();
  const attrDefs = getPrintingAttributes();
  const scored = products.map(p => {
    let score = 0;
    const abbrNorm = (p.group_abbreviation || '').replace(/-/g, '').toUpperCase();
    if (cardSetNorm && abbrNorm && abbrNorm === cardSetNorm) score += 100;
    for (const def of attrDefs) {
      if (cardHasAttr(card, def.key) === productHasAttr(p, def.key)) score += 60;
    }
    if (p.market_price != null && p.market_price > 0) score += 10;
    return { product: p, score, price: Number(p.market_price) || 0 };
  });
  scored.sort((a, b) => b.score - a.score || b.price - a.price);
  return scored[0]?.product || null;
};

// Returns a TCGPlayer product ONLY when the match is unambiguous — i.e.
// exactly one candidate agrees with the card on the source set AND every
// printing attribute in the registry. Returns null when ambiguous so the
// caller knows to stop and ask the user. This is the bar for auto-resolve.
export const confidentMatchForCard = (card, products) => {
  if (!card || !Array.isArray(products) || products.length === 0) return null;
  if (products.length === 1) return products[0];
  const cardSetNorm = (card.setId || '').replace(/-/g, '').toUpperCase();
  const attrDefs = getPrintingAttributes();
  const exact = products.filter(p => {
    const abbrNorm = (p.group_abbreviation || '').replace(/-/g, '').toUpperCase();
    if (!cardSetNorm || !abbrNorm || abbrNorm !== cardSetNorm) return false;
    for (const def of attrDefs) {
      if (cardHasAttr(card, def.key) !== productHasAttr(p, def.key)) return false;
    }
    return true;
  });
  return exact.length === 1 ? exact[0] : null;
};

// Resolve a card by searching TCGCSV and picking the best match (set +
// parallel flag aware). Persists the result via saveResolution so future
// reads hit the cache. Returns the picked product or null. No-op if the
// card already has a resolution.
export const autoResolveCard = async (card) => {
  if (!card) return null;
  const cid = card.canonicalId || card.id;
  if (!cid) return null;
  // Wait for shared-mode Supabase resolutions to load before treating this
  // card as unresolved — otherwise every page refresh re-resolves cards that
  // are already saved (see the resolutionsReady gate above).
  await whenResolutionsReady();
  // Already resolved? Don't waste a network round-trip.
  if (getTcgId(cid, card.id)) {
    const existing = getResolution(cid);
    if (existing) return existing;
  }
  const number = cardNumberFromCanonical(cid) || card.displayId;
  if (!number) return null;
  const products = await searchTcgProducts(number);
  const pick = pickBestMatchForCard(card, products);
  if (!pick) return null;
  saveResolution(cid, pick);
  return pick;
};

// Persist the user's chosen TCGPlayer product for a card. Writes to the
// local resolution cache (synchronous), then fire-and-forget syncs to
// shared mode's card_resolutions table. The price snapshot is also written
// to the price cache so the UI shows it instantly without an extra fetch.
export const saveResolution = (cardId, productSummary, { confirmed = false } = {}) => {
  if (!cardId || !productSummary?.tcg_id) return;
  const tcgId = Number(productSummary.tcg_id);
  const summary = {
    tcg_id: tcgId,
    group_id: productSummary.group_id,
    group_abbreviation: productSummary.group_abbreviation || '',
    group_name: productSummary.group_name || '',
    name: productSummary.name || '',
    clean_name: productSummary.clean_name || '',
    image_url: productSummary.image_url || '',
    tcgplayer_url: productSummary.tcgplayer_url || '',
    rarity: productSummary.rarity || '',
    is_parallel: Boolean(productSummary.is_parallel),
    // Generic attributes — derived from the product name via the printing-
    // attribute registry. Stored on the snapshot so diagnose calls don't need
    // to re-derive on every read.
    attributes: Array.isArray(productSummary.attributes)
      ? [...productSummary.attributes]
      : detectPrintingAttributes(productSummary.name),
    // Set when a human explicitly picked this printing (manual Save in the
    // resolver). Confirmed picks are exempt from the Issues queue — the
    // attribute checks are heuristics, and the user is the authority.
    confirmed: Boolean(confirmed),
    saved_at: Date.now(),
  };
  // Map write is the durable in-session record and never fails on quota.
  ensureResolutionMap().set(cardId, summary);
  scheduleResolutionPersist();

  // Also seed the price cache so UI doesn't need to wait for a re-fetch.
  if (productSummary.market_price != null) {
    try {
      const raw = localStorage.getItem(PRICE_CACHE_KEY);
      const cache = raw ? JSON.parse(raw) : {};
      cache[String(tcgId)] = {
        tcg_id: tcgId,
        group_id: productSummary.group_id,
        market_price: productSummary.market_price,
        low_price: productSummary.low_price ?? null,
        mid_price: productSummary.mid_price ?? null,
        high_price: productSummary.high_price ?? null,
        sub_type_name: productSummary.sub_type_name || null,
        fetched_at: new Date().toISOString(),
        cached_at: Date.now(),
      };
      localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(cache));
    } catch {}
  }
  emit(tcgId);

  // Shared-mode sync. Reuses the existing card_resolutions table — its
  // tcg_id column carries the canonical → productId mapping; the snapshot
  // jsonb stores the product summary so other devices skip the search.
  if (MODE === 'shared') {
    store.upsertResolution(cardId, {
      tcg_id: String(tcgId),
      snapshot: summary,
    }).then((ok) => { if (ok === false) warnResolutionPersistFailed(); })
      .catch(() => warnResolutionPersistFailed());
  }
};

// In shared mode the card_resolutions upsert is the durable store. If it fails
// (almost always a schema problem on the remote table), resolutions silently
// vanish on refresh and bulk "Auto-resolve all" re-runs every load. Surface a
// single, actionable error rather than 3602 generic ones during a bulk pass.
let warnedResolutionPersist = false;
const warnResolutionPersistFailed = () => {
  if (warnedResolutionPersist) return;
  warnedResolutionPersist = true;
  console.error(
    '[resolutions] Supabase upsert to `card_resolutions` failed — your resolutions ' +
    'will NOT persist across refreshes. Most likely the remote table is missing the ' +
    '`snapshot` jsonb column or the `unique (vault_key, card_id)` constraint that the ' +
    'upsert needs for onConflict. See the schema SQL in src/storage.js.'
  );
};

// Local-only flag store for cards whose resolution looks wrong. Used by the
// Resolve view to surface a "Reported" queue and as a hint that the user
// wants to re-check this card. Shape: `{ [cardId]: { note, reported_at,
// pick_at_report } }` where pick_at_report is a snapshot of the resolution
// the user was reporting (so we can show "you flagged this when it pointed
// at <name>").
const MATCH_REPORTS_KEY = 'optcg:match-reports:v1';

const readReports = () => {
  try {
    const raw = localStorage.getItem(MATCH_REPORTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
};
const writeReports = (reports) => {
  try { localStorage.setItem(MATCH_REPORTS_KEY, JSON.stringify(reports)); } catch {}
};

// Pub/sub for match-report writes. The detail drawer can be opened on top of
// the Resolve view (or anywhere else), so a report there needs to nudge any
// view that derives its UI from `getMatchReport` — otherwise ResolveView's
// counts/queue stay stale until the user touches a local control.
const reportListeners = new Set();
export const onMatchReportChanged = (cb) => {
  reportListeners.add(cb);
  return () => reportListeners.delete(cb);
};
const emitReportChanged = (cardId) => {
  for (const cb of reportListeners) { try { cb(cardId); } catch {} }
};

// Flag a card's current resolution as a bad match. `note` is an optional
// free-text hint the user types. Returns the saved report row.
export const reportBadMatch = (cardId, note = '') => {
  if (!cardId) return null;
  const reports = readReports();
  const pickAtReport = getResolution(cardId);
  const row = {
    note: (note || '').trim(),
    reported_at: new Date().toISOString(),
    pick_at_report: pickAtReport
      ? {
          tcg_id: pickAtReport.tcg_id,
          name: pickAtReport.name,
          is_parallel: pickAtReport.is_parallel,
        }
      : null,
  };
  reports[cardId] = row;
  writeReports(reports);
  emitReportChanged(cardId);
  return row;
};

// Sync read: returns the report row for a card, or null. Used by the
// Resolve view to render a "you flagged this" pill.
export const getMatchReport = (cardId) => {
  if (!cardId) return null;
  const reports = readReports();
  return reports[cardId] || null;
};

// All reports as `{ cardId, ...row }[]`. Used to populate the "Reported"
// queue in the Resolve view.
export const getAllMatchReports = () => {
  const reports = readReports();
  return Object.entries(reports).map(([cardId, row]) => ({ cardId, ...row }));
};

// Clear a card's report (typically called after the user re-resolves it).
export const clearMatchReport = (cardId) => {
  if (!cardId) return;
  const reports = readReports();
  if (reports[cardId]) {
    delete reports[cardId];
    writeReports(reports);
    emitReportChanged(cardId);
  }
};

// Diagnose a resolution: does the picked product agree with the catalog card
// on the source set and on every printing attribute? Returns an object the
// Resolve view uses to surface issues. Pure read.
//
// `attributeMatches` is a generic `{key, label, ok}[]` array driven by the
// printing-attribute registry, so the Resolve UI can render per-attribute
// match rows without knowing which attributes exist.
export const diagnoseResolution = (card, resolution) => {
  if (!card || !resolution || !resolution.tcg_id) {
    return { resolved: false, issues: [], setMatch: null, attributeMatches: [] };
  }
  const cardSetNorm = (card.setId || '').replace(/-/g, '').toUpperCase();
  const productSetNorm = (resolution.group_abbreviation || '')
    .replace(/-/g, '')
    .toUpperCase();
  const setMatch = cardSetNorm && productSetNorm
    ? cardSetNorm === productSetNorm
    : null; // null = can't compare (one side missing)

  // For each registered attribute, do card and product agree?
  // Resolution snapshots saved before the refactor lack `attributes`, so
  // re-derive from the saved name if needed to keep diagnosis consistent.
  const resolutionView = Array.isArray(resolution.attributes)
    ? resolution
    : { ...resolution, attributes: detectPrintingAttributes(resolution.name) };
  const attributeMatches = getPrintingAttributes().map(def => ({
    key: def.key,
    label: def.label,
    ok: cardHasAttr(card, def.key) === productHasAttr(resolutionView, def.key),
  }));

  const issues = [];
  if (setMatch === false) issues.push('set');
  for (const m of attributeMatches) if (!m.ok) issues.push(m.key);

  // A missing price is a TCGCSV data gap (no recent sales, or just not fetched
  // yet), NOT a bad match — surfaced via `hasPrice` for display but does NOT
  // count as an issue. Otherwise a correctly-matched card with no price
  // would be stuck in the Issues queue forever.
  const snap = getCachedSnapshot(resolution.tcg_id);
  const hasPrice = snap && Number(snap.market_price) > 0;
  return { resolved: true, issues, setMatch, attributeMatches, hasPrice };
};

// Forget a resolution (lets the user redo the picker). Only touches the
// local cache; shared mode keeps the row until next resolution overwrites.
export const clearResolution = (cardId) => {
  if (!cardId) return;
  const map = ensureResolutionMap();
  if (map.delete(cardId)) scheduleResolutionPersist();
};

// Wipe every saved resolution — in-memory Map, localStorage warm-start cache,
// and (in shared mode) the Supabase `card_resolutions` rows for this vault.
// Used by the one-time cleanup migration after switching the catalog source
// to TCGPlayer; the resolution layer is no longer the source of truth for
// image / link / price (the catalog card is), so legacy resolutions whose
// snapshots point at different TCGPlayer products than the catalog (e.g. SP
// Gold's image when the catalog links to SP Silver) cause display drift.
export const clearAllResolutions = async () => {
  // In-memory map.
  const map = ensureResolutionMap();
  const had = map.size;
  map.clear();
  // localStorage cache.
  try { localStorage.removeItem(RESOLUTION_CACHE_KEY); } catch {}
  // Supabase rows in shared mode.
  let remoteDeleted = 0;
  if (MODE === 'shared') {
    try { remoteDeleted = await store.deleteAllResolutions(); }
    catch (e) { console.warn('[resolutions] remote delete failed', e); }
  }
  return { localCleared: had, remoteDeleted };
};

// Pull every shared-mode resolution row into the local cache. Run once on
// app boot when MODE === 'shared'; in solo mode this is a no-op (returns 0).
export const hydrateResolutionsFromShared = async () => {
  if (MODE !== 'shared') return 0;
  // Always open the readiness gate when we finish (success, empty, or error)
  // so autoResolveCard never hangs waiting on a load that failed.
  try {
    let rows;
    try { rows = await store.listResolutions(); } catch { lastHydratedCount = 0; return 0; }
    if (!rows || rows.length === 0) { lastHydratedCount = 0; return 0; }
    const map = ensureResolutionMap();
    let writes = 0;
    for (const row of rows) {
      if (!row.card_id || !row.tcg_id) continue;
      const tcgId = Number(row.tcg_id);
      if (!Number.isFinite(tcgId) || tcgId <= 0) continue;
      map.set(row.card_id, {
        ...(row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {}),
        tcg_id: tcgId,
        saved_at: map.get(row.card_id)?.saved_at || Date.now(),
      });
      writes++;
    }
    lastHydratedCount = writes;
    scheduleResolutionPersist();
    // Don't emit on initial hydrate — listeners haven't subscribed yet and a
    // batch of bumps would be wasted. Future remote updates are pushed via
    // subscribeToSharedResolutions.
    return writes;
  } finally {
    markResolutionsReady?.();
  }
};

// Subscribe to real-time updates from teammates' resolutions. Returns an
// unsubscribe function. Solo mode is a no-op (returns no-op unsub).
export const subscribeToSharedResolutions = () => {
  if (MODE !== 'shared') return () => {};
  return store.subscribeResolutions((payload) => {
    const row = payload?.new || payload?.record;
    if (!row || !row.card_id || !row.tcg_id) return;
    const tcgId = Number(row.tcg_id);
    if (!Number.isFinite(tcgId) || tcgId <= 0) return;
    ensureResolutionMap().set(row.card_id, {
      ...(row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {}),
      tcg_id: tcgId,
      saved_at: Date.now(),
    });
    scheduleResolutionPersist();
    emit(tcgId);
  });
};
