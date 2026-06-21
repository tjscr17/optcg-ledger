// ============================================================================
// Card aliases — user-defined nicknames the sale matcher can use to identify
// which card a listing title is referring to when the title has no parseable
// card-ID (e.g. "LA Dodgers Luffy 2025 Promo PSA 10" with no `OPnn-XXX`).
//
// Each alias is a free-text phrase tied to a specific canonical card_id. The
// matcher tokenizes both the alias and the title; an alias matches when every
// word in the alias appears in the title (any order). Tiebreaker among
// matching aliases is total word-character length, so more specific phrases
// win. Single-word aliases must be ≥6 chars to fire — a generic "Luffy"
// alias would otherwise match every Luffy listing in your dataset.
//
// Solo mode: localStorage keyed by `optcg:card-aliases:v1`, shape:
//   { [card_id]: string[] }
// Shared mode: Supabase `card_aliases(id, vault_key, card_id, alias)`, hydrated
// on first load and kept in sync via the realtime subscription.
//
// ⚠️  Aliases are vault-scoped — they're shared across users in the same
// vault. A friend with the vault key can add an alias that affects your
// matching, and vice versa. Treat like a wiki.
// ============================================================================

import { store } from './storage.js';

const STORAGE_KEY = 'optcg:card-aliases:v1';

// In-memory map: card_id → string[] of aliases. Hydrated from localStorage
// at boot. The matcher reads from this map for synchronous lookups.
const memo = new Map();

const loadLocal = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    if (obj && typeof obj === 'object') {
      memo.clear();
      for (const [cardId, list] of Object.entries(obj)) {
        if (Array.isArray(list)) memo.set(cardId, list.filter(s => typeof s === 'string' && s.trim()));
      }
    }
  } catch {}
};
loadLocal();

const persistLocal = () => {
  const obj = Object.fromEntries(memo);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch {}
};

const listeners = new Set();
export const onCardAliasesChanged = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const emit = () => { for (const cb of listeners) { try { cb(); } catch {} } };

// Public: read aliases for one card. Returns a fresh array so callers can't
// mutate the cache.
export const getAliasesForCard = (cardId) => {
  if (!cardId) return [];
  return (memo.get(cardId) || []).slice();
};

// Public: snapshot of every alias as [{card_id, alias}] pairs. Used by the
// sale matcher when iterating.
export const allAliases = () => {
  const out = [];
  for (const [cardId, aliases] of memo) {
    for (const a of aliases) out.push({ card_id: cardId, alias: a });
  }
  return out;
};

// Public: add an alias for a card. Idempotent — duplicates within a card
// are deduped. Returns { ok, error? }.
export const addCardAlias = async (cardId, alias) => {
  const norm = String(alias || '').trim();
  if (!cardId || !norm) return { ok: false, error: 'card id and alias required' };
  if (norm.length < 3) return { ok: false, error: 'alias must be at least 3 characters' };
  const current = memo.get(cardId) || [];
  if (current.some(a => a.toLowerCase() === norm.toLowerCase())) {
    return { ok: false, error: 'alias already exists for this card' };
  }
  const next = [...current, norm];
  memo.set(cardId, next);
  persistLocal();
  emit();
  // Best-effort shared-mode insert; ignore failures so the UI stays
  // responsive (next refresh will re-hydrate from the source of truth).
  try {
    await store.insert('card_nicknames', {
      id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      card_code: cardId,
      nickname: norm,
      created_at: new Date().toISOString(),
    });
  } catch {}
  return { ok: true };
};

// Public: remove an alias from a card.
export const removeCardAlias = async (cardId, alias) => {
  if (!cardId || !alias) return;
  const current = memo.get(cardId) || [];
  const next = current.filter(a => a.toLowerCase() !== String(alias).toLowerCase());
  if (next.length === current.length) return;
  if (next.length === 0) memo.delete(cardId);
  else memo.set(cardId, next);
  persistLocal();
  emit();
  // Shared-mode delete — match on (card_id, alias). We use removeWhere if the
  // store adapter supports it; otherwise the next hydrate cycle will
  // reconcile.
  try {
    if (typeof store.removeWhere === 'function') {
      await store.removeWhere('card_nicknames', (r) =>
        r.card_code === cardId && String(r.nickname).toLowerCase() === String(alias).toLowerCase()
      );
    }
  } catch {}
};

// Public: replace the in-memory cache with a snapshot from Supabase (shared
// mode). Called by App.refreshData when the card_aliases table loads.
export const hydrateFromShared = (rows) => {
  if (!Array.isArray(rows)) return;
  memo.clear();
  for (const row of rows) {
    if (!row?.card_id || !row?.alias) continue;
    const list = memo.get(row.card_id) || [];
    if (!list.some(a => a.toLowerCase() === row.alias.toLowerCase())) {
      list.push(row.alias);
    }
    memo.set(row.card_id, list);
  }
  persistLocal();
  emit();
};
