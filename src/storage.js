// ============================================================================
// Storage adapter — same interface in both modes so the UI doesn't care which.
//
// Solo mode (default): localStorage, single-device.
// Shared mode: Supabase, multiple people on the same shared "vault key".
//
// To enable shared mode, set in your .env (or Vercel/Netlify env vars):
//   VITE_SUPABASE_URL=https://xxxx.supabase.co
//   VITE_SUPABASE_KEY=<your anon key>
//   VITE_VAULT_KEY=<a shared secret string you pick — anything>
//
// SHARED-MODE SCHEMA (2026-06 rebuild): the app's logical tables are
// TRANSLATED onto the rebuilt relational DB (project ajpxzfhmyzzgarewijnr):
//   entries        -> collected_cards   (purchase_price=price_paid, notes=acquisition_notes,
//                                         acquired_at=date_acquired; grading_company+grade+bgs_black
//                                         <-> grade_code; contributions live on the BUY transaction)
//   transactions   -> transactions + transaction_contributions (contributions array rebuilt
//                                         from member rows; entry_id=collected_card_id)
//   sales          -> sales             (no vault_key — uses ingested_by_vault; marketplace=listing_site,
//                                         notes=description; grade_code)
//   collections    -> collections       (passthrough)
//   watchlist      -> watchlist         (passthrough)
//   card_aliases   -> card_aliases      (passthrough)
// card identity is the cards.id UUID (catalog is Supabase-sourced; see catalog.js).
// card_resolutions is retired (no resolve step in the UUID era) — helpers are no-ops.
// ============================================================================

import { createClient } from '@supabase/supabase-js';

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_KEY;
const VAULT_KEY = import.meta.env.VITE_VAULT_KEY || 'default';

const isShared = Boolean(SUPA_URL && SUPA_KEY);
const supa = isShared ? createClient(SUPA_URL, SUPA_KEY) : null;

export const MODE = isShared ? 'shared' : 'solo';

let lastStoreError = null;
export const getLastStoreError = () => lastStoreError;

// ----- Solo (localStorage) -----
const lsKey = (table) => `optcg:${VAULT_KEY}:${table}`;

