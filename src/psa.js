// ============================================================================
// PSA Public API client — cert lookup by cert number.
//
// Auth: 40-char Bearer token. Sign up at https://www.psacard.com/publicapi
// then set VITE_PSA_TOKEN in .env.local (and in Vercel project env vars for
// deployed builds).
//
// PSA's public API does not allow direct browser CORS requests, so all calls
// route through /api/psa — a Vercel serverless function in production, and a
// Vite dev middleware locally (both defined alongside this file). The token
// is read server-side and never sent from the browser; VITE_PSA_TOKEN here is
// only used as a feature-enabled flag in the UI.
// ============================================================================

const TOKEN = import.meta.env.VITE_PSA_TOKEN;

export const hasPsaToken = () => Boolean(TOKEN);

// Parse PSA grade strings ("GEM MT 10", "MINT 9", "EX-MT 6", "Authentic"…)
// into a numeric grade we can store on the entry. Returns null if no numeric
// grade could be extracted (e.g. PSA "Authentic" or unparseable).
const parseGrade = (s) => {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
};

// Fetch PSA Auction Prices Realized for a spec id, optionally filtered to a
// specific grade. Returns a suggestion object with the median price, sample
// count, and a small slice of recent sales for display. Returns null on
// network failure (the modal degrades to a manual entry path).
//
// Response shape mirrors what `/api/psa-apr` returns.
export const fetchAuctionPrices = async ({ specId, grade, days = 180 } = {}) => {
  if (!specId) return null;
  const qs = new URLSearchParams({ spec: String(specId), days: String(days) });
  if (grade != null) qs.set('grade', String(grade));
  try {
    const r = await fetch(`/api/psa-apr?${qs.toString()}`);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('[psa-apr] fetch failed', e);
    return null;
  }
};

// Fetch a PSA cert by its cert number. Returns a normalized object on
// success or null if the cert isn't found. Throws on auth/network errors.
// Routes through /api/psa to dodge PSA's CORS block on browser callers.
export const fetchCert = async (certNumber) => {
  if (!TOKEN) throw new Error('PSA token missing — set VITE_PSA_TOKEN in .env.local');
  const url = `/api/psa?cert=${encodeURIComponent(String(certNumber).trim())}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch {}
    throw new Error(`PSA proxy returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const json = await res.json();
  const cert = json?.PSACert;
  if (!cert) return null;

  return {
    cert_number: String(cert.CertNumber || certNumber),
    grading_company: 'PSA',
    grade: parseGrade(cert.GradeDescription || cert.CardGrade),
    grade_description: cert.GradeDescription || cert.CardGrade || '',
    subject: cert.Subject || '',
    category: cert.Category || '',
    year: cert.Year || '',
    brand: cert.Brand || '',
    // PSA stores the card number in either field depending on category.
    card_number: cert.CardNumber || cert.VarietyPedigree || '',
    spec_id: cert.SpecID || null,
    raw: cert,
  };
};

// OPTCG card IDs follow patterns like OP01-016, ST21-005, EB-01-008,
// OP14-EB04-022, etc. Pull any of those out of an arbitrary string.
const OPTCG_ID_RE = /\b(OP|ST|EB|PRB)\s*[- ]?\s*(\d{1,2})\s*[- ]?\s*(\d{2,3})(?:\s*[- ]?\s*(EB\d{1,2}))?\s*[- ]?\s*(\d{2,3})?\b/gi;
const extractOptcgIds = (s) => {
  if (!s) return [];
  const ids = [];
  const text = String(s).toUpperCase();
  let m;
  OPTCG_ID_RE.lastIndex = 0;
  while ((m = OPTCG_ID_RE.exec(text)) !== null) {
    const [, prefix, setNum, n1, ebPart, n2] = m;
    if (ebPart && n2) {
      ids.push(`${prefix}${setNum.padStart(2, '0')}-${ebPart}-${n2.padStart(3, '0')}`);
    } else {
      // Try both with and without leading zeros, separator variations
      const set = `${prefix}${setNum.padStart(2, '0')}`;
      const num = n1.padStart(3, '0');
      ids.push(`${set}-${num}`);
      ids.push(`${prefix}-${setNum.padStart(2, '0')}-${num}`);
    }
  }
  return ids;
};

