-- ============================================================================
-- OPTCG-Ledger — Normalized, multi-TCG, multi-tenant-ready Supabase schema
-- ============================================================================
-- STATUS: DESIGN / NOT YET APPLIED. This is the target schema for the planned
-- Supabase redesign. The app code (src/storage.js, src/App.jsx, src/catalog.js)
-- still reads/writes the LEGACY flat schema documented in src/storage.js. Wiring
-- the app to this schema, and building the ingestion worker, are follow-ups.
--
-- See db/redesign/MIGRATION.md for the old->new data-transformation plan,
-- ingestion strategy, design rationale, and risks.
--
-- Key design choices:
--   * Natural text codes (tcg_code, grade_code, set_code, card_code) are the PKs
--     of GLOBAL reference tables -- card_code IS today's canonical card_id, so
--     existing FK values carry over unchanged.
--   * uuid surrogate PKs for high-churn TENANT rows.
--   * GLOBAL reference tables carry NO vault_key (shared by everyone); VAULT
--     tables carry vault_key now and migrate to tenant_id later. This split is
--     the future multi-tenancy / paywall seam.
-- ============================================================================


-- ============================================================================
-- GLOBAL REFERENCE TABLES  (no vault_key -- shared across all tenants)
-- ============================================================================

-- 1. TCGs --------------------------------------------------------------------
create table tcgs (
  tcg_code      text primary key,                    -- 'OP','PKMN'
  name          text not null,                        -- 'One Piece Card Game'
  creator       text,                                 -- 'Bandai','Nintendo'
  source_url    text,                                 -- ingest root for sets+cards
  source_kind   text not null default 'tcgcsv',       -- 'tcgcsv' | 'custom'
  source_config jsonb not null default '{}'::jsonb,   -- e.g. {"categoryId":68}
  release_date  date,                                 -- when the TCG itself launched
  date_added    timestamptz not null default now()    -- when this row was created
);

-- 2. Grades ------------------------------------------------------------------
-- grade_code is the composite the app already wants. grade_value is TEXT so
-- 'Black Label' is just another value alongside '10'/'9.5' (no is_black_label
-- flag). description holds each company's own definition of the grade -- left
-- blank for now, fillable later. No 'GEM MT 10'-style label column.
create table grades (
  grade_code        text primary key,    -- 'PSA 10','BGS 9.5','BGS BL','RAW'
  company           text,                 -- NULL for RAW
  company_nickname  text,                 -- 'PSA','BGS','CGC'; NULL for RAW
  grade_value       text,                 -- '10','9.5','Black Label'; NULL for RAW
  description       text,                 -- company's grade definition; nullable
  sort_rank         int
);
create index on grades (company_nickname, sort_rank);

-- 3. Sets --------------------------------------------------------------------
create table sets (
  set_code        text primary key,                  -- 'OP14','OP14RE','ST29'
  tcg_code        text not null references tcgs(tcg_code) on delete cascade,
  name            text,                               -- 'OP14: Azure Seven Seas'
  release_date    date,
  source_group_id text,                               -- TCGPlayer groupId (provenance)
  sort_bucket     int,                                -- mirrors catalog.js set bucketing
  created_at      timestamptz not null default now()
);
create index on sets (tcg_code);

-- 4. Cards -------------------------------------------------------------------
-- card_code == today's canonical card_id string:
--   [<sourceSet>:]<displayId>[-<attributeTag>][-<external_id collision suffix>]
--   e.g. 'OP14-118', 'OP14-118-parallel', 'OP14RE:OP14-118'
-- serial (= displayId) is intentionally NON-unique across parallels; card_code
-- disambiguates exactly as catalog.js canonicalIdOf/finalizeCanonicalIds do.
create table cards (
  card_code     text primary key,
  set_code      text not null references sets(set_code) on delete cascade,
  serial        text not null,                        -- displayId, NON-unique
  name          text,                                 -- cleaned game name
  full_name     text,                                 -- TCGPlayer sales name w/ variant labels
  image_url     text,                                 -- URL, not blob
  rarity        text,
  traits        jsonb not null default '{}'::jsonb,   -- sparse {supertype,color,cost,...}
  attribute_tag text,                                 -- ''|'parallel'|'manga-parallel'|'pre-errata'
  external_id   text,                                 -- TCGPlayer tcg_id (pricing/ingest bridge)
  source        text not null default 'tcgplayer',
  created_at    timestamptz not null default now()
);
create index on cards (set_code);
create index on cards (serial);
create index on cards (external_id);
create index on cards using gin (traits);

-- 4b. Card variants registry (replaces printing-attributes.js) ---------------
create table card_variants (
  variant_key  text primary key,                      -- 'parallel','manga','pre-errata'
  label        text not null,
  detect_regex text,                                  -- catalog-name regex (value)
  sale_regex   text,                                  -- listing-title regex (saleValue)
  is_builtin   boolean not null default false,
  tcg_code     text references tcgs(tcg_code) on delete cascade  -- NULL = all TCGs
);

