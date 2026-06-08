// ============================================================================
// Sale-to-card matcher — given a listing title, figure out which canonical
// card it's most likely referring to. Used in two places:
//   1. CardDetailDrawer's recent-sales panel: shows each sale with the
//      correctly-detected variant label, regardless of what the scraper
//      stored at scrape time.
//   2. estimateGradedPrice: filters candidate sales to only those whose
//      title points at the same canonical id as the entry being priced.
//
// Three signals, applied in order:
//   1. Card-ID regex — `OP01-016`, `EB02-061`, `OP01-SP01`, etc. The first
//      hit determines the displayId; further hits make the title a bundle
//      and we drop the sale entirely.
//   2. Card aliases — user-registered nicknames tied to specific canonical
//      ids (`"Dodgers Luffy"` → `EB02-010-dodgers`). The longest matching
//      alias wins. Aliases override card-ID regex when both fire — users
//      add an alias because the regex isn't picking the right card.
//   3. Variant detection — runs every printing-attribute's saleValue regex
//      against the title to identify which variants apply, then combines
//      with the displayId to produce the canonical id with the sorted
//      attribute suffix (matching the catalog's canonicalIdOf convention).
//
// Returns null when nothing identifies the card.
// ============================================================================

import { detectPrintingAttributesFromTitle } from './printing-attributes.js';
import { allAliases } from './card-aliases.js';

const CARD_ID_RE = /\b(?:OP|EB|ST|PRB)\d{2}-[A-Z]?\d{2,3}[A-Z]?\b/gi;

// Extract the displayId portion of any canonical card_id, mirroring the
// helper in App.jsx — duplicated here so this module stays self-contained.
//   OP01-016                       → OP01-016
//   OP01-016-parallel              → OP01-016
//   OP14RE:OP14-118                → OP14-118
//   OP01-016__pre-errata           → OP01-016 (legacy double-underscore)
//   OP01-016-pre-errata            → OP01-016 (current single-hyphen)
function displayIdOf(canonicalCardId) {
  if (!canonicalCardId) return null;
  // Normalize legacy `__pre-errata` to current `-pre-errata` first so the
  // displayId extractor and any caller comparing variants line up across
  // forms.
  let s = String(canonicalCardId).replace(/__pre-errata$/, '-pre-errata');
  const colonIdx = s.indexOf(':');
  if (colonIdx > -1) s = s.slice(colonIdx + 1);
  const m = s.match(/^([A-Z]{2,4}\d{2}-[A-Z]?\d{2,3}[A-Z]?)/i);
  return m ? m[1].toUpperCase() : null;
}

