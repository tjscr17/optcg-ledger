# Handoff — Supabase normalization + app rewire

Status snapshot for picking this up in a new conversation. Branch:
**`claude/enter-plan-mode-6cf3c6`**. Supabase project: `optcg-ledger`
(`ajpxzfhmyzzgarewijnr`).

---

## Goal

Redesign the flat, `vault_key`-partitioned Supabase schema into a normalized,
multi-TCG, multi-tenant-ready schema, migrate the live data into it, and rewire
the app to use it.

---

## ✅ Done

### 1. Schema design (committed)
- `db/redesign/schema.sql` — full normalized DDL (12 tables), validated against
  Postgres 16.
- `db/redesign/MIGRATION.md` — old→new mapping, ingestion strategy, GLOBAL/VAULT
  multi-tenancy split, risks, verification.

**Model decisions baked in:**
- **GLOBAL reference tables** (no `vault_key`, shared by all): `tcgs`, `grades`,
  `sets`, `cards`, `card_variants`, `sales`.
- **VAULT tables** (`vault_key` now, `tenant_id` later): `collections`,
  `collected_cards`, `contributions`, `transactions`,
  `transaction_contributions`, `card_nicknames`.
- Natural-code PKs for reference data; `card_code` **is** the app's canonical
  card id (so existing FK values carried over unchanged).
- Grades: `grade_code` ('PSA 10', 'BGS BL', 'RAW'); **Black Label is
  `grade = 'BL'`**, no `bgs_black` flag.
- Sold cards retained as rows (`date_sold`/`sold_price`), not deleted.
- Contributions normalized into child tables.

### 2. Migration APPLIED to production (committed)
- `db/redesign/migrate_apply.sql` — the exact atomic migration that ran
  (Supabase migration name `normalize_schema_redesign`).
- Renamed legacy tables to `legacy_*` (retained as backup — **not dropped**),
  built the new schema, seeded `tcgs`/`grades`, synthesized `sets`/`cards` from
  referenced ids via an in-SQL card-id parser, mapped `entries`→
  `collected_cards` (incl. **reconstructing 7 deleted sold cards** from buy/sell
  tx pairs), normalized contributions, remapped transactions, migrated 3,748
  sales, `card_aliases`→`card_nicknames`.
- **Verified post-apply:** collected_cards=42 (35 owned + 7 sold),
  transactions=60, sales=3,748, grades=15, cards=119, sets=19; **0 orphan FKs**;
  contribution sums reconciled. Cost basis $134,690 / proceeds $35,688.

**All legacy data migrated** except `card_resolutions` (3 rows, intentionally
not carried — vestigial). `watchlist`/`catalog_snapshot` were empty. Originals
remain in `legacy_*`.

### 3. App rewire (committed, **builds green**, NOT yet live-verified)
- `src/grades.js` (new): `fieldsToGradeCode` / `gradeCodeToFields` /
  `ensureGrade`.
- `src/storage.js`: `GLOBAL_TABLES` skip `vault_key` filter/injection; retired
  `card_resolutions` methods; schema comment updated.
- `src/App.jsx`: `refreshData` loads the new tables and **reshapes them into the
  legacy in-memory shapes** (reconstituting `contributions[]` from child tables)
  so the equity engine / display / matcher / estimator are unchanged. Write
  paths decompose to the new tables; `ensureCard`/`ensureGrade` materialize
  global rows so FKs resolve; **sell is now a soft-sell**; `bgs_black` replaced
  by grade `'BL'`; **Watch tab hidden**.
- `src/card-aliases.js`: targets `card_nicknames(card_code, nickname)`.

Commits on the branch: schema docs → applied migration → app rewire.

---

## ⛔ Not done / pending

### A. DB-side verification — ✅ DONE (2026-06-21)
Ran the full verification suite against live Supabase (`ajpxzfhmyzzgarewijnr`).
All data-integrity checks pass:
- **collected_cards = 42** (35 owned + 7 sold) ✓
- BGS Black Label card `OPPR:ST01-006-504476` → `grade_code='BGS BL'`,
  derives `'BL'` ✓
