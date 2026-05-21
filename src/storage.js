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
//     created_at timestamptz default now()
//   );
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
//   -- Resolved PriceCharting variant + price snapshot per OPTCG card.
//   -- One row per (vault_key, card_id) so picks dedup across the team.
//   create table card_resolutions (
//     id uuid primary key default gen_random_uuid(),
//     vault_key text not null,
//     card_id text not null,
//     pc_product_id text,
//     pc_product_name text,
//     pc_console text,
//     tcg_id text,
//     snapshot jsonb,
//     updated_at timestamptz default now(),
//     unique (vault_key, card_id)
//   );
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
    const { data, error } = await supa
      .from('card_resolutions')
      .select('card_id, pc_product_id, pc_product_name, pc_console, tcg_id, snapshot')
      .eq('vault_key', VAULT_KEY);
    if (error) { console.error('listResolutions failed', error); return []; }
    return data || [];
  },
  async upsertResolution(cardId, payload) {
    const { error } = await supa
      .from('card_resolutions')
      .upsert(
        { vault_key: VAULT_KEY, card_id: cardId, updated_at: new Date().toISOString(), ...payload },
        { onConflict: 'vault_key,card_id' }
      );
    if (error) console.error('upsertResolution failed', error);
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
