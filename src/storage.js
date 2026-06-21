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

// Global reference tables in the normalized schema have NO vault_key column —
// they're shared across all vaults. The generic list/insert/subscribe paths
// below must skip the vault_key filter/injection for these, or PostgREST errors
// with "column vault_key does not exist".
const GLOBAL_TABLES = new Set(['tcgs', 'grades', 'sets', 'cards', 'card_variants', 'sales']);

// Last failing storage call's error details (Supabase code/message/details/hint
// plus table). Exposed so UI handlers can surface a specific message — e.g.
// "column foo doesn't exist" — instead of pointing the user at the console.
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
  // Card resolutions: no remote in solo mode — caller relies on localStorage caches.
  async listResolutions() { return []; },
  async upsertResolution() { /* no-op */ },
  async deleteAllResolutions() { return 0; },
  subscribeResolutions() { return () => {}; },
};

// ----- Shared (Supabase) -----
//
// ⚠️  NORMALIZED SCHEMA (2026-06): the app now uses the normalized schema —
// collections, collected_cards, contributions, transactions,
// transaction_contributions, sales, card_nicknames (vault-scoped) plus the
// GLOBAL reference tables tcgs, grades, sets, cards, card_variants (no
// vault_key — see GLOBAL_TABLES above). The authoritative DDL + migration live
// in db/redesign/schema.sql and db/redesign/migrate_apply.sql. App.jsx reshapes
// these tables to/from the legacy in-memory shapes at the data-access boundary.
// The legacy table definitions below are retained for historical reference; the
// original rows are preserved in the legacy_* tables as a backup.
//
// Legacy (pre-normalization) — expected tables: collections, entries,
// card_resolutions (each with vault_key column + id uuid pk).
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
//
//   -- entries gains psa_spec_id + graded_price_source + graded_price_fetched_at
//   -- for the graded-pricing pipeline (PSA APR Stage 1, eBay sold Stage 2).
//   --   psa_spec_id text                 // PSA SpecID from the cert lookup;
//   --                                    // used as the key for PSA APR refresh.
//   --   graded_price_source text         // 'manual' | 'psa-apr' | 'ebay-sold' | 'sales-log'
//   --   graded_price_fetched_at timestamptz
//   --                                    // when the auto-fetched value was set;
//   --                                    // refresh skips entries whose source
//   --                                    // is 'manual' (preserves user overrides).
//   --   alter table entries add column if not exists psa_spec_id text;
//   --   alter table entries add column if not exists graded_price_source text;
//   --   alter table entries add column if not exists graded_price_fetched_at timestamptz;
//   --   notify pgrst, 'reload schema';
//
//   -- sales — observed market sales the user logs as they spot them in the
//   -- wild (eBay, Whatnot, Discord listings, TCGPlayer marketplace, etc.).
//   -- The user's own portfolio sells live in `transactions(type='sell')`; this
//   -- is a separate, arms-length dataset that feeds the graded-pricing
//   -- estimator.
//   --
//   -- Estimator: median of `sales` matching (card_id, grading_company, grade)
//   -- within a recency window. Refresh-graded-prices reads this table only —
//   -- no external API dependency. Future automated sources (eBay API, scrapes,
//   -- etc.) write rows here with `source != 'manual'`; the estimator doesn't
//   -- care where data came from.
//   --
//   --   create table sales (
//   --     id uuid primary key default gen_random_uuid(),
//   --     vault_key text not null,
//   --     created_at timestamptz default now(),
//   --     card_id text not null,
//   --     grading_company text,
//   --     grade numeric,
//   --     bgs_black boolean default false,
//   --     cert_number text,
//   --     sale_date date not null,
//   --     sale_price numeric not null,
//   --     currency text default 'USD',
//   --     marketplace text not null,
//   --     listing_url text,
//   --     listing_title text,
//   --     notes text,
//   --     source text default 'manual'
//   --   );
//   --   create index on sales (vault_key);
//   --   create index on sales (vault_key, card_id, grading_company, grade);
//   --   alter publication supabase_realtime add table sales;
//   --   alter table sales enable row level security;
//   --   create policy "vault read sales"  on sales for select using (true);
//   --   create policy "vault write sales" on sales for all using (true);
//   --   notify pgrst, 'reload schema';
//
//   -- One additional constraint needed by the Chrome extension's 130point
//   -- sync (extension/) — it upserts on (vault_key, listing_url) so resyncs
//   -- don't write duplicate rows:
//   --   alter table sales
//   --     add constraint sales_vault_key_listing_url_unique
//   --     unique (vault_key, listing_url);
//   --   notify pgrst, 'reload schema';
//
//   -- card_aliases — user-defined nicknames the sale matcher uses to
//   -- identify a card from a listing title that has no parseable card-ID
//   -- (e.g. "LA Dodgers Luffy 2025 Promo PSA 10"). Each alias is tied to a
//   -- specific canonical card_id; the matcher uses the longest matching
//   -- alias substring in a title to pick the card.
//   --
//   --   create table card_aliases (
//   --     id uuid primary key default gen_random_uuid(),
//   --     vault_key text not null,
//   --     card_id text not null,
//   --     alias text not null,
//   --     created_at timestamptz default now()
//   --   );
//   --   create index on card_aliases (vault_key);
//   --   create index on card_aliases (vault_key, lower(alias));
//   --   alter table card_aliases
//   --     add constraint card_aliases_vault_card_alias_unique
//   --     unique (vault_key, card_id, alias);
//   --   alter publication supabase_realtime add table card_aliases;
//   --   alter table card_aliases enable row level security;
//   --   create policy "vault read aliases"  on card_aliases for select using (true);
//   --   create policy "vault write aliases" on card_aliases for all using (true);
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
    let query = supa.from(table).select('*');
    if (!GLOBAL_TABLES.has(table)) query = query.eq('vault_key', VAULT_KEY);
    const { data, error } = await query;
    if (error) { console.error(error); return []; }
    return data || [];
  },
  async insert(table, row) {
    const payload = GLOBAL_TABLES.has(table) ? { ...row } : { ...row, vault_key: VAULT_KEY };
    delete payload.id;
    const { data, error } = await supa.from(table).insert(payload).select().single();
    if (error) {
      console.error('[storage] insert failed', { table, error });
      // Hang the error off the returned null so callers can show the user
      // a specific message ("column X not found" etc.) instead of pointing
      // them at the console.
      lastStoreError = { code: error.code, message: error.message, table, details: error.details, hint: error.hint };
      return null;
    }
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
    // Global tables have no vault_key, so don't filter on it.
    const opts = GLOBAL_TABLES.has(table)
      ? { event: '*', schema: 'public', table }
      : { event: '*', schema: 'public', table, filter: `vault_key=eq.${VAULT_KEY}` };
    const channel = supa
      .channel(`changes:${table}`)
      .on('postgres_changes', opts, () => callback())
      .subscribe();
    return () => supa.removeChannel(channel);
  },
  // Card-resolution layer is retired in the normalized schema (the old
  // card_resolutions table is now legacy_card_resolutions and no longer read).
  // These are no-ops so the vestigial migration/pricing callers don't error.
  async listResolutions() { return []; },
  async upsertResolution() { return true; },
  async deleteAllResolutions() { return 0; },
  subscribeResolutions() { return () => {}; },
};

export const store = isShared ? shared : solo;
export const VAULT_LABEL = VAULT_KEY;
