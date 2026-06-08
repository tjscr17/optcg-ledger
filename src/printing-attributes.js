// ============================================================================
// Printing attribute registry — the single source of truth for every printing
// variant (parallel, manga rare, plus any user-defined facets like
// event-stamps). Builtins live here; user-defined entries live in localStorage
// (`optcg:variants:v1`) and are managed from the Variants modal in the
// Resolve view. Every consumer — catalog detection, product detection,
// match scoring, mismatch diagnosis, UI pills — iterates the effective list
// so adding a new facet is a one-line entry, no other code touched.
//
// Patterns run against TCGPlayer product `name` (the only catalog source
// post-2026-06-01 — OPTCGAPI was retired).
// ============================================================================

const STORAGE_KEY = 'optcg:variants:v1';

// Builtins are baked in as defaults. They show in the manager as locked
// entries; users can add/remove their own alongside.
//
// Two regexes per attribute:
//   value     — matches TCGPlayer product `name`. TCGPlayer is consistent
//               with parenthesized labels like "(Manga Rare)", so the
//               catalog patterns lean on the parens.
//   saleValue — matches free-text eBay / 130point listing titles, where
//               sellers write "Manga Parallel" / "Dodgers Luffy" without
//               parens. Falls back to `value` if unset.
const BUILTINS = [
  {
    key: 'parallel',
    label: 'Parallel',
    mode: 'regex',
    value: '\\(Parallel\\)|\\(Alternate Art\\)|\\(Alt[- ]Art\\)|\\(Alternate\\)|\\(Special\\)|\\(SP\\)',
    saleValue: '\\bParallel\\b|\\bAlt(?:ernate)?\\s+Art\\b|\\bAlt[- ]Art\\b',
    builtin: true,
  },
  {
    key: 'manga',
    label: 'Manga',
    mode: 'regex',
    value: '\\(Manga Rare\\)|\\(Manga\\)',
    saleValue: '\\bManga\\s+(?:Rare|Parallel|Variant)\\b|\\b(?:Rare|Parallel|Variant)\\s+Manga\\b',
    builtin: true,
  },
  // Special-edition promo variants ship as builtins so common cards
  // (Dodgers Luffy, Anniversary alts, judge promos) match listing titles
  // out of the box.
  //
  // value (catalog) is intentionally parens-required — TCGPlayer uses
  // `(Foo)` labels consistently for variant printings and matching free
  // text would mis-tag any product whose name happens to mention the
  // keyword (a Champions of Earth set wrongly gets every card tagged
  // 'championship'; a flavor-text 'Judge' word breaks things; etc).
  //
  // saleValue (sale matcher) is the permissive free-text form because
  // eBay sellers don't follow TCGPlayer conventions.
  {
    key: 'dodgers',
    label: 'Dodgers Promo',
    mode: 'regex',
    value: '\\(Dodgers\\)|\\(LA\\s+Dodgers\\)|\\(Dodgers\\s+(?:Promo|Edition)\\)',
    saleValue: '\\bDodgers\\b|\\bLA\\s+Dodgers\\b',
    builtin: true,
  },
  {
    key: 'anniversary',
    label: 'Anniversary',
    mode: 'regex',
    value: '\\(Anniversary\\)|\\(\\d+(?:st|nd|rd|th)\\s+Anniversary\\)',
    saleValue: '\\bAnniversary\\b|\\b\\d+(?:st|nd|rd|th)\\s+Ann(?:iv)?\\b',
    builtin: true,
  },
  {
    key: 'aniplex',
    label: 'Aniplex',
    mode: 'regex',
    value: '\\(Aniplex\\)',
    saleValue: '\\bAniplex\\b',
    builtin: true,
  },
  {
    key: 'judge',
    label: 'Judge Promo',
    mode: 'regex',
    value: '\\(Judge\\)|\\(Judge\\s+(?:Promo|Reward|Edition)\\)',
    saleValue: '\\bJudge(?:\\s+(?:Promo|Reward|Edition))?\\b',
    builtin: true,
  },
  {
    key: 'championship',
    label: 'Championship',
    mode: 'regex',
    value: '\\(Championship\\)|\\(Championship\\s+(?:Promo|Pack)\\)',
    saleValue: '\\bChampionship\\b',
    builtin: true,
  },
  // Pre-errata is user-toggled per card via togglePreErrata (catalog.js)
  // — TCGPlayer doesn't sell pre-errata as a labeled product. The value
  // pattern stays unreachable (TCGPlayer never uses (Pre-Errata)) so the
  // catalog auto-detector doesn't fire; the saleValue catches "Pre-Errata"
  // in eBay titles so sale matching works. Catalog canonical for the twin
  // is `<displayId>-pre-errata` (matches matcher output) — see catalog.js
  // line ~89 (canonicalIdOf with variantTag).
  {
    key: 'pre-errata',
    label: 'Pre-Errata',
    mode: 'regex',
    value: '\\(Pre[- ]Errata\\)',
    saleValue: '\\bPre[- ]Errata\\b',
    builtin: true,
  },
];

