// ============================================================================
// One-time client-side migrations. Runs on app boot, gated by versioned
// localStorage flags so each migration runs at most once per device.
//
// Why client-side: the catalog lives in the browser (loaded from OPTCGAPI),
// and translating an OPTCG card_id → canonical id requires the catalog. We
// could move this server-side later if a backend ingest exists, but for now
// the user's device walks their own rows and rewrites them in place.
// ============================================================================

import { store, MODE } from './storage.js';
import { loadCatalog, augmentWithErrata } from './catalog.js';
import { whenResolutionsReady, getResolution, saveResolution, clearResolution } from './pricing.js';

const CANONICAL_MIGRATION_KEY = 'optcg:canonical-migration:v1';
const TABLES = ['entries', 'transactions', 'watchlist', 'card_resolutions'];

// Stage 5 of the TCGCSV migration deleted src/grading.js — these keys are
// the localStorage caches it owned. Purge them once so a returning user
// reclaims the space and we don't carry orphaned data forever.
const LEGACY_PC_CACHE_KEYS = [
  'optcg:pc:products:v1',
  'optcg:pc:prices:v1',
  'optcg:pc:images:v1',
  'optcg:pc:variants:v1',
];
const LEGACY_PC_FILTER_KEYS = [
  'optcg:search:priceTier', // "Price as" tier dropdown removed in Stage 4
];
const PC_CLEANUP_KEY = 'optcg:pc-cleanup:v1';

// Build a Map<OPTCG-id, canonical-id> covering every printing the catalog
// currently knows about — including pre-errata twins (synthesized client-side
// by augmentWithErrata). Skip entries where the two are already identical so
// the migration loop has less to do.
const buildIdMap = (cards) => {
  const m = new Map();
  for (const c of cards) {
    if (!c?.id || !c?.canonicalId) continue;
    if (c.id !== c.canonicalId) m.set(c.id, c.canonicalId);
  }
  return m;
};

// Run the canonical-id migration. Idempotent — the flag in localStorage
// guarantees one execution per device. Returns the count of rows rewritten
// (0 if the migration was skipped or there was nothing to do).
export const runCanonicalMigration = async () => {
  if (localStorage.getItem(CANONICAL_MIGRATION_KEY)) return 0;

  let cards;
  try {
    const base = await loadCatalog();
    cards = augmentWithErrata(base);
  } catch (e) {
    console.warn('[canonical-migration] catalog load failed, postponing', e);
    return 0;
  }

  const idMap = buildIdMap(cards);
  if (idMap.size === 0) {
    // No printings need translation — flag and exit so we don't re-check.
    try { localStorage.setItem(CANONICAL_MIGRATION_KEY, new Date().toISOString()); } catch {}
    return 0;
  }

  let rewrites = 0;
  for (const table of TABLES) {
    let rows = [];
    try { rows = await store.list(table); } catch { rows = []; }
    for (const row of rows) {
      const fromId = row?.card_id;
      if (!fromId) continue;
      const canonical = idMap.get(fromId);
      if (!canonical || canonical === fromId) continue;
      try {
        await store.update(table, row.id, { card_id: canonical });
        rewrites++;
      } catch (e) {
        console.warn(`[canonical-migration] update failed for ${table}/${row.id}`, e);
      }
    }
  }

  try { localStorage.setItem(CANONICAL_MIGRATION_KEY, new Date().toISOString()); } catch {}
  if (rewrites > 0) {
    console.info(`[canonical-migration] rewrote ${rewrites} card_id values in ${MODE} mode`);
  }
  return rewrites;
};

// One-time cleanup of localStorage keys owned by the now-deleted PriceCharting
// client (Stage 5 of the TCGCSV migration). Before deleting the PC image
// cache, promote its `card_id → tcg_id` mappings into the TCGCSV resolution
// cache so solo-mode users keep their existing variant picks. Idempotent
// via the `optcg:pc-cleanup:v1` flag.
const RESOLUTION_CACHE_KEY = 'optcg:tcgcsv:resolutions:v1';
const PC_IMAGES_CACHE_KEY = 'optcg:pc:images:v1';