// Set-prefix only: PSA's Brand often reads "ONE PIECE OP11-A FIST OF DIVINE
// SPEED" — the set is OP11 but it's followed by "-A" instead of a card number,
// so the full-ID regex above misses it. We pair these with PSA's CardNumber
// digits to reconstruct full ids.
const SET_PREFIX_RE = /\b(OP|ST|EB|PRB)\s*[- ]?\s*(\d{1,2})\b/gi;
const extractSetIds = (s) => {
  if (!s) return [];
  const sets = [];
  const text = String(s).toUpperCase();
  let m;
  SET_PREFIX_RE.lastIndex = 0;
  while ((m = SET_PREFIX_RE.exec(text)) !== null) {
    const [, prefix, setNum] = m;
    sets.push(`${prefix}${setNum.padStart(2, '0')}`);
  }
  return sets;
};

// Tokenize a name/subject for comparison. Lowercases, strips punctuation,
// drops single-character noise and the few stopwords that show up in card
// names. PSA's "MONKEY D. LUFFY" and our "Monkey D. Luffy" both reduce to
// `["monkey", "luffy"]` after the single-char filter, which is fine.
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of', 'in']);
const tokenize = (s) => (s || '')
  .toString().toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter(t => t.length > 1 && !STOPWORDS.has(t));

// True if every significant subject token appears in the card name's tokens.
// Catches "Monkey D. Luffy" matching "Monkey D. Luffy (Manga Rare)" and
// "ZORO" matching "Roronoa Zoro" but not random partial overlaps. Tries the
// cleaned game-style name first; falls back to the sales-formatted full name
// (which has the "(Parallel)/(Manga Rare)/(Alternate Art)" suffixes) so a
// PSA subject like "MONKEY D. LUFFY ALTERNATE ART" still hits.
const nameMatchesSubject = (cardName, subject, fullName) => {
  const subjTokens = tokenize(subject);
  if (subjTokens.length === 0) return false;
  const nameTokens = new Set(tokenize(cardName));
  if (subjTokens.every(t => nameTokens.has(t))) return true;
  if (fullName && fullName !== cardName) {
    const fullTokens = new Set(tokenize(fullName));
    return subjTokens.every(t => fullTokens.has(t));
  }
  return false;
};

const CANDIDATE_CAP = 25;