- **transactions = 60**; type breakdown reconciles **exactly** vs `legacy_*`:
  buy 42/$134,226.80, expense 11/$5,827.71, sell 7/$35,688.00 ✓
- **sales = 3,748**, cards = 119, sets = 19, collections = 3,
  contributions = 43, transaction_contributions = 56, card_nicknames = 3 ✓
- **0 orphan FKs** across all 9 foreign-key relationships ✓
- **Contributions reconcile**: tx-contribs new = legacy = $143,842.70;
  owned-card contribs new = legacy = $107,338.99 (the all-42 gap is the 7
  reconstructed sold cards, as expected) ✓
- **Cost basis** (all 42) = $134,689.90; owned-35 price_paid new = legacy =
  $111,338.94 ✓
- `npm run build` green.

> Browser-observable smoke test (running `npm run dev` against `.env.local`)
> was not performed — no `.env.local` in this environment. The data layer the
> app reads is verified correct above; remaining check is purely UI-render.

### B. One-time grades cosmetic fix — ✅ DONE / no-op (2026-06-21)
```sql
update grades set grade_value = 'BL' where grade_code = 'BGS BL';
```
Ran; **0 rows changed** — the `BGS BL` grade already carried
`grade_value = 'BL'` from the seed. Confirmed in `grades`. Non-blocking
anyway (app derives `'BL'` from `grade_code`, never reads `grade_value`).

### C. Known follow-ups (flagged, not addressed)
1. **Search "watch" toggle** still renders but no-ops (Watch tab hidden). Either
   remove the toggle from `SearchView` or re-add a `watchlist` table.
2. **`src/migrate.js`** one-time boot migrations still reference old
   `entries`/`watchlist`/`card_resolutions` tables. Gated by localStorage flags
   so existing browsers skip them; a fresh browser logs harmless console errors.
   Consider neutralizing.
3. **Chrome extension** (`extension/`) still writes the OLD `sales` shape
   (`card_id`, `marketplace`, `grade`, `bgs_black`) → now broken. Needs updating
   to `card_code`/`grade_code`/`listing_site` (and it writes to a GLOBAL table
   now — no `vault_key`).
4. **Full catalog ingestion** into `cards`/`sets` — only the ~119 referenced
   cards exist; the rest of the ~5000-card catalog is still browser-only.
   Per-TCG `source`-driven ingestion worker is designed (MIGRATION.md) but not
   built. `cards.image_url/name/rarity` are sparse (could backfill from
   `legacy_card_resolutions.snapshot`).
5. **Drop `legacy_*` tables** — ONLY after live verification confirms everything
   works. They are the rollback backup. Rollback = drop new tables + rename
   `legacy_*` back.
6. **Tighten RLS** on GLOBAL tables (currently permissive `using(true)`,
   matching legacy posture) — the future paywall seam.

---

## Key facts for whoever picks this up

- **`card_code` == the app's canonical card id** (`card.canonicalId`). The
  client-side catalog (`src/catalog.js`, built from TCGCSV) is the full card
  universe; the DB `cards` table is a sparse subset, grown on demand by
  `ensureCard` in `App.jsx`.
- **Reshape boundary:** all new↔old translation lives in `App.jsx` `refreshData`
  (load) and the write functions (`addEntry`, `updateEntry`, `removeEntry`,
  `sellEntry`, `logTransaction`, `commitTransaction`, `addSale`, `updateSale`,
  `reclassifyAllSales`, `refreshGradedPrices`) + the module-level helpers
  (`entryFromRow`/`entryToRow`/`txFromRow`/`txToRow`/`saleFromRow`/`saleToRow`/
  `groupContribs`). The equity engine and view components were intentionally
  left untouched.
- **Grades:** never JOIN `grades` to render — use `gradeCodeToFields` /
  `fieldsToGradeCode` in `src/grades.js`. Black Label = grade `'BL'`.
- **Rollback is safe:** `legacy_*` tables hold every original row.

## Critical files
- `db/redesign/schema.sql`, `db/redesign/MIGRATION.md`,
  `db/redesign/migrate_apply.sql`
- `src/grades.js`, `src/storage.js`, `src/card-aliases.js`
- `src/App.jsx` (reshape helpers + refreshData + write functions)