// Extract every card-ID found in a title, deduped, preserving order.
function cardIdsFromTitle(title) {
  if (!title) return [];
  const seen = new Set();
  const ids = [];
  CARD_ID_RE.lastIndex = 0;
  let m;
  while ((m = CARD_ID_RE.exec(title)) !== null) {
    const id = m[0].toUpperCase();
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

// Find the best-matching alias whose words are ALL present in the title
// (any order). Returns `{ alias, card_id }` or null. Word-based instead of
// substring so:
//   alias "Dodgers Luffy" matches:
//     ✓ "Dodgers Luffy PSA 10"
//     ✓ "LA Dodgers Luffy"
//     ✓ "Monkey D Luffy Dodgers Promo"
//     ✗ "Dodgers Pizza"   (missing "luffy")
//     ✗ "Luffy Manga"     (missing "dodgers")
// Tie-break: alias with more total word-character length wins, so a more
// specific "LA Dodgers Luffy" (15 word-chars) beats "Dodgers Luffy" (12).
function bestAliasMatch(title) {
  if (!title) return null;
  const titleTokens = new Set((String(title).toLowerCase().match(/[a-z0-9]+/g) || []));
  let best = null;
  for (const { card_id, alias } of allAliases()) {
    const words = String(alias).toLowerCase().match(/[a-z0-9]+/g) || [];
    if (words.length === 0) continue;
    // Safety net: a single-word alias must be ≥6 chars to win (avoids a
    // generic "luffy" or "zoro" matching the entire character's listings).
    if (words.length === 1 && words[0].length < 6) continue;
    const allPresent = words.every(w => titleTokens.has(w));
    if (!allPresent) continue;
    const score = words.reduce((acc, w) => acc + w.length, 0);
    if (!best || score > best.score) best = { card_id, alias, score };
  }
  return best;
}

// Build a canonical id with sorted variant suffix attached. Mirrors the
// catalog's canonicalIdOf convention (sorted, hyphen-joined attribute keys).
function joinCanonicalId(displayId, attributeKeys) {
  if (!displayId) return null;
  const sorted = [...new Set(attributeKeys)].sort();
  return sorted.length === 0 ? displayId : `${displayId}-${sorted.join('-')}`;
}

// Public — the matcher. Inputs:
//   title        : listing title text
//   sourceCardId : optional hint from the scraper's stored card_id. If
//                  provided and we can't confidently identify the card from
//                  the title, we fall back to its displayId.
// Returns:
//   { canonicalId, displayId, attributeKeys, source, isBundle }
//   source ∈ 'alias' | 'card-id' | 'fallback' | null
//   isBundle is true when the title contains 2+ distinct card IDs.
//   canonicalId is null when nothing identifies a card.
export function matchSaleToCard(title, sourceCardId = null) {
  const ids = cardIdsFromTitle(title);
  const isBundle = ids.length > 1;

  // Alias takes precedence over card-ID regex when both fire. Users add
  // aliases precisely because the regex is picking the wrong card for a
  // particular printing, so respect that intent.
  const alias = bestAliasMatch(title);
  if (alias) {
    const baseDisplayId = displayIdOf(alias.card_id);
    if (baseDisplayId) {
      // The aliased card already carries its own variant in its canonical
      // id (e.g. `EB02-010-dodgers`). The title MAY also mention extra
      // variants ("Dodgers MANGA Luffy"); union those so the matcher
      // correctly bucks the Dodgers-manga-parallel etc. printings.
      const aliasVariants = (() => {
        const tail = String(alias.card_id).split(':').pop().slice(baseDisplayId.length);
        return tail.startsWith('-') ? tail.slice(1).split('-').filter(Boolean) : [];
      })();
      const titleVariants = detectPrintingAttributesFromTitle(title);
      const attributeKeys = [...new Set([...aliasVariants, ...titleVariants])];
      return {
        canonicalId: joinCanonicalId(baseDisplayId, attributeKeys),
        displayId: baseDisplayId,
        attributeKeys,
        source: 'alias',
        isBundle,
      };
    }
  }

  if (isBundle) {
    return { canonicalId: null, displayId: null, attributeKeys: [], source: null, isBundle: true };
  }

  if (ids.length === 1) {
    const displayId = ids[0];
    let attributeKeys = detectPrintingAttributesFromTitle(title);
    // Pre-errata wins over other tags — mirrors catalog.js canonicalIdOf,
    // where the pre-errata twin is mutually exclusive with parallel/manga
    // tags. A title saying "Pre-Errata Parallel" is bucketed as
    // pre-errata, not parallel-pre-errata (which the catalog wouldn't
    // have).
    if (attributeKeys.includes('pre-errata')) attributeKeys = ['pre-errata'];
    return {
      canonicalId: joinCanonicalId(displayId, attributeKeys),
      displayId,
      attributeKeys,
      source: 'card-id',
      isBundle: false,
    };
  }

  // No card-ID in title, no alias hit. Fall back to whatever the scraper
  // stored — better than dropping data, and the user can fix it via the
  // alias UI if they care to.
  if (sourceCardId) {
    const displayId = displayIdOf(sourceCardId);
    if (displayId) {
      const attributeKeys = detectPrintingAttributesFromTitle(title);
      return {
        canonicalId: joinCanonicalId(displayId, attributeKeys),
        displayId,
        attributeKeys,
        source: 'fallback',
        isBundle: false,
      };
    }
  }

  return { canonicalId: null, displayId: null, attributeKeys: [], source: null, isBundle: false };
}

// Public helper exposed so App.jsx can reuse it without redefining.
export { displayIdOf };
