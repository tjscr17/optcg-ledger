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
// Catches "Monkey D. Luffy" matching "Monkey D. Luffy (Manga Art)" and
// "ZORO" matching "Roronoa Zoro" but not random partial overlaps.
const nameMatchesSubject = (cardName, subject) => {
  const subjTokens = tokenize(subject);
  if (subjTokens.length === 0) return false;
  const nameTokens = new Set(tokenize(cardName));
  return subjTokens.every(t => nameTokens.has(t));
};

const CANDIDATE_CAP = 25;

// Returns true if a catalog card belongs to one of the PSA-derived setIds.
// Checks card.setId (normalized: "OP-12" → "OP12") AND card.originalSetId
// (for promos that we bucket under setId="PROMO" but originally came from
// e.g. OP-09). Promos in setId="PROMO" match against the special PROMO key.
const cardInAnySet = (card, setIds) => {
  if (setIds.size === 0) return false;
  const setNorm = (card.setId || '').replace(/-/g, '').toUpperCase();
  if (setNorm && setIds.has(setNorm)) return true;
  const origNorm = (card.originalSetId || '').replace(/-/g, '').toUpperCase();
  if (origNorm && setIds.has(origNorm)) return true;
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

// The PSA → OPTCG matcher.
//
// Algorithm (simple, in order):
//   1. Brand → set    (extract OP11 / ST21 / EB02 / PROMO from the Brand text)
//   2. CardNumber → trailing card number (last digits, zero-padded to 3)
//   3. Look up cards in the catalog where (set, trailing-number) match.
//   4. If Subject is present and multiple cards remain, filter to those
//      whose name matches the Subject (token-set match: PSA's "MONKEY D.
//      LUFFY" ↔ catalog "Monkey D. Luffy").
//   5. Sort: non-parallel base first, then by setId desc.
//
// Cards in a different printing set (cross-set reprints) are also matched —
// `card.setId` and `card.originalSetId` are both checked against the
// PSA-derived set, so an OP12 parallel printing of ST01-004 (with
// displayId "ST01-004" but setId "OP-12") shows up under PSA's "OP12 / 004".
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
    const named = matches.filter(c => nameMatchesSubject(c.name, subj));
    if (named.length > 0) matches = named;
  }

  // Fallback A: set + subject (without number). Brand identified the set
  // but PSA's CardNumber didn't pin a printing (e.g. promos with
  // alphanumeric card numbers PSA records oddly).
  if (matches.length === 0 && setIds.size > 0 && subj) {
    matches = catalog.filter(c => cardInAnySet(c, setIds) && nameMatchesSubject(c.name, subj));
  }

  // Fallback B: subject-only across the whole catalog. Brand didn't yield
  // a recognizable set, but the subject is clean enough to hit cards by name.
  if (matches.length === 0 && subj) {
    matches = catalog.filter(c => nameMatchesSubject(c.name, subj));
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
  // then non-parallel base before parallel/alt-art, then by setId desc so
  // more recent printings rise.
  matches.sort((a, b) => {
    const aNum = trailingMatchesNum(a) ? 0 : 1;
    const bNum = trailingMatchesNum(b) ? 0 : 1;
    if (aNum !== bNum) return aNum - bNum;
    const ap = a.isParallel ? 1 : 0;
    const bp = b.isParallel ? 1 : 0;
    if (ap !== bp) return ap - bp;
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

// Best single guess for the cert. Returns the top candidate or null.
export const matchCatalogCard = (cert, catalog) =>
  findCandidateCards(cert, catalog)[0] || null;
