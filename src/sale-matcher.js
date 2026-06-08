// ============================================================================
// Sale-to-card matcher — given a listing title, figure out which canonical
// card it's most likely referring to. Called from App.jsx's matchedSales
// useMemo (so the drawer's recent-sales panel, SalesView, estimateGradedPrice,
// and reclassifyAllSales all consume one pre-computed result set).
//
// Signals, applied in order:
//   1. Card aliases — user-registered nicknames tied to specific canonical
//      ids (e.g. `"Dodgers Luffy"` → `EB02-010-dodgers`). Word-based: the
//      alias matches a title when every word in the alias is present as a
//      token (any order). Tiebreaker: alias with more total word-character
//      length wins. Aliases override card-ID regex when both fire because
//      users add aliases precisely to correct card-ID misidentification.
//   2. Card-ID regex — `OP01-016`, `EB02-061`, `OP01-SP01`, etc. The first
//      hit determines the displayId; 2+ distinct hits → bundle → drop.
//   3. Variant detection — every printing-attribute's saleValue regex against
//      the title, combined with the displayId into the catalog's canonicalId
//      convention (sorted attribute suffix).
//   4. Catalog-name disambiguation — when 1 + 2 leave us at base but the
//      catalog has multiple variant printings for that displayId, score
//      each variant's fullName tokens against the title and pick the best.
//
// Returns null when nothing identifies the card.
// ============================================================================

import { detectPrintingAttributesFromTitle } from './printing-attributes.js';
import { allAliases } from './card-aliases.js';

const CARD_ID_RE = /\b(?:OP|EB|ST|PRB)\d{2}-[A-Z]?\d{2,3}[A-Z]?\b/gi;

// Strip card-IDs out of text before tokenizing — they're an anchoring
// signal already handled by the card-ID layer and including them in the
// name-overlap score would dilute meaningful tokens like "Manga" / "Rare"
// / "Dodgers".
function tokensExcludingCardId(text) {
  if (!text) return new Set();
  const stripped = String(text)
    .toLowerCase()
    .replace(/\b(?:op|eb|st|prb)\d{2}-[a-z]?\d{2,3}[a-z]?\b/g, ' ');
  return new Set(stripped.match(/[a-z0-9]+/g) || []);
}

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
//   title             : listing title text
//   sourceCardId      : optional hint from the scraper's stored card_id.
//                       Used as a last-resort fallback when the title
//                       carries nothing identifying.
//   catalogByDisplayId: optional Map<displayId, card[]> for variant
//                       disambiguation by the catalog's fullName tokens
//                       (handles cases like 'Yamato Manga PSA 10
//                       OP05-003' where the keyword detector can't
//                       pick a variant but the catalog's
//                       "Yamato (Manga Rare)" fullName does).
// Returns:
//   { canonicalId, displayId, attributeKeys, source, isBundle }
//   source ∈ 'alias' | 'card-id' | 'card-id+name' | 'fallback' | null
//   isBundle is true when the title contains 2+ distinct card IDs.
//   canonicalId is null when nothing identifies a card.
export function matchSaleToCard(title, sourceCardId = null, catalogByDisplayId = null) {
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
    if (attributeKeys.includes('pre-errata')) attributeKeys = ['pre-errata'];
    let canonicalId = joinCanonicalId(displayId, attributeKeys);
    let source = 'card-id';

    // Catalog-name disambiguation. When the keyword detector didn't pick
    // any variant (we'd otherwise default to base) AND the catalog has
    // multiple variant printings for this displayId, score each variant
    // by how many of its fullName tokens appear in the title. Best wins,
    // but only when the evidence is meaningful (≥2 non-trivial tokens).
    //
    // Why "didn't pick any variant" gate: when a keyword does fire
    // ('Manga Rare', 'Parallel', 'Dodgers'), it's already chosen the
    // right variant; running name disambiguation could swap to a
    // worse pick on token-count alone. The name layer is for the cases
    // the keyword layer couldn't handle.
    if (attributeKeys.length === 0 && catalogByDisplayId) {
      const variants = catalogByDisplayId.get(displayId);
      if (Array.isArray(variants) && variants.length > 1) {
        const titleTokens = tokensExcludingCardId(title);
        let best = null;
        for (const v of variants) {
          const vTokens = tokensExcludingCardId(v.fullName || v.name || '');
          let score = 0;
          for (const t of vTokens) {
            if (t.length < 3) continue; // skip noise like 'a', 'd' (initials)
            if (titleTokens.has(t)) score += 1;
          }
          if (!best || score > best.score) best = { canonicalId: v.canonicalId, score };
        }
        if (best && best.canonicalId && best.score >= 2 && best.canonicalId !== canonicalId) {
          canonicalId = best.canonicalId;
          // attributeKeys stays empty — we no longer know the exact
          // attribute set; canonicalId came whole from the catalog.
          source = 'card-id+name';
        }
      }
    }

    return { canonicalId, displayId, attributeKeys, source, isBundle: false };
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