export const runPcCleanup = () => {
  if (localStorage.getItem(PC_CLEANUP_KEY)) return 0;

  // Step 1 — promote PC tcg_id mappings into the new resolution cache.
  // Only fill in for cards that don't already have a TCGCSV resolution; the
  // newer cache takes precedence when both exist.
  let promoted = 0;
  try {
    const pcRaw = localStorage.getItem(PC_IMAGES_CACHE_KEY);
    if (pcRaw) {
      const pc = JSON.parse(pcRaw) || {};
      const newRaw = localStorage.getItem(RESOLUTION_CACHE_KEY);
      const newCache = newRaw ? JSON.parse(newRaw) : {};
      for (const [cardId, tcgIdRaw] of Object.entries(pc)) {
        if (newCache[cardId]?.tcg_id) continue;
        const tcgId = Number(tcgIdRaw);
        if (!Number.isFinite(tcgId) || tcgId <= 0) continue;
        newCache[cardId] = { tcg_id: tcgId, saved_at: Date.now() };
        promoted++;
      }
      if (promoted > 0) localStorage.setItem(RESOLUTION_CACHE_KEY, JSON.stringify(newCache));
    }
  } catch {}

  // Step 2 — drop the legacy PC keys (image cache, product/price snapshots,
  // and the now-removed "Price as" tier filter).
  let removed = 0;
  for (const k of LEGACY_PC_CACHE_KEYS) {
    try { if (localStorage.getItem(k) != null) { localStorage.removeItem(k); removed++; } } catch {}
  }
  for (const k of LEGACY_PC_FILTER_KEYS) {
    try { if (localStorage.getItem(k) != null) { localStorage.removeItem(k); removed++; } } catch {}
  }
  try { localStorage.setItem(PC_CLEANUP_KEY, new Date().toISOString()); } catch {}
  if (promoted > 0 || removed > 0) {
    console.info(`[pc-cleanup] promoted ${promoted} tcg_id mappings, removed ${removed} legacy keys`);
  }
  return removed;
};

// ============================================================================
// TCGPlayer-source migration (2026-06-01)
//
// The catalog source switched from OPTCGAPI → TCGPlayer. Card identity changed
// from `OP14-118-p1` style (OPTCGAPI's `_p\d` image-index suffix) to
// attribute-tagged form (`OP14-118-parallel`, `OP14-118-manga-parallel`, etc.).
// Existing entries / transactions / watchlist / card_resolutions all reference
// the OLD canonicals — this migration rewrites them.
//
// Bridge: every resolution row carries the picked product's `tcg_id`, and the
// new catalog also keys by `tcg_id`. So for each resolution, look up the new
// catalog by tcg_id → get the new canonical → record an `old → new` mapping.
// Then walk every table and rewrite `card_id` using that mapping. For rows
// not covered by a resolution, fall back to a displayId + variant-tag
// heuristic (best-effort; rare cases get logged).
//
// Idempotent via `optcg:tcgplayer-migration:v1`.
// ============================================================================
const TCGPLAYER_MIGRATION_KEY = 'optcg:tcgplayer-migration:v1';

// Parse an old-style canonical id (OPTCGAPI era) into {sourceSet, displayId,
// variantTag} pieces. variantTag was one of: '' (base), `p\d+` (parallel
// index from `_p\d` image_id), 'pre-errata', or a slugified promo variant.
const parseLegacyCanonical = (canonical) => {
  if (!canonical) return null;
  let str = String(canonical);
  let sourceSet = '';
  if (str.includes(':')) { [sourceSet, str] = str.split(':', 2); }
  const m = str.match(/^([A-Z]+\d+-\d+)(?:-(.+))?$/i);
  if (!m) return { sourceSet, displayId: str, variantTag: '' };
  return { sourceSet, displayId: m[1], variantTag: m[2] || '' };
};

