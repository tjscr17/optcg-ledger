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

const norm = (s) => (s || '').toString().toUpperCase().replace(/[\s_]/g, '');

// Heuristic match: find the OPTCG catalog card that corresponds to the PSA
// cert. PSA's CardNumber format varies — it can be the bare card_set_id, a
// stripped variant, the running number only, or buried in VarietyPedigree
// / Subject. We try several strategies and prefer the most specific match.
export const matchCatalogCard = (cert, catalog) => {
  if (!cert || !Array.isArray(catalog)) return null;

  // 1. Collect every candidate OPTCG id we can extract from the PSA payload.
  const candidates = new Set();
  for (const field of [cert.card_number, cert.subject, cert.brand, cert.raw?.VarietyPedigree, cert.raw?.Subject, cert.raw?.Brand, cert.raw?.CardNumber]) {
    for (const id of extractOptcgIds(field)) candidates.add(id);
  }
  // Also try the raw card_number as a normalized direct match.
  if (cert.card_number) candidates.add(norm(cert.card_number).replace(/-/g, '').replace(/^(OP|ST|EB|PRB)(\d+)(\d{3})$/i, '$1$2-$3'));

  // 2. Build a quick lookup table over the catalog using multiple key forms.
  const byKey = new Map();
  for (const c of catalog) {
    const display = (c.displayId || c.id || '').toUpperCase();
    const variants = [display, norm(display), display.replace(/-/g, '')];
    for (const k of variants) if (k && !byKey.has(k)) byKey.set(k, c);
  }

  // 3. Try each candidate id against the lookup.
  let match = null;
  for (const cand of candidates) {
    const u = cand.toUpperCase();
    match = byKey.get(u) || byKey.get(norm(u)) || byKey.get(u.replace(/-/g, ''));
    if (match) break;
  }

  // 4. PSA often returns just the trailing card number (e.g. "118") with the
  // set encoded only in Brand/Category text we can't reliably parse. So if
  // we have a numeric card_number AND a subject, intersect (subject ≈ card
  // name) ∩ (displayId ends in -{num}).
  if (!match && cert.subject && cert.card_number) {
    const subj = cert.subject.toLowerCase().trim();
    const numMatch = String(cert.card_number).match(/(\d+)/);
    if (numMatch) {
      const num = numMatch[1].padStart(3, '0');
      const subjectFirstWord = subj.split(/[\s,]/)[0];
      const candidates = catalog.filter(c => {
        const display = (c.displayId || c.id || '').toUpperCase();
        if (!display.endsWith(`-${num}`)) return false;
        const name = (c.name || '').toLowerCase().trim();
        // Either full-name match or any token overlap with subject's first word.
        return name === subj
          || name.includes(subj)
          || subj.includes(name)
          || (subjectFirstWord && name.includes(subjectFirstWord));
      });
      if (candidates.length === 1) {
        match = candidates[0];
      } else if (candidates.length > 1) {
        // Prefer non-parallel/non-alt-art base prints by default; fall back to
        // the most recent set if everything ties. The user can still override
        // via the manual picker if we pick the wrong twin.
        const nonParallel = candidates.filter(c => !c.isParallel);
        const pool = nonParallel.length > 0 ? nonParallel : candidates;
        pool.sort((a, b) => (b.setId || '').localeCompare(a.setId || ''));
        match = pool[0];
      }
    }
  }

  // 5. Last resort: fuzzy-match PSA subject against catalog card names.
  if (!match && cert.subject) {
    const subj = cert.subject.toLowerCase();
    const namedHits = catalog.filter(c => (c.name || '').toLowerCase().includes(subj.split(/[\s,]/)[0]));
    if (namedHits.length === 1) match = namedHits[0];
  }

  if (!match) return null;

  // 6. If multiple printings share that display id (base + parallel/alt-art),
  // refine by checking PSA's pedigree / subject for "ALTERNATE", "PARALLEL", etc.
  const targetDisplay = (match.displayId || match.id || '').toUpperCase();
  const same = catalog.filter(c => (c.displayId || c.id || '').toUpperCase() === targetDisplay);
  if (same.length > 1) {
    const blob = `${cert.raw?.VarietyPedigree || ''} ${cert.subject || ''}`.toLowerCase();
    const wantsParallel = /alternate|parallel|alt[- ]art|sp\b|spr\b/.test(blob);
    const preferred = same.find(c => Boolean(c.isParallel) === wantsParallel);
    if (preferred) return preferred;
  }
  return match;
};
