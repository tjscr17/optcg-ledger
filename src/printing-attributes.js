// ============================================================================
// Printing attribute registry — the single source of truth for every printing
// variant (parallel, manga rare, plus any user-defined facets like
// event-stamps). Builtins live here; user-defined entries live in localStorage
// (`optcg:variants:v1`) and are managed from the Variants modal in the
// Resolve view. Every consumer — catalog detection, product detection,
// match scoring, mismatch diagnosis, UI pills — iterates the effective list
// so adding a new facet is a one-line entry, no other code touched.
//
// Patterns run against OPTCGAPI `card_name` AND TCGPlayer product `name`
// (the conventions overlap closely so the same regex applies to both).
// ============================================================================

const STORAGE_KEY = 'optcg:variants:v1';

// Builtins are baked in as defaults. They show in the manager as locked
// entries; users can add/remove their own alongside.
const BUILTINS = [
  {
    key: 'parallel',
    label: 'Parallel',
    mode: 'regex',
    value: '\\(Parallel\\)|\\(Alternate Art\\)|\\(Alt[- ]Art\\)|\\(Alternate\\)|\\(Special\\)|\\(SP\\)',
    builtin: true,
  },
  {
    key: 'manga',
    label: 'Manga',
    mode: 'regex',
    value: '\\(Manga Rare\\)|\\(Manga\\)',
    builtin: true,
  },
];

// Compile an entry's pattern into a case-insensitive RegExp. Text-mode values
// are escaped so they match literally; regex-mode values are taken as-is.
const compile = (entry) => {
  try {
    if (entry.mode === 'text') {
      const escaped = String(entry.value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!escaped) return null;
      return new RegExp(escaped, 'i');
    }
    if (!entry.value) return null;
    return new RegExp(entry.value, 'i');
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
    .map(e => ({ ...e, _re: compile(e) }))
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

// Public: lookup a single attribute by key (mostly for label rendering).
export const printingAttribute = (key) => {
  if (!compiled) rebuild();
  const hit = compiled.find(a => a.key === key);
  return hit ? { key: hit.key, label: hit.label, mode: hit.mode, value: hit.value, builtin: hit.builtin } : null;
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
export const listUserVariants = () => loadUserEntries();

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

export const updateUserVariant = (key, patch) => {
  const list = loadUserEntries();
  const idx = list.findIndex(e => e.key === key);
  if (idx < 0) return { ok: false, error: 'not found' };
  const next = { ...list[idx], ...patch };
  if (!compile(next)) return { ok: false, error: 'pattern failed to compile' };
  list[idx] = next;
  saveUserEntries(list);
  rebuild();
  emit();
  return { ok: true, entry: next };
};

export const removeUserVariant = (key) => {
  const list = loadUserEntries().filter(e => e.key !== key);
  saveUserEntries(list);
  rebuild();
  emit();
  return { ok: true };
};
