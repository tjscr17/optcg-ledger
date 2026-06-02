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
// Anyone who visits the site with the same VITE_VAULT_KEY shares one dataset.
// ============================================================================

import { createClient } from '@supabase/supabase-js';

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_KEY;
const VAULT_KEY = import.meta.env.VITE_VAULT_KEY || 'default';

const isShared = Boolean(SUPA_URL && SUPA_KEY);
const supa = isShared ? createClient(SUPA_URL, SUPA_KEY) : null;

export const MODE = isShared ? 'shared' : 'solo';

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
  // Card resolutions: no remote in solo mode — caller relies on localStorage caches.
  async listResolutions() { return []; },
  async upsertResolution() { /* no-op */ },
  async deleteAllResolutions() { return 0; },
  subscribeResolutions() { return () => {}; },
};

// ----- Shared (Supabase) -----
// Expects tables: collections, entries, card_resolutions (each with vault_key
// column + id uuid pk).
//
// SQL to run once in Supabase SQL editor:
//
//   create table collections (
//     id uuid primary key default gen_random_uuid(),
//     vault_key text not null,
//     name text not null,
//     members jsonb default '[]',
//     created_at timestamptz default now()
//   );
//   -- If your collections table predates the members column, add it now:
//   --   alter table collections add column if not exists members jsonb default '[]';
//   --   notify pgrst, 'reload schema';
//
//   -- entries also gains an optional bgs_black boolean for BGS 10 Black Label
//   -- (Perfect 10). Run if your entries table predates it:
//   --   alter table entries add column if not exists bgs_black boolean default false;
//   --   notify pgrst, 'reload schema';
//
//   -- entries also gains an optional grade_description text for PSA's
//   -- verbatim grade label ("GEM MT 10", "MINT 9", "EX-MT 6", "Authentic").
//   -- Saved from AddByCertModal; AddCardModal leaves it null. Run if your
//   -- entries table predates it:
//   --   alter table entries add column if not exists grade_description text;
//   --   notify pgrst, 'reload schema';
//
//   -- transactions gains an optional entry_id to link buys/sells to their
//   -- originating entry. Required for "move card between collections" to
//   -- carry the capital allocation. Backfilling is automatic — moving an
//   -- entry stamps entry_id onto any matching legacy buy tx the first time.
//   --   alter table transactions add column if not exists entry_id text;
//   --   notify pgrst, 'reload schema';
//   create table entries (
//     id uuid primary key default gen_random_uuid(),
//     vault_key text not null,
//     collection_id uuid references collections(id) on delete cascade,
//     card_id text not null,
//     condition text,
//     purchase_price numeric default 0,
//     owner_name text,
//     contributions jsonb default '[]',
//     notes text,
//     added_at timestamptz default now()
//   );
//   -- Resolved TCGPlayer printing per OPTCG card. One row per
//   -- (vault_key, card_id) so picks dedup across the team. `card_id` is
//   -- the canonical id (post-2026-05-27 canonical migration). `snapshot`
//   -- holds the per-product summary (name, image_url, rarity, is_parallel)
//   -- so other devices skip the TCGCSV search.
//   create table card_resolutions (
//     id uuid primary key default gen_random_uuid(),
//     vault_key text not null,
//     card_id text not null,
//     tcg_id text,
//     snapshot jsonb,
//     updated_at timestamptz default now(),
//     unique (vault_key, card_id)
//   );
//   -- Existing tables that pre-date the TCGCSV migration carry three
//   -- PriceCharting-era columns (pc_product_id, pc_product_name, pc_console)
//   -- and one BGS-Black-Label column on entries. They no longer get written
//   -- to. To drop them (or keep them for posterity) run:
//   --   alter table card_resolutions drop column if exists pc_product_id;
//   --   alter table card_resolutions drop column if exists pc_product_name;
//   --   alter table card_resolutions drop column if exists pc_console;
//   --   notify pgrst, 'reload schema';
//   create index on collections (vault_key);
//   create index on entries (vault_key);
//   create index on card_resolutions (vault_key);
//   alter publication supabase_realtime add table collections;
//   alter publication supabase_realtime add table entries;
//   alter publication supabase_realtime add table card_resolutions;
//   alter table collections enable row level security;
//   alter table entries enable row level security;
//   alter table card_resolutions enable row level security;
//   create policy "vault read"  on collections for select using (true);
//   create policy "vault write" on collections for all using (true);
//   create policy "vault read e"  on entries for select using (true);
//   create policy "vault write e" on entries for all using (true);
//   create policy "vault read r"  on card_resolutions for select using (true);
//   create policy "vault write r" on card_resolutions for all using (true);
//
//   -- Append-only log of buys and sells. Each entry creation writes a 'buy'
//   -- transaction; each sale writes a 'sell' and deletes the entry.
//   create table transactions (
//     id uuid primary key default gen_random_uuid(),
//     vault_key text not null,
//     collection_id uuid,
//     card_id text,
//     card_display_name text,
//     type text not null,
//     amount numeric default 0,
//     contributions jsonb default '[]',
//     occurred_at date,
//     notes text,
//     created_at timestamptz default now()
//   );
//   create index on transactions (vault_key);
//   alter publication supabase_realtime add table transactions;
//   alter table transactions enable row level security;
//   create policy "vault read t"  on transactions for select using (true);
//   create policy "vault write t" on transactions for all using (true);
//
//   -- Cards on watch — scraper integration populates the last_seen_* fields.
//   create table watchlist (
//     id uuid primary key default gen_random_uuid(),
//     vault_key text not null,
//     card_id text not null,
//     card_display_name text,
//     target_price numeric,
//     notes text,
//     last_checked_at timestamptz,
//     last_seen_url text,
//     last_seen_price numeric default 0,
//     last_seen_source text,
//     created_at timestamptz default now()
//   );
//   create index on watchlist (vault_key);
//   alter publication supabase_realtime add table watchlist;
//   alter table watchlist enable row level security;
//   create policy "vault read w"  on watchlist for select using (true);
//   create policy "vault write w" on watchlist for all using (true);
//
// (You can tighten policies later if you want.)

