// ============================================================================
// Per-card attribute overrides — the user's manual say in which printing
// attributes apply to a specific card, on top of (or instead of) what the
// regex-based detection in `printing-attributes.js` finds in the TCGPlayer
// product name.
//
// Use cases:
//   - TCGPlayer's name doesn't include "(Manga Rare)" but the user knows it
//     IS a manga rare → manually add `manga` to that card.
//   - Detection mistakenly added `parallel` to a card the user considers a
//     base print → manually remove `parallel`.
//
// Storage shape:
//   localStorage 'optcg:card-attribute-overrides:v1' →
//     { [canonicalCardId]: { add: ['manga'], remove: ['parallel'] } }
//
// Effective attributes = (detected − remove) ∪ add. Differential, so the
// override survives detection-rule changes — adding 'manga' stays meaningful
// even if a future variant rule starts detecting manga from the name.
//
// Canonical IDs are computed from *detected* attributes only (see catalog.js
// normalize()), so overrides don't shift identities and break references in
// existing entries / transactions / watchlist rows.
// ============================================================================

const STORAGE_KEY = 'optcg:card-attribute-overrides:v1';

let cache = null;
const load = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
};
const save = (o) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); } catch {}
};
const ensure = () => (cache ?? (cache = load()));

// Pub/sub so views re-render when an override changes.
const listeners = new Set();
export const onCardAttributeOverridesChanged = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const emit = (cardId) => { for (const cb of listeners) { try { cb(cardId); } catch {} } };

// Read the raw override entry for a card (or null). `{ add: [...], remove: [...] }`.
export const getCardAttributeOverride = (cardId) => {
  if (!cardId) return null;
  return ensure()[cardId] || null;
};

// Apply the override to a base attribute list. Pure. Returns a new array.
export const applyAttributeOverride = (cardId, detected) => {
  if (!cardId) return Array.isArray(detected) ? detected : [];
  const o = ensure()[cardId];
  const base = new Set(Array.isArray(detected) ? detected : []);
  if (!o) return [...base];
  for (const r of (o.remove || [])) base.delete(r);
  for (const a of (o.add || [])) base.add(a);
  return [...base];
};

// Convenience: full effective attribute list for a card object. Falls back
// to card.attributes (which is the detected list) when there's no override.
export const effectiveAttributesOf = (card) => {
  if (!card) return [];
  const cid = card.canonicalId || card.id;
  return applyAttributeOverride(cid, card.attributes || []);
};

// Add an attribute manually (cancels a prior removal of the same key).
export const addAttributeToCard = (cardId, attrKey) => {
  if (!cardId || !attrKey) return;
  const o = ensure();
  const cur = o[cardId] || { add: [], remove: [] };
  cur.remove = (cur.remove || []).filter(k => k !== attrKey);
  if (!(cur.add || []).includes(attrKey)) cur.add = [...(cur.add || []), attrKey];
  if (cur.add.length === 0 && cur.remove.length === 0) delete o[cardId];
  else o[cardId] = cur;
  cache = o;
  save(o);
  emit(cardId);
};

// Remove an attribute. Works whether it came from detection or a prior add:
// removes from `add` if present, otherwise records a `remove` so future
// detection runs still don't surface it.
export const removeAttributeFromCard = (cardId, attrKey, detectedHasIt) => {
  if (!cardId || !attrKey) return;
  const o = ensure();
  const cur = o[cardId] || { add: [], remove: [] };
  cur.add = (cur.add || []).filter(k => k !== attrKey);
  if (detectedHasIt && !(cur.remove || []).includes(attrKey)) {
    cur.remove = [...(cur.remove || []), attrKey];
  }
  if ((cur.add || []).length === 0 && (cur.remove || []).length === 0) delete o[cardId];
  else o[cardId] = cur;
  cache = o;
  save(o);
  emit(cardId);
};

// Clear every override for a card.
export const clearCardAttributeOverride = (cardId) => {
  if (!cardId) return;
  const o = ensure();
  if (!o[cardId]) return;
  delete o[cardId];
  cache = o;
  save(o);
  emit(cardId);
};