// Returns true if a catalog card belongs to one of the PSA-derived setIds.
// Normalizes by stripping non-alphanumeric so TCGPlayer abbreviations like
// "OP14", "OP14 RE", "ST-29" all reduce to comparable tokens ("OP14",
// "OP14RE", "ST29"). A PSA "OP14" hits both the base OP14 group and the
// OP14 RE release-event group, ranking the base print first (event-stamped
// printings are usually a deliberate manual pick).
const cardInAnySet = (card, setIds) => {
  if (setIds.size === 0) return false;
  const setNorm = (card.setId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (setNorm && setIds.has(setNorm)) return true;
  // Sub-token match: "OP14" should also hit setNorm "OP14RE", "OP14ANN", etc.
  for (const wanted of setIds) {
    if (setNorm.startsWith(wanted) && setNorm.length > wanted.length) return true;
  }
  return false;
};

// Pull every recognizable set prefix from the PSA cert. Brand is the primary
// signal ("ONE PIECE OP11-A FIST OF DIVINE SPEED" → OP11); Category is a
// backup; Subject and CardNumber sometimes carry it too.
const extractCertSetIds = (cert) => {
  const setIds = new Set();
  const fields = [cert.brand, cert.raw?.Brand, cert.category, cert.raw?.Category, cert.subject, cert.raw?.Subject, cert.card_number, cert.raw?.CardNumber, cert.raw?.VarietyPedigree];
  for (const f of fields) for (const s of extractSetIds(f)) setIds.add(s.toUpperCase());
  // PSA brands often spell "PROMO" — also match cards in the PROMO bucket.
  const brandText = `${cert.brand || ''} ${cert.raw?.Brand || ''}`.toUpperCase();
  if (/\bPROMO\b/.test(brandText)) setIds.add('PROMO');
  return setIds;
};

// The PSA → OPTCG matcher (TCGPlayer-sourced catalog).
//
// Algorithm (simple, in order):
//   1. Brand → set    (extract OP11 / ST21 / EB02 from the Brand text)
//   2. CardNumber → trailing card number (last digits, zero-padded to 3)
//   3. Look up cards in the catalog where (set, trailing-number) match.
//      A PSA "OP14" hits both the OP14 group and OP14 RE / OP14 ANN
//      sub-groups (release-event and tournament prize sets); the base
//      group ranks first so the user gets the normal printing by default.
//   4. If Subject is present and multiple cards remain, filter to those
//      whose name matches the Subject (token-set match: PSA's "MONKEY D.
//      LUFFY" ↔ catalog "Monkey D. Luffy"). Falls back to the sales-
//      formatted fullName so "ALTERNATE ART" / "MANGA RARE" hints in
//      Subject still hit.
//   5. Sort: number-match first, then base printings (no attribute flags),
//      then prefer the shorter (parent) set abbreviation, then by setId desc.
//
// Fallbacks (only when steps 1–4 yield nothing): subject-only across all
// sets, then OPTCG-id extraction from any field, then any catalog card
// whose displayId trails the CardNumber.
export const findCandidateCards = (cert, catalog) => {
  if (!cert || !Array.isArray(catalog)) return [];
  const subj = (cert.subject || '').trim();
  const numMatch = (cert.card_number || '').toString().match(/(\d+)/);
  const numPadded = numMatch ? numMatch[1].padStart(3, '0') : null;
  const setIds = extractCertSetIds(cert);

  const trailingMatchesNum = (c) =>
    numPadded ? (c.displayId || c.id || '').toUpperCase().endsWith(`-${numPadded}`) : false;

  // Step 1+2+3: cards in the PSA-derived set(s) whose displayId ends in
  // the PSA-derived card number. This is the primary path.
  let matches = [];
  if (setIds.size > 0 && numPadded) {
    matches = catalog.filter(c => cardInAnySet(c, setIds) && trailingMatchesNum(c));
  }

  // Step 4: subject-narrow when present and we got multiple hits. A single
  // hit doesn't need narrowing; zero hits drops to fallbacks below.
  if (matches.length > 1 && subj) {
    const named = matches.filter(c => nameMatchesSubject(c.name, subj, c.fullName));
    if (named.length > 0) matches = named;
  }

  // Fallback A: set + subject (without number). Brand identified the set
  // but PSA's CardNumber didn't pin a printing (e.g. promos with
  // alphanumeric card numbers PSA records oddly).
  if (matches.length === 0 && setIds.size > 0 && subj) {
    matches = catalog.filter(c => cardInAnySet(c, setIds) && nameMatchesSubject(c.name, subj, c.fullName));
  }

  // Fallback B: subject-only across the whole catalog. Brand didn't yield
  // a recognizable set, but the subject is clean enough to hit cards by name.
  if (matches.length === 0 && subj) {
    matches = catalog.filter(c => nameMatchesSubject(c.name, subj, c.fullName));
  }

  // Fallback C: extract any OPTCG-format id from PSA fields and look it up.
  if (matches.length === 0) {
    const ids = new Set();
    for (const f of [cert.card_number, cert.brand, cert.subject, cert.category,
                     cert.raw?.CardNumber, cert.raw?.VarietyPedigree,
                     cert.raw?.Brand, cert.raw?.Category, cert.raw?.Subject]) {
      for (const id of extractOptcgIds(f)) ids.add(id.toUpperCase());
    }
    if (ids.size > 0) {
      matches = catalog.filter(c => ids.has((c.displayId || c.id || '').toUpperCase()));
    }
  }

  // Fallback D: any card whose displayId trails the PSA card number,
  // regardless of set or subject. Last-resort net.
  if (matches.length === 0 && numPadded) {
    matches = catalog.filter(c => trailingMatchesNum(c));
  }

  if (matches.length === 0) return [];

  // Rank: cards whose trailing number matches PSA's CardNumber come first,
  // then base printings (no attribute flags) before any variant, then by
  // setId desc so more recent printings rise. Tie-broken so a card whose
  // setId equals the base PSA-derived set (e.g. "OP14") wins over one in
  // a release-event sub-group ("OP14 RE") — the user can manually pick the
  // event-stamped printing if that's actually what they have.
  const baseSet = setIds.size === 1 ? [...setIds][0] : null;
  const setLen = (s) => (s || '').replace(/[^A-Z0-9]/gi, '').length;
  matches.sort((a, b) => {
    const aNum = trailingMatchesNum(a) ? 0 : 1;
    const bNum = trailingMatchesNum(b) ? 0 : 1;
    if (aNum !== bNum) return aNum - bNum;
    const aAttrs = (a.attributes || []).length;
    const bAttrs = (b.attributes || []).length;
    if (aAttrs !== bAttrs) return aAttrs - bAttrs;
    if (baseSet) {
      // Prefer the shortest matching set token (the parent group) over its
      // longer variants like "OP14RE", "OP14ANN".
      const aLen = setLen(a.setId), bLen = setLen(b.setId);
      if (aLen !== bLen) return aLen - bLen;
    }
    return (b.setId || '').localeCompare(a.setId || '');
  });

  // Dedup and cap.
  const seen = new Set();
  const out = [];
  for (const c of matches) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= CANDIDATE_CAP) break;
  }
  return out;
};

