# Supabase Schema Redesign — Migration & Design Plan

Companion to [`schema.sql`](./schema.sql). **Status: design, not yet applied.**
The app still runs on the legacy flat schema documented in `src/storage.js`.

## Context

The current Supabase is a flat set of `vault_key`-partitioned tables
(`collections`, `entries`, `transactions`, `sales`, `watchlist`,
`card_resolutions`). The catalog (sets + cards) is **not** in Supabase — it's
built live in the browser from the TCGCSV/TCGPlayer feed and cached in
`localStorage`. Grades are three inline columns (`grading_company` + `grade` +
`bgs_black`). A sale **deletes** the owned-card row. The app is One Piece-only.

This redesign normalizes everything into relational tables that (a) genuinely
support multiple TCGs, (b) store the catalog as first-class tables populated
from a per-TCG **source URL**, (c) keep `vault_key` for now but split GLOBAL
reference data from VAULT-scoped user data as the future multi-tenancy/paywall
seam, and (d) treat observed market Sales as shared reference data.

**Scope of this deliverable:** the SQL DDL + the old→new transformation plan.
Rewiring the app code and building the ingestion worker are explicit follow-ups
(see Out of scope).

## Confirmed decisions

- Multi-TCG: schema is game-agnostic (One Piece + Pokémon + future).
- Catalog: a per-TCG `source` URL drives an ingestion process populating Sets +
  Cards. Contract designed here; full build is follow-up.
- Partitioning: keep `vault_key` on user tables now; GLOBAL reference tables
  carry no `vault_key`. This is the future multi-tenancy / paywall seam.
- Sales: GLOBAL shared reference data.
- Pay-split / contributions: normalized into child tables.
- Lifecycle: a sale no longer deletes the owned-card row — it sets `date_sold`
  / `sold_price`. Cards become long-lived rows.

## GLOBAL vs VAULT split

| GLOBAL (no `vault_key`) | VAULT (`vault_key` now, `tenant_id` later) |
|---|---|
| `tcgs`, `grades`, `sets`, `cards`, `card_variants`, `sales` | `collections`, `collected_cards`, `contributions`, `transactions`, `transaction_contributions`, `card_nicknames` |

GLOBAL tables are identical for everyone and become the paywall/read-gating
layer; VAULT tables migrate `vault_key → tenant_id` later with no structural
change.

## Key identity choice

`card_code` (PK of `cards`) **is** today's canonical `card_id` string, which is
already stored in `entries.card_id`, `transactions.card_id`, `sales.card_id`,
and `card_aliases.card_id`. So migrating those FKs is a rename, not a re-key.
`serial` (= `displayId`, e.g. `OP14-118`) stays non-unique; `card_code`
disambiguates via the same `sourceSet:` prefix + `-<attributeTag>` +
`-<external_id>` collision logic `catalog.js` already emits.

## Resolved design questions

- **image** → URL (`cards.image_url`), not blob.
- **serial non-unique** → handled by `card_code` (see Key identity choice).
- **traits** → sparse `jsonb` + GIN index (TCGCSV gives no game data today;
  forward-compatible and game-agnostic).
- **nicknames** → VAULT table `card_nicknames` (1 card → many); maps 1:1 from
  `card_aliases`. Can't be an array on the GLOBAL `cards` row (nicknames are
  vault-scoped).
- **variants** → GLOBAL `card_variants` registry + the `attribute_tag` already
  encoded in `card_code`. A parallel is a distinct printing with its own
  `card_code`. Pre-errata twins are real `cards` rows with
  `attribute_tag='pre-errata'`.
- **grades** → keyed by `grade_code`; `grade_value` is **text** (`'10'`,
  `'9.5'`, `'Black Label'`) so Black Label is just a value (no `bgs_black`
  flag); nullable `description` holds each company's grade definition (blank for
  now, fillable later). No `'GEM MT 10'`-style label.
- **lifecycle** → keep the `collected_cards` row on sale; set `date_sold` /
  `sold_price`. "Still owned" becomes `date_sold IS NULL`; `sell` transactions
  point at a live row.
- **pay-split** → normalized `contributions` / `transaction_contributions`;
  signed convention preserved.
- **collections** → `collected_cards.collection_id` references
  `collections.id` (not name) so renames don't re-home cards.
- **transactions** → keep full `buy|sell|transfer|expense|payout` vocabulary;
  pool-level expenses/payouts leave `collected_card_id` NULL.

## Old → New migration mapping

Runs **server-side, once** (deriving sets/cards needs the catalog). Order:
seed `grades` → ingest catalog (`sets`+`cards`) → `entries`→`collected_cards`
→ `transactions` → `sales` → aliases/variants.