// Compile an entry's pattern into a case-insensitive RegExp. Text-mode values
// are escaped so they match literally; regex-mode values are taken as-is.
const compile = (entry, key = 'value') => {
  try {
    const raw = entry[key];
    if (!raw) return null;
    if (entry.mode === 'text') {
      const escaped = String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(escaped, 'i');
    }
    return new RegExp(raw, 'i');
  } catch {
    return null;
  }
};

const loadUserEntries = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(e => e && e.key && e.label) : [];
  } catch {
    return [];
  }
};

const saveUserEntries = (entries) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch {}
};

// Cached compiled list — rebuilt on any add/edit/remove.
let compiled = null;
const rebuild = () => {
  const all = [...BUILTINS, ...loadUserEntries()];
  compiled = all
    .map(e => ({
      ...e,
      _re: compile(e, 'value'),
      _saleRe: compile(e, 'saleValue') || compile(e, 'value'),
    }))
    .filter(e => e._re);
};

// Public: the effective list of attribute definitions (builtin + user-added).
// Each entry has {key, label, mode, value, builtin?}.
export const getPrintingAttributes = () => {
  if (!compiled) rebuild();
  return compiled.map(({ _re, ...rest }) => rest);
};

// Public: detect which attribute keys apply to a card / product name.
export const detectPrintingAttributes = (name) => {
  if (!name) return [];
  if (!compiled) rebuild();
  return compiled.filter(a => a._re.test(name)).map(a => a.key);
};

// Public: same as detectPrintingAttributes but uses the looser sale-title
// pattern (saleValue) per attribute. Used by the sale matcher against
// free-text eBay / 130point listing titles.
export const detectPrintingAttributesFromTitle = (title) => {
  if (!title) return [];
  if (!compiled) rebuild();
  return compiled.filter(a => a._saleRe.test(title)).map(a => a.key);
};

// Public: lookup a single attribute by key (mostly for label rendering).
export const printingAttribute = (key) => {
  if (!compiled) rebuild();
  const hit = compiled.find(a => a.key === key);
  return hit ? { key: hit.key, label: hit.label, mode: hit.mode, value: hit.value, saleValue: hit.saleValue, builtin: hit.builtin } : null;
};

// Stable string identifier for the current effective ruleset — used as part
// of the catalog cache key so that when the user edits variants the catalog
// re-derives attributes on next load instead of serving stale ones.
export const printingAttributesFingerprint = () => {
  if (!compiled) rebuild();
  return compiled.map(e => `${e.key}:${e.mode}:${e.value}`).join('|');
};

// Pub/sub so views can re-render when variants change without a page reload.
const listeners = new Set();
export const onPrintingAttributesChanged = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const emit = () => { for (const cb of listeners) { try { cb(); } catch {} } };

// Mutations — used by the Variants manager UI.
export const addUserVariant = ({ key, label, mode = 'text', value }) => {
  const norm = String(key || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!norm || !label?.trim() || !value?.trim()) return { ok: false, error: 'key, label, and value are required' };
  if (BUILTINS.some(b => b.key === norm)) return { ok: false, error: `"${norm}" is a built-in key` };
  const list = loadUserEntries();
  if (list.some(e => e.key === norm)) return { ok: false, error: `"${norm}" already exists` };
  const entry = { key: norm, label: label.trim(), mode: mode === 'regex' ? 'regex' : 'text', value: value.trim() };
  if (!compile(entry)) return { ok: false, error: 'pattern failed to compile' };
  list.push(entry);
  saveUserEntries(list);
  rebuild();
  emit();
  return { ok: true, entry };
};

export const removeUserVariant = (key) => {
  const list = loadUserEntries().filter(e => e.key !== key);
  saveUserEntries(list);
  rebuild();
  emit();
  return { ok: true };
};