const shared = {
  async list(table) {
    const { data, error } = await supa.from(table).select('*').eq('vault_key', VAULT_KEY);
    if (error) { console.error(error); return []; }
    return data || [];
  },
  async insert(table, row) {
    const payload = { ...row, vault_key: VAULT_KEY };
    delete payload.id;
    const { data, error } = await supa.from(table).insert(payload).select().single();
    if (error) { console.error(error); return null; }
    return data;
  },
  async update(table, id, patch) {
    const { data, error } = await supa.from(table).update(patch).eq('id', id).select().single();
    if (error) { console.error(error); return null; }
    return data;
  },
  async remove(table, id) {
    const { error } = await supa.from(table).delete().eq('id', id);
    if (error) console.error(error);
  },
  async removeWhere(table, predicate) {
    // For simplicity, we re-fetch and delete by id list
    const rows = await shared.list(table);
    const ids = rows.filter(predicate).map(r => r.id);
    if (ids.length === 0) return;
    const { error } = await supa.from(table).delete().in('id', ids);
    if (error) console.error(error);
  },
  subscribe(table, callback) {
    const channel = supa
      .channel(`changes:${table}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table, filter: `vault_key=eq.${VAULT_KEY}` },
        () => callback()
      )
      .subscribe();
    return () => supa.removeChannel(channel);
  },
  async listResolutions() {
    // PostgREST caps a single select at the project's max-rows (1000 by
    // default). A full catalog easily exceeds that, so page through with
    // .range() until a short page signals the end — otherwise only the first
    // 1000 resolutions hydrate and the rest re-resolve on every refresh.
    const PAGE = 1000;
    const all = [];
    let from = 0;
    for (;;) {
      const { data, error } = await supa
        .from('card_resolutions')
        .select('card_id, tcg_id, snapshot')
        .eq('vault_key', VAULT_KEY)
        .range(from, from + PAGE - 1);
      if (error) { console.error('listResolutions failed', error); break; }
      if (!data || data.length === 0) break;
      all.push(...data);
      from += data.length;
      if (data.length < PAGE) break;
    }
    return all;
  },
  async upsertResolution(cardId, payload) {
    const { error } = await supa
      .from('card_resolutions')
      .upsert(
        { vault_key: VAULT_KEY, card_id: cardId, updated_at: new Date().toISOString(), ...payload },
        { onConflict: 'vault_key,card_id' }
      );
    if (error) console.error('upsertResolution failed', error);
    return !error;
  },
  async deleteAllResolutions() {
    const { error, count } = await supa
      .from('card_resolutions')
      .delete({ count: 'exact' })
      .eq('vault_key', VAULT_KEY);
    if (error) { console.error('deleteAllResolutions failed', error); return 0; }
    return count || 0;
  },
  subscribeResolutions(callback) {
    const channel = supa
      .channel('changes:card_resolutions')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'card_resolutions', filter: `vault_key=eq.${VAULT_KEY}` },
        (payload) => callback(payload)
      )
      .subscribe();
    return () => supa.removeChannel(channel);
  },
};

export const store = isShared ? shared : solo;
export const VAULT_LABEL = VAULT_KEY;