| Current | New | Transform |
|---|---|---|
| *(new)* | `tcgs` | Seed `('OP','One Piece Card Game','Bandai',<tcgcsv url>,'tcgcsv','{"categoryId":68}')`; `release_date` = game launch when known, else NULL. |
| *(new)* | `grades` | **Seed first.** Distinct `(grading_company,grade,bgs_black)` across `entries`+`sales` + a `'RAW'` row → `grade_code` + `grade_value` (text; `bgs_black=true`→`'Black Label'`). Leave `description` NULL. |
| *(catalog in browser)* | `sets`,`cards` | Run ingestion (below); then ensure every referenced `card_id` exists, synthesizing minimal rows for orphans (pre-errata twins, retired products) by parsing `card_code`. |
| `card_resolutions` | `cards.external_id/image_url/...` | Use `tcg_id`→product as the bridge to fill catalog fields, then **drop** the table. |
| `entries.*` | `collected_cards.*` | Renames (`card_id→card_code`, `purchase_price→price_paid`, `notes→acquisition_notes`, `acquired_at→date_acquired`). |
| `entries.grading_company/grade/bgs_black` | `collected_cards.grade_code` | Collapse 3 cols → `grade_code` FK via seeded `grades`. `bgs_black=true→'BGS BL'` (grade_value `'Black Label'`); NULL company → `'RAW'`/NULL. |
| `entries.contributions jsonb` | `contributions` rows | Explode `[{member,amount}]` → one positive-stake row each. |
| **deleted (sold) entries** | `collected_cards` + tx | Reconstruct from `transactions(type=sell, entry_id)`: set `date_sold`/`sold_price`/`card_code`, recover `price_paid` from the matching `buy` tx; flag `price_paid=0` for review when unrecoverable. |
| `transactions.*` | `transactions.*` | Renames; `entry_id (text)`→`collected_card_id (uuid)`; explode `contributions`→`transaction_contributions` **preserving signs**. |
| `sales.*` | `sales.*` (GLOBAL) | `card_id→card_code`, `marketplace→listing_site`, grade cols→`grade_code`; add `sale_type/post_date/num_bids/description` (NULL legacy); drop `vault_key` into `ingested_by_vault`; de-dupe on `(source,listing_url)`. |
| `card_aliases` | `card_nicknames` | Rename `card_id→card_code`, `alias→nickname`. |
| `printing-attributes.js` builtins + localStorage user variants | `card_variants` | Seed builtins; one-time client push of user variants. |
| `watchlist` | (defer) | Out of scope; rename + FK when next touched. |

## Ingestion strategy (per-TCG `source` → sets + cards)

- **Contract:** each `tcgs` row carries `source_url` + `source_kind` +
  `source_config`. A worker dispatches on `source_kind`:
  - `tcgcsv` (One Piece today): reuse `api/tcgcsv.js`; parameterize the
    hardcoded `categoryId` (68) from `source_config` — that single change makes
    the proxy multi-TCG. Crawl groups → products → upsert `sets`/`cards`.
  - `custom`: per-TCG adapter for games not on TCGCSV.
- **Where:** a Vercel function (`api/ingest.js`) or scheduled job invoked with
  `service_role` (GLOBAL tables must not be anon-writable).
- **Identity:** lift `canonicalIdOf` + `finalizeCanonicalIds` from
  `src/catalog.js` into a shared module so server and browser compute identical
  `card_code`s.
- **Idempotency:** upsert on natural codes — `on conflict (set_code)` /
  `on conflict (card_code) do update` refreshing only mutable fields.

## Critical files (for the follow-up implementation)

- `src/catalog.js` — `canonicalIdOf` / `finalizeCanonicalIds` define
  `card_code`; lift server-side for ingestion.
- `src/storage.js` — current DDL-in-comments + the data-access layer to replace.
- `src/migrate.js` — template for the old→new bridge logic.
- `api/tcgcsv.js` — ingestion source; parameterize the category id.
- `src/printing-attributes.js` — variant registry → `card_variants` seed.

## Risks / decisions to track

- **R1 `card_code` stability:** the `-<external_id>` collision suffix is only
  added when a collision exists in a crawl; a future TCGPlayer add/remove could
  flip a previously-suffixed code and break FKs. Mitigate: persist a
  "needs_suffix" flag (or always suffix known-ambiguous serials).
- **R4 sold-inventory reconstruction** depends on reliable `entry_id` links on
  sell txs; expect some `price_paid=0` rows needing review — quantify orphans
  before migrating.
- **R5 dirty grade data:** legacy `grading_company` is free text — normalize
  aggressively when seeding `grades`; map any `bgs_black=true` row to
  `grade_value='Black Label'` regardless of its stored numeric `grade`.
- **R6 RLS for GLOBAL tables:** move from `using(true)` to read-open /
  write-`service_role` so anon clients can't corrupt shared catalog/sales.
- **R7 cross-game `card_code` collisions:** structurally fine
  (`cards.set_code→tcg_code`); consider a `tcg_code` prefix once a second TCG
  is ingested.

## Verification

This ships SQL + a migration plan, not running app code. Validate by:

1. **Apply DDL to a scratch Supabase project** (or local `supabase start` /
   `psql`): run `schema.sql` top-to-bottom; confirm all FKs, unique
   constraints, and indexes create without error.
2. **Seed + dry-run the transform** against a copy of current production data
   inside a transaction; `ROLLBACK` and inspect row counts / flagged rows.
3. **Spot-check invariants:** every `collected_cards.card_code` resolves to a
   `cards` row; sold rows have `date_sold` + a paired `sell` transaction;
   contribution sign sums match the pre-migration jsonb sums per member;
   `(source,listing_url)` unique in `sales`.
4. **Card identity parity:** server-lifted `canonicalIdOf` produces `card_code`s
   identical to the browser for a sample of products.

## Out of scope (explicit follow-ups)

- Rewiring `storage.js` / `App.jsx` / `catalog.js` to the new schema.
- Building the `api/ingest.js` worker and scheduling.
- Real multi-tenancy (`tenant_id`), Supabase Auth, paywall RLS — the schema is
  structured for these but they are not built here.
