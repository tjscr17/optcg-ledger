// ============================================================================
// Card catalog — Supabase `cards` table as the single source of truth.
//
// Switched 2026-06-22 from the TCGPlayer/TCGCSV-sourced catalog to the
// rebuilt relational catalog in the `ajpxzfhmyzzgarewijnr` Supabase project.
// Each catalog card now IS a row in public.cards (one row per printing),
// joined to public.sets for set name/code. Identity is the cards.id UUID —
// not the old TCGPlayer canonical-string scheme.
//
// What changed vs the TCGCSV era:
//   + Clean official data: canonical card_code (OP01-039), explicit
//     variant_key (base/p1/p2/r1...), real name/rarity/category, and a
//     working image_url on every printing.
//   + Identity is a stable UUID (card.id), shared with collected_cards.card_id
//     in the same DB — no string-canonical derivation.
//   − No pricing yet. The TCGCSV price feed is dropped; market/low/mid/high
//     are 0 until a new price source is wired (planned: self-tracked price
//     snapshots in the new DB). pricing.js reads stay graceful at 0.
//   − Attributes are no longer regex-detected from a sales name; the printing
//     is identified by variant_key directly.
//
// Loads all EN printings (source='bandai-official') once, 24h-cached in
// localStorage. ~4.5k rows, paginated 1000 at a time (PostgREST row cap).
// ============================================================================

import { createClient } from '@supabase/supabase-js';

// Dedicated read-only client for the public catalog (cards/sets carry no
// vault_key, so this must NOT go through storage.js's vault-scoped client).
// Falls back to the project's public anon key so the catalog works even in
// solo mode (no VITE_SUPABASE_* set); the anon key is bundle-safe by design.
const CATALOG_URL = import.meta.env.VITE_SUPABASE_URL || 'https://ajpxzfhmyzzgarewijnr.supabase.co';
const CATALOG_KEY = import.meta.env.VITE_SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqcHh6ZmhteXp6Z2FyZXdpam5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTM3MjQsImV4cCI6MjA5NDcyOTcyNH0.YQ4V0pxw1tpOiVe_d9nxL0UqbHR-eFPTjiybpd2O28o';
const catalogClient = createClient(CATALOG_URL, CATALOG_KEY);

const CACHE_KEY = 'optcg:catalog:v12-supabase'; // bump invalidates old TCGCSV cache
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const LANGUAGE = 'EN'; // catalog is EN-West for now; other langs exist in DB
const PAGE = 1000; // PostgREST default max rows per request

const normSetToken = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Supabase cards row (joined to sets) → catalog card object. Keeps the field
// names the rest of the app already reads (displayId, setId, imageUrl, …) so
// consumers don't change; identity moves to the UUID `id`/`canonicalId`.
const normalize = (row) => {
  const set = row.sets || {};
  const variant = row.variant_key || 'base';
  const isBase = variant === 'base';
  const card = {
    id: row.id,                       // UUID — the identity
    canonicalId: row.id,              // identity used as stored card_id
    displayId: row.card_code || '',   // official number, e.g. OP01-039
    variantKey: variant,              // base / p1 / p2 / r1 ...
    name: row.name || '',
    fullName: isBase ? (row.name || '') : `${row.name || ''} (${variant})`,
    cleanName: row.name || '',
    setId: set.set_code || '',
    setName: set.name || '',
    setAbbreviation: set.set_code || '',
    rarity: row.rarity || '',
    category: row.category || '',
    imageUrl: row.image_url || '',
    tcgplayerUrl: '',
    // Pricing deferred — no source yet. Kept as 0 so price reads stay graceful.
    tcg_id: 0,
    marketPrice: 0, lowPrice: 0, midPrice: 0, highPrice: 0,
    // Attributes now come from variant_key, not name regex.
    attributes: isBase ? [] : [variant],
    source: row.source || 'bandai-official',
  };
  card.isParallel = /^p\d+$/.test(variant);
  card.isManga = false; // not distinguishable from variant_key alone (treatment map TBD)
  return card;
};

// Sort bucket: lower = earlier in the Search view's set groups.
const bucketOfSet = (setId) => {
  if (!setId) return 9;
  const norm = normSetToken(setId);
  if (/^OP\d+(RE|ANN)$/.test(norm)) return 2;
  if (/^OP\d+$/.test(norm)) return 1;
  if (/^EB\d*$/.test(norm) || /^PRB\d*$/.test(norm)) return 3;
  if (/^ST/.test(norm)) return 4;
  if (/^OPPR$/.test(norm) || /^P$/.test(norm) || /PROMO/.test(norm)) return 5;
  if (/^OPOT$/.test(norm)) return 6;
  return 9;
};

const numericPart = (setId) => parseInt(((setId || '').match(/(\d+)/) || [])[1] || '0', 10);

export const compareSets = (a, b) => {
  const ab = bucketOfSet(a.setId);
  const bb = bucketOfSet(b.setId);
  if (ab !== bb) return ab - bb;
  if (ab === 1 || ab === 2 || ab === 4) return numericPart(a.setId) - numericPart(b.setId);
  return (a.setId || '').localeCompare(b.setId || '');
};

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

// ---------------------------------------------------------------------------
// Loader + cache
// ---------------------------------------------------------------------------

const readCachedCatalog = () => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
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

// Page through every EN bandai-official printing (PostgREST caps a single
// request at ~1000 rows, so we range-paginate until a short page returns).
const fetchAllCards = async () => {
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await catalogClient
      .from('cards')
      .select('id,card_code,variant_key,name,rarity,category,image_url,sets!inner(set_code,name,language)')
      .eq('source', 'bandai-official')
      .eq('sets.language', LANGUAGE)
      .order('card_code', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`catalog query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
};

const revalidateCatalog = async () => {
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    const rows = await fetchAllCards();
    const cards = rows.map(normalize).filter(c => c.id && c.displayId);
    const final = cards.sort((a, b) => {
      if (a.setId !== b.setId) return compareSets(a, b);
      return (a.displayId || '').localeCompare(b.displayId || '');
    });
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), cards: final }));
    } catch {
      // localStorage full — store a slim shape (drop the few non-essential fields).
      const slim = final.map(c => ({
        id: c.id, canonicalId: c.canonicalId, displayId: c.displayId, variantKey: c.variantKey,
        name: c.name, fullName: c.fullName, cleanName: c.cleanName,
        setId: c.setId, setName: c.setName, setAbbreviation: c.setAbbreviation,
        rarity: c.rarity, category: c.category, imageUrl: c.imageUrl,
        tcg_id: 0, attributes: c.attributes, isParallel: c.isParallel, isManga: c.isManga,
        source: c.source,
      }));
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), cards: slim })); } catch {}
    }
    return final;
  })().finally(() => { catalogPromise = null; });
  return catalogPromise;
};

// ---------------------------------------------------------------------------
// Pre-errata twins. User marks a card as having a pre-errata printing; the
// catalog then exposes both versions as separate entries so they can be logged
// independently. Persisted in localStorage; survives catalog cache bumps.
// (Identity for the twin is the base UUID suffixed with __pre-errata.)
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
    twins.push({
      ...c,
      id: `${c.id}${ERRATA_SUFFIX}`,
      canonicalId: `${c.id}${ERRATA_SUFFIX}`,
      variant: 'Pre-errata',
      variantTag: 'pre-errata',
    });
  }
  return twins.length > 0 ? [...catalog, ...twins] : catalog;
};