-- 5. Sales (GLOBAL shared comps) ---------------------------------------------
-- Observed arms-length market sales feeding the graded-price estimator.
-- card_code/grade_code nullable: a freshly-scraped listing may not yet resolve.
create table sales (
  id                uuid primary key default gen_random_uuid(),
  card_code         text references cards(card_code) on delete set null,
  grade_code        text references grades(grade_code) on delete set null,
  cert_number       text,
  listing_site      text not null,                    -- 'eBay','Fanatics Collect','Alt'
  listing_url       text,
  listing_title     text,
  sale_date         date not null,
  sale_price        numeric not null,
  currency          text not null default 'USD',
  sale_type         text,                             -- 'auction'|'buy-it-now'
  post_date         date,
  num_bids          int,
  description       text,
  source            text not null default 'manual',   -- 'manual'|'130point-scrape'
  ingested_by_vault text,                             -- provenance/audit only
  created_at        timestamptz not null default now(),
  unique (source, listing_url)
);
create index on sales (card_code, grade_code, sale_date desc);  -- estimator group-by
create index on sales (sale_date desc);


-- ============================================================================
-- VAULT-SCOPED TABLES  (vault_key now; tenant_id later)
-- ============================================================================

-- 6. Collections -------------------------------------------------------------
create table collections (
  id         uuid primary key default gen_random_uuid(),
  vault_key  text not null,
  name       text not null,
  tcg_code   text references tcgs(tcg_code),          -- optional default game
  members    jsonb not null default '[]'::jsonb,      -- member-name strings (kept as-is)
  created_at timestamptz not null default now(),
  unique (vault_key, name)
);
create index on collections (vault_key);

-- 6b. Collected cards (owned inventory; long-lived -- NOT deleted on sale) ----
create table collected_cards (
  id                      uuid primary key default gen_random_uuid(),
  vault_key               text not null,
  collection_id           uuid references collections(id) on delete cascade,
  card_code               text not null references cards(card_code),
  grade_code              text references grades(grade_code),  -- NULL/'RAW' if ungraded
  cert_number             text,
  condition               text,
  owner_name              text,
  price_paid              numeric not null default 0,
  acquisition_notes       text,
  date_acquired           date,
  date_sold               date,                       -- NULL = still owned
  sold_price              numeric,
  graded_price            numeric,
  graded_price_source     text,
  graded_price_fetched_at timestamptz,
  grade_description        text,
  psa_spec_id              text,
  added_at                timestamptz not null default now(),
  created_at              timestamptz not null default now()
);
create index on collected_cards (vault_key);
create index on collected_cards (vault_key, collection_id);
create index on collected_cards (card_code);
create index on collected_cards (vault_key, date_sold);

-- 6c. Contributions (pay-split, normalized) ----------------------------------
create table contributions (
  id                uuid primary key default gen_random_uuid(),
  vault_key         text not null,
  collected_card_id uuid not null references collected_cards(id) on delete cascade,
  member_name       text not null,
  amount            numeric not null,                 -- positive stake
  created_at        timestamptz not null default now()
);
create index on contributions (vault_key);
create index on contributions (collected_card_id);

-- 7. Transactions (money ledger) ---------------------------------------------
create table transactions (
  id                uuid primary key default gen_random_uuid(),
  vault_key         text not null,
  collection_id     uuid references collections(id) on delete set null,
  collected_card_id uuid references collected_cards(id) on delete set null,  -- nullable
  card_code         text references cards(card_code),
  card_display_name text,                             -- snapshot label
  type              text not null,                    -- buy|sell|transfer|expense|payout
  amount            numeric not null default 0,
  occurred_at       date,
  notes             text,
  created_at        timestamptz not null default now()
);
create index on transactions (vault_key);
create index on transactions (collected_card_id);
create index on transactions (vault_key, type);

-- 7b. Transaction contributions (signed splits per tx) -----------------------
create table transaction_contributions (
  id             uuid primary key default gen_random_uuid(),
  vault_key      text not null,
  transaction_id uuid not null references transactions(id) on delete cascade,
  member_name    text not null,
  amount         numeric not null,                    -- SIGNED by transaction.type
  created_at     timestamptz not null default now()
);
create index on transaction_contributions (transaction_id);

-- 8. Card nicknames (VAULT-scoped; replaces card_aliases) --------------------
create table card_nicknames (
  id         uuid primary key default gen_random_uuid(),
  vault_key  text not null,
  card_code  text not null references cards(card_code) on delete cascade,
  nickname   text not null,
  created_at timestamptz not null default now(),
  unique (vault_key, card_code, nickname)
);
create index on card_nicknames (vault_key, lower(nickname));

-- ============================================================================
-- RLS: enable on every table. Start permissive (using (true)) to match the
-- legacy schema, then tighten GLOBAL reference + sales to read-open /
-- write-service_role (the paywall seam). Policies intentionally omitted here.
-- ============================================================================