const solo = {
  async list(table) {
    try {
      const raw = localStorage.getItem(lsKey(table));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },
  async insert(table, row) {
    const rows = await solo.list(table);
    const next = [...rows, row];
    localStorage.setItem(lsKey(table), JSON.stringify(next));
    return row;
  },
  async update(table, id, patch) {
    const rows = await solo.list(table);
    const next = rows.map(r => r.id === id ? { ...r, ...patch } : r);
    localStorage.setItem(lsKey(table), JSON.stringify(next));
    return next.find(r => r.id === id);
  },
  async remove(table, id) {
    const rows = await solo.list(table);
    const next = rows.filter(r => r.id !== id);
    localStorage.setItem(lsKey(table), JSON.stringify(next));
  },
  async removeWhere(table, predicate) {
    const rows = await solo.list(table);
    const next = rows.filter(r => !predicate(r));
    localStorage.setItem(lsKey(table), JSON.stringify(next));
  },
  subscribe() { return () => {}; }, // no-op in solo
  async listResolutions() { return []; },
  async upsertResolution() { /* no-op */ },
  async deleteAllResolutions() { return 0; },
  subscribeResolutions() { return () => {}; },
};

// ===========================================================================
// Shared (Supabase) — translation layer between the app's logical shapes and
// the rebuilt relational schema.
// ===========================================================================

// Logical table -> physical table + the column the vault partitions on.
const PHYS = {
  collections:  { tbl: 'collections',  vaultCol: 'vault_key' },
  entries:      { tbl: 'collected_cards', vaultCol: 'vault_key' },
  transactions: { tbl: 'transactions', vaultCol: 'vault_key' },
  sales:        { tbl: 'sales',        vaultCol: 'ingested_by_vault' },
  watchlist:    { tbl: 'watchlist',    vaultCol: 'vault_key' },
  card_aliases: { tbl: 'card_aliases', vaultCol: 'vault_key' },
};

const orNull = (v) => (v === undefined || v === '' ? null : v);

// ---- grade_code <-> (grading_company, grade, bgs_black) ----
const gradeToCode = (company, grade, bgsBlack) => {
  const c = String(company || '').toUpperCase().trim();
  if (!c) return null; // ungraded / raw
  if (c === 'BGS' && bgsBlack && Number(grade) === 10) return 'BGS 10 Black Label';
  if (c === 'CGC' && bgsBlack && Number(grade) === 10) return 'CGC 10 Pristine';
  if (grade === null || grade === undefined || grade === '') return null;
  const g = String(grade).replace(/\.0$/, '');
  return `${c} ${g}`;
};
const codeToGrade = (code) => {
  if (!code || code === 'RAW') return { grading_company: '', grade: null, bgs_black: false };
  if (code === 'BGS 10 Black Label') return { grading_company: 'BGS', grade: 10, bgs_black: true };
  if (code === 'CGC 10 Pristine') return { grading_company: 'CGC', grade: 10, bgs_black: true };
  const m = /^([A-Za-z]+)\s+([\d.]+)$/.exec(code);
  if (m) return { grading_company: m[1].toUpperCase(), grade: Number(m[2]), bgs_black: false };
  return { grading_company: '', grade: null, bgs_black: false };
};

// ---- entries <-> collected_cards ----
const entryPatchToDb = (e) => {
  const out = {};
  if ('collection_id' in e) out.collection_id = orNull(e.collection_id);
  if ('card_id' in e) out.card_id = e.card_id;
  if ('condition' in e) out.condition = orNull(e.condition);
  if ('owner_name' in e) out.owner_name = orNull(e.owner_name);
  if ('purchase_price' in e) out.price_paid = Number(e.purchase_price) || 0;
  if ('notes' in e) out.acquisition_notes = orNull(e.notes);
  if ('acquired_at' in e) out.date_acquired = orNull(e.acquired_at);
  if ('date_sold' in e) out.date_sold = orNull(e.date_sold);
  if ('sold_price' in e) out.sold_price = orNull(e.sold_price);
  if ('grade_description' in e) out.grade_description = orNull(e.grade_description);
  if ('psa_spec_id' in e) out.psa_spec_id = orNull(e.psa_spec_id);
  if ('cert_number' in e) out.cert_number = orNull(e.cert_number);
  if ('graded_price' in e) out.graded_price = orNull(e.graded_price);
  if ('graded_price_source' in e) out.graded_price_source = orNull(e.graded_price_source);
  if ('graded_price_fetched_at' in e) out.graded_price_fetched_at = orNull(e.graded_price_fetched_at);
  // grade fields collapse to grade_code (need at least one present to recompute)
  if ('grading_company' in e || 'grade' in e || 'bgs_black' in e) {
    out.grade_code = gradeToCode(e.grading_company, e.grade, e.bgs_black);
  }
  return out;
};
const entryToApp = (cc, contribs) => {
  const g = codeToGrade(cc.grade_code);
  return {
    id: cc.id,
    collection_id: cc.collection_id,
    card_id: cc.card_id,
    condition: cc.condition,
    owner_name: cc.owner_name,
    purchase_price: cc.price_paid,
    notes: cc.acquisition_notes,
    acquired_at: cc.date_acquired,
    added_at: cc.added_at,
    date_sold: cc.date_sold,
    sold_price: cc.sold_price,
    grade_description: cc.grade_description,
    psa_spec_id: cc.psa_spec_id,
    cert_number: cc.cert_number,
    graded_price: cc.graded_price,
    graded_price_source: cc.graded_price_source,
    graded_price_fetched_at: cc.graded_price_fetched_at,
    grading_company: g.grading_company,
    grade: g.grade,
    bgs_black: g.bgs_black,
    contributions: contribs || [],
  };
};

// ---- transactions <-> transactions(+transaction_contributions) ----
const txPatchToDb = (t) => {
  const out = {};
  if ('collection_id' in t) out.collection_id = orNull(t.collection_id);
  if ('card_id' in t) out.card_id = orNull(t.card_id);
  if ('card_display_name' in t) out.card_display_name = orNull(t.card_display_name);
  if ('type' in t) out.type = t.type;
  if ('amount' in t) out.amount = Number(t.amount) || 0;
  if ('occurred_at' in t) out.occurred_at = orNull(t.occurred_at);
  if ('notes' in t) out.notes = orNull(t.notes);
  if ('entry_id' in t) out.collected_card_id = orNull(t.entry_id);
  return out;
};
const txToApp = (t, contribs) => ({
  id: t.id,
  collection_id: t.collection_id,
  card_id: t.card_id,
  card_display_name: t.card_display_name,
  type: t.type,
  amount: t.amount,
  occurred_at: t.occurred_at,
  notes: t.notes,
  created_at: t.created_at,
  entry_id: t.collected_card_id,
  contributions: contribs || [],
});

// ---- sales <-> sales ----
const salePatchToDb = (s) => {
  const out = {};
  if ('card_id' in s) out.card_id = orNull(s.card_id);
  if ('cert_number' in s) out.cert_number = orNull(s.cert_number);
  if ('marketplace' in s) out.listing_site = s.marketplace || 'Unknown';
  if ('listing_url' in s) out.listing_url = orNull(s.listing_url);
  if ('listing_title' in s) out.listing_title = orNull(s.listing_title);
  if ('sale_date' in s) out.sale_date = s.sale_date;
  if ('sale_price' in s) out.sale_price = Number(s.sale_price) || 0;
  if ('currency' in s) out.currency = s.currency || 'USD';
  if ('notes' in s) out.description = orNull(s.notes);
  if ('source' in s) out.source = s.source || 'manual';
  if ('grading_company' in s || 'grade' in s || 'bgs_black' in s) {
    out.grade_code = gradeToCode(s.grading_company, s.grade, s.bgs_black);
  }
  return out;
};
const saleToApp = (s) => {
  const g = codeToGrade(s.grade_code);
  return {
    id: s.id,
    card_id: s.card_id,
    cert_number: s.cert_number,
    sale_date: s.sale_date,
    sale_price: s.sale_price,
    currency: s.currency,
    marketplace: s.listing_site,
    listing_url: s.listing_url,
    listing_title: s.listing_title,
    notes: s.description,
    source: s.source,
    created_at: s.created_at,
    grading_company: g.grading_company,
    grade: g.grade,
    bgs_black: g.bgs_black,
  };
};

// Build {transaction_id -> [{name, amount}]} for the vault.
const fetchContribsByTx = async () => {
  const map = new Map();
  const { data, error } = await supa.from('transaction_contributions')
    .select('transaction_id, member_name, amount').eq('vault_key', VAULT_KEY);
  if (error) { console.error('[storage] tc fetch', error); return map; }
  for (const r of (data || [])) {
    if (!map.has(r.transaction_id)) map.set(r.transaction_id, []);
    map.get(r.transaction_id).push({ name: r.member_name, amount: Number(r.amount) });
  }
  return map;
};

const shared = {
  async list(table) {
    const cfg = PHYS[table];
    if (!cfg) { console.error('[storage] unknown table', table); return []; }

    if (table === 'entries') {
      const { data: ccs, error } = await supa.from('collected_cards')
        .select('*').eq('vault_key', VAULT_KEY); // active + sold; the app filters active vs sold
      if (error) { console.error(error); return []; }
      // contributions per card come from its BUY transaction
      const { data: buys } = await supa.from('transactions')
        .select('id, collected_card_id').eq('vault_key', VAULT_KEY).eq('type', 'buy');
      const tcByTx = await fetchContribsByTx();
      const byCard = new Map();
      for (const b of (buys || [])) if (b.collected_card_id) byCard.set(b.collected_card_id, tcByTx.get(b.id) || []);
      return (ccs || []).map(cc => entryToApp(cc, byCard.get(cc.id)));
    }

    if (table === 'transactions') {
      const { data, error } = await supa.from('transactions').select('*').eq('vault_key', VAULT_KEY);
      if (error) { console.error(error); return []; }
      const tcByTx = await fetchContribsByTx();
      return (data || []).map(t => txToApp(t, tcByTx.get(t.id)));
    }

    if (table === 'sales') {
      const { data, error } = await supa.from('sales').select('*').eq('ingested_by_vault', VAULT_KEY);
      if (error) { console.error(error); return []; }
      return (data || []).map(saleToApp);
    }

    // collections / watchlist / card_aliases — passthrough
    const { data, error } = await supa.from(cfg.tbl).select('*').eq(cfg.vaultCol, VAULT_KEY);
    if (error) { console.error(error); return []; }
    return data || [];
  },

  async insert(table, row) {
    const cfg = PHYS[table];
    if (!cfg) return null;

    if (table === 'entries') {
      const payload = { ...entryPatchToDb(row), vault_key: VAULT_KEY };
      const { data, error } = await supa.from('collected_cards').insert(payload).select().single();
      if (error) { lastStoreError = pickErr(error, 'collected_cards'); console.error('[storage] insert entries', error); return null; }
      // contributions persist via the buy tx that addEntry logs next; echo input back.
      return entryToApp(data, Array.isArray(row.contributions) ? row.contributions : []);
    }

    if (table === 'transactions') {
      const payload = { ...txPatchToDb(row), vault_key: VAULT_KEY };
      const { data, error } = await supa.from('transactions').insert(payload).select().single();
      if (error) { lastStoreError = pickErr(error, 'transactions'); console.error('[storage] insert tx', error); return null; }
      const contribs = (Array.isArray(row.contributions) ? row.contributions : [])
        .filter(c => c && c.name && Number(c.amount) !== 0)
        .map(c => ({ vault_key: VAULT_KEY, transaction_id: data.id, member_name: String(c.name).trim(), amount: Number(c.amount) }));
      if (contribs.length) {
        const { error: cErr } = await supa.from('transaction_contributions').insert(contribs);
        if (cErr) console.error('[storage] insert tc', cErr);
      }
      return txToApp(data, contribs.map(c => ({ name: c.member_name, amount: c.amount })));
    }

    if (table === 'sales') {
      const { data, error } = await supa.from('sales').insert(salePatchToDb(row)).select().single();
      if (error) { lastStoreError = pickErr(error, 'sales'); console.error('[storage] insert sale', error); return null; }
      return saleToApp(data);
    }

    // collections / watchlist / card_aliases — passthrough
    const payload = { ...row, vault_key: VAULT_KEY };
    delete payload.id;
    const { data, error } = await supa.from(cfg.tbl).insert(payload).select().single();
    if (error) { lastStoreError = pickErr(error, cfg.tbl); console.error('[storage] insert', table, error); return null; }
    return data;
  },

  async update(table, id, patch) {
    const cfg = PHYS[table];
    if (!cfg) return null;

    if (table === 'entries') {
      const dbPatch = entryPatchToDb(patch);
      let row = null;
      if (Object.keys(dbPatch).length) {
        const { data, error } = await supa.from('collected_cards').update(dbPatch).eq('id', id).select().single();
        if (error) { console.error(error); return null; }
        row = data;
      } else {
        const { data } = await supa.from('collected_cards').select('*').eq('id', id).single();
        row = data;
      }
      // editing who-contributed updates the card's BUY tx contributions
      let contribs = Array.isArray(patch.contributions) ? patch.contributions : null;
      if (contribs) {
        const { data: buy } = await supa.from('transactions').select('id')
          .eq('vault_key', VAULT_KEY).eq('type', 'buy').eq('collected_card_id', id).limit(1).maybeSingle();
        if (buy) {
          await supa.from('transaction_contributions').delete().eq('transaction_id', buy.id);
          const rows = contribs.filter(c => c && c.name && Number(c.amount) !== 0)
            .map(c => ({ vault_key: VAULT_KEY, transaction_id: buy.id, member_name: String(c.name).trim(), amount: Number(c.amount) }));
          if (rows.length) await supa.from('transaction_contributions').insert(rows);
        }
      } else {
        // re-derive current contributions for the returned object
        const { data: buy } = await supa.from('transactions').select('id')
          .eq('vault_key', VAULT_KEY).eq('type', 'buy').eq('collected_card_id', id).limit(1).maybeSingle();
        if (buy) {
          const { data: tc } = await supa.from('transaction_contributions').select('member_name, amount').eq('transaction_id', buy.id);
          contribs = (tc || []).map(c => ({ name: c.member_name, amount: Number(c.amount) }));
        }
      }
      return row ? entryToApp(row, contribs || []) : null;
    }

    if (table === 'transactions') {
      const { data, error } = await supa.from('transactions').update(txPatchToDb(patch)).eq('id', id).select().single();
      if (error) { console.error(error); return null; }
      // When the edit includes contributions, replace this tx's rows wholesale.
      if (Array.isArray(patch.contributions)) {
        await supa.from('transaction_contributions').delete().eq('transaction_id', id);
        const rows = patch.contributions
          .filter(c => c && c.name && Number(c.amount) !== 0)
          .map(c => ({ vault_key: VAULT_KEY, transaction_id: id, member_name: String(c.name).trim(), amount: Number(c.amount) }));
        if (rows.length) {
          const { error: cErr } = await supa.from('transaction_contributions').insert(rows);
          if (cErr) console.error('[storage] update tx contribs', cErr);
        }
      }
      const tc = await fetchContribsByTx();
      return txToApp(data, tc.get(data.id));
    }

    if (table === 'sales') {
      const { data, error } = await supa.from('sales').update(salePatchToDb(patch)).eq('id', id).select().single();
      if (error) { console.error(error); return null; }
      return saleToApp(data);
    }

    const { data, error } = await supa.from(cfg.tbl).update(patch).eq('id', id).select().single();
    if (error) { console.error(error); return null; }
    return data;
  },

  async remove(table, id) {
    const cfg = PHYS[table];
    if (!cfg) return;
    // transaction_contributions cascade on tx delete (FK ON DELETE CASCADE).
    const { error } = await supa.from(cfg.tbl).delete().eq('id', id);
    if (error) console.error(error);
  },

  async removeWhere(table, predicate) {
    const rows = await shared.list(table);
    const ids = rows.filter(predicate).map(r => r.id);
    if (ids.length === 0) return;
    const cfg = PHYS[table];
    const { error } = await supa.from(cfg.tbl).delete().in('id', ids);
    if (error) console.error(error);
  },

  subscribe(table, callback) {
    const cfg = PHYS[table];
    if (!cfg) return () => {};
    const channel = supa
      .channel(`changes:${cfg.tbl}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: cfg.tbl, filter: `${cfg.vaultCol}=eq.${VAULT_KEY}` },
        () => callback()
      )
      .subscribe();
    return () => supa.removeChannel(channel);
  },

  // card_resolutions retired in the UUID era — no-ops.
  async listResolutions() { return []; },
  async upsertResolution() { return true; },
  async deleteAllResolutions() { return 0; },
  subscribeResolutions() { return () => {}; },
};

const pickErr = (error, table) => ({ code: error.code, message: error.message, table, details: error.details, hint: error.hint });

export const store = isShared ? shared : solo;
export const VAULT_LABEL = VAULT_KEY;