export const runTcgplayerMigration = async () => {
  if (localStorage.getItem(TCGPLAYER_MIGRATION_KEY)) return 0;

  let cards;
  try {
    const base = await loadCatalog();
    cards = augmentWithErrata(base);
  } catch (e) {
    console.warn('[tcgplayer-migration] catalog load failed, postponing', e);
    return 0;
  }
  if (!Array.isArray(cards) || cards.length === 0) return 0;

  // Wait for any shared-mode resolution hydration to land — the resolutions
  // are our high-confidence bridge from old canonicals → tcg_id → new canonical.
  await whenResolutionsReady();

  // Build new-catalog lookups.
  const byTcgId = new Map();
  const byDisplayId = new Map();
  for (const c of cards) {
    if (!c?.canonicalId) continue;
    if (c.tcg_id) byTcgId.set(Number(c.tcg_id), c);
    if (c.displayId) {
      const list = byDisplayId.get(c.displayId) || [];
      list.push(c);
      byDisplayId.set(c.displayId, list);
    }
  }

  // Build old → new mapping. High-confidence pass first (resolutions provide
  // tcg_ids); then handle leftover card_ids via displayId fallback.
  const oldToNew = new Map();
  let rows = [];
  try { rows = await store.list('card_resolutions'); } catch {}
  for (const r of rows) {
    const oldId = r?.card_id;
    const tcgId = Number(r?.tcg_id);
    if (!oldId || !tcgId) continue;
    const newCard = byTcgId.get(tcgId);
    if (!newCard) continue;
    if (newCard.canonicalId !== oldId) oldToNew.set(oldId, newCard.canonicalId);
  }

  // Displayid+variant fallback for everything else.
  const fallback = (oldId) => {
    if (!oldId) return null;
    if (oldToNew.has(oldId)) return oldToNew.get(oldId);
    const parsed = parseLegacyCanonical(oldId);
    if (!parsed) return null;
    const candidates = byDisplayId.get(parsed.displayId) || [];
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].canonicalId;
    // Multiple candidates — disambiguate by variantTag heuristics.
    if (!parsed.variantTag) {
      const base = candidates.find(c => (c.attributes || []).length === 0);
      if (base) return base.canonicalId;
    }
    if (/^p\d+$/i.test(parsed.variantTag)) {
      const parallels = candidates.filter(c => (c.attributes || []).includes('parallel'));
      if (parallels.length > 0) {
        const idx = Math.max(0, parseInt(parsed.variantTag.slice(1), 10) - 1);
        return (parallels[idx] || parallels[0]).canonicalId;
      }
    }
    if (parsed.variantTag === 'pre-errata') {
      const pre = candidates.find(c => c.variantTag === 'pre-errata');
      if (pre) return pre.canonicalId;
    }
    return null; // ambiguous — log as orphan
  };

  // Walk every table that stores a card_id and rewrite.
  let rewrites = 0;
  let orphans = 0;
  const orphanIds = new Set();
  const TABLES = ['entries', 'transactions', 'watchlist', 'card_resolutions'];
  for (const table of TABLES) {
    let tableRows = [];
    try { tableRows = await store.list(table); } catch { tableRows = []; }
    for (const row of tableRows) {
      const fromId = row?.card_id;
      if (!fromId) continue;
      const newId = fallback(fromId);
      if (!newId) {
        if (!orphanIds.has(fromId)) { orphanIds.add(fromId); orphans++; }
        continue;
      }
      if (newId === fromId) continue;
      try {
        await store.update(table, row.id, { card_id: newId });
        rewrites++;
      } catch (e) {
        console.warn(`[tcgplayer-migration] update failed for ${table}/${row.id}`, e);
      }
    }
  }

  // Sync the in-memory resolution map: move each affected resolution from
  // its old canonical key to the new one. The next page load will
  // re-hydrate from Supabase (shared mode) but the current session needs
  // the live update so resolved cards still look resolved.
  for (const [oldId, newId] of oldToNew.entries()) {
    const existing = getResolution(oldId);
    if (!existing) continue;
    // saveResolution writes under newId and also syncs to Supabase, but the
    // Supabase row was already rewritten above — we just need the in-memory
    // Map updated and the local price-cache seed.
    saveResolution(newId, { ...existing, tcg_id: existing.tcg_id });
    clearResolution(oldId);
  }

  try { localStorage.setItem(TCGPLAYER_MIGRATION_KEY, new Date().toISOString()); } catch {}
  if (rewrites > 0 || orphans > 0) {
    console.info(`[tcgplayer-migration] rewrote ${rewrites} card_id values in ${MODE} mode; ${orphans} orphan card_ids (logged below)`);
    if (orphans > 0) console.info('[tcgplayer-migration] orphans:', [...orphanIds]);
  }
  return rewrites;
};
