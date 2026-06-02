# CLAUDE.md

Working notes for Claude Code on this repo. Reflects what is actually in the
codebase as of 2026-05-26, not aspirational state. See `PLANNING.md` for
roadmap and future direction; see `CONVERSATION_CONTEXT.md` for the long-form
product/architecture vision that this doc is calibrated against.

> **Discrepancies between CONVERSATION_CONTEXT.md and the code are flagged
> inline below** and consolidated at the bottom. Trust the code.

---

## What this app does today

A two-mode web app for tracking a One Piece TCG collection:

- **Solo mode** — browser-only, `localStorage` storage, no backend.
- **Shared mode** — same UI, persistence to Supabase Postgres + Realtime,
  multi-user via a shared `VITE_VAULT_KEY` secret.

It is **not** a marketplace, scraper, or fair-value engine yet. It is a
collection ledger with live read-only pricing from third-party APIs.

### Views (`src/App.jsx`)

| View | Function | What it does |
|---|---|---|
| Collection | `CollectionView` | Lists entries in the active collection, with cost basis (paid + linked expenses), market value, and per-entry actions (edit, log expense, sell, delete). |
| Search | `SearchView` | Browses the OPTCG catalog (~thousands of cards) with set/rarity/color/sort filters and "Price as" toggle for graded tiers. |
| Transactions | `TransactionsView` | Log of buys/sells/transfers/expenses with totals, type & collection filters, the EquityPanel, and `+ Transfer / + Expense / + Bulk grade` actions. |
| Watch | `WatchView` | Watchlist with target prices and (stub) last-seen-listing fields. |
| Resolve | `ResolveView` | One-card-at-a-time TCGCSV variant resolver — "Auto-resolve all" bulk-picks the non-parallel base for every unresolved card. |

Modals: `AddCardModal`, `AddByCertModal`, `SellModal`, `TransferModal`,
`ExpenseModal` (pool-level or entry-scoped), `BulkGradingModal`,
`CardDetailDrawer`.

### Equity model (`EquityPanel`)

The most distinctive piece of business logic in the app. Two modes user-toggleable:

- **Capital** — net signed contributions per member, equity % from positive
  nets. Ignores market timing.
- **Time-weighted** — fund-accounting unit model. Each contribution issues
  units priced against current NAV; buys mark NAV up *and* down by the card's
  market vs cost; sells mark NAV down by the card's current market regardless
  of proceeds. Earlier contributions to an appreciating pool get larger
  shares.

Sign convention on transfer contributions: **sender +, receiver −**
(this was flipped from the original convention; see Decisions Log in
`PLANNING.md`).

---

## Stack (actual)

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite 5, plain JSX, no TS |
| Styles | `src/styles.css` — single hand-written CSS file, BEM-ish `op-*` classes |
| Icons | `lucide-react` |
| State | React hooks. No Redux/Zustand. Per-component `useState` + `useMemo`. A handful of `useStoredState` for filter persistence. |
| Storage adapter | `src/storage.js` — `store` exports a uniform `{list, insert, update, remove, removeWhere, subscribe, ...}` interface backed by either `localStorage` (solo) or Supabase (shared) |
| DB (shared mode) | Supabase Postgres, schema documented inline in `src/storage.js` comments |
| Realtime (shared mode) | Supabase Realtime channels per table |
| Auth | **None.** `VITE_VAULT_KEY` is a shared partition key; RLS policies are permissive `using (true)`. README acknowledges this is weak. |
| Hosting target | Vercel (`api/*.js` serverless functions auto-detected); Netlify works too for the static side |
| Backend code | One Vercel serverless function: [api/psa.js](api/psa.js) — PSA cert proxy |
| Dev-time backend mirror | `vite.config.js` `configureServer` middleware mirrors `/api/psa` locally so `npm run dev` works the same as production |

> **MISMATCH vs CONVERSATION_CONTEXT.md** — the context doc says
> "Backend / scrapers / ETL: Python." There is no Python in this repo. The
> only server-side code is one Vercel serverless function in JS.

---

## Data sources (actual)

| Source | What we pull | Where |
|---|---|---|
| [OPTCGAPI](https://optcgapi.com) | Card catalog (~4k+ cards), 14-day price history per card, OPTCGAPI's own card images | `src/catalog.js` — 4 endpoints merged on first load, cached in localStorage 24h |
| [TCGCSV](https://tcgcsv.com) | Daily TCGPlayer market prices (One Piece TCG = `categoryId 68`). Single price source for everything visible in the UI. Lookup is by TCGPlayer `productId`. | `src/pricing.js` (client) + `api/tcgcsv.js` (Vercel proxy with module-level productId→groupId index and per-group price caches). No auth, but the upstream blocks the default Node UA — both the function and the Vite dev middleware send an `optcg-ledger/1.0` User-Agent. |
| [PSA Public API](https://www.psacard.com/publicapi) | Cert lookup by cert number | `src/psa.js` (client) + `api/psa.js` (Vercel proxy, since PSA blocks CORS). Requires `VITE_PSA_TOKEN`. |

Graded prices today are **manual entry only** on entries — there's no
auto-fetch source for PSA 10 / BGS 10 / etc. The roadmap (`PLANNING.md`
Phase 4–5) covers re-enabling this via eBay sold data + a fair-value model.

### Variant resolution

A canonical card id maps to a TCGPlayer `productId` via the resolver in
the Resolve view. The mapping lives in:

- **In-memory Map** (`resolutionMap` in `pricing.js`) — the source of truth
  for all reads (`getTcgId`/`getResolution`). Lazy-hydrated from localStorage
  on first access, then from Supabase in shared mode.
- **localStorage** — `optcg:tcgcsv:resolutions:v1`, keyed by canonical id. A
  warm-start cache only, written best-effort and debounced. Reads never touch
  it directly: at full-catalog scale the single JSON blob can exceed the ~5MB
  quota, and a swallowed write used to silently drop bulk resolutions (the
  unresolved count wouldn't drop). The Map decouples reads from that limit.
- **Supabase** (shared mode) — `card_resolutions.tcg_id` plus a `snapshot`
  jsonb with the product summary so teammates skip the search. The durable
  store across sessions in shared mode. `listResolutions` **pages through
  with `.range()`** — a plain `.select()` is capped at PostgREST's 1000-row
  default, so a full-catalog vault would only hydrate the first 1000 and the
  rest would re-resolve on every refresh.

In shared mode the Supabase load is async, so `autoResolveCard` awaits a
`whenResolutionsReady()` gate (resolved by `hydrateResolutionsFromShared` on
any exit path) before treating a card as unresolved. Without it, every page
refresh re-resolves already-saved cards: the viewport-driven `useEnhancedImage`
fires before hydration lands, the Map is only warm-started from (overflowing)
localStorage, so cards look unresolved and trigger redundant TCGCSV searches.

`pricing.js` exposes `getTcgId(cardId)`, `getMarketPriceForCard(card)`,
`ensurePriceForCard(card)` (fire-and-forget warm-up), `searchTcgProducts(displayId)`,
and `saveResolution(cardId, product)`. The `onPriceResolved` emitter
drives UI re-renders when async price fetches land.

### Printing-attribute registry

Every printing facet (parallel, manga, plus any user-defined variant like
event stamps) is declared in [src/printing-attributes.js](src/printing-attributes.js)
as `{ key, label, mode: 'text'|'regex', value }`. Detection, match scoring,
issue diagnosis, and UI pills all iterate this list — adding a new facet is
a single entry, no other code edits.

- Builtins (`parallel`, `manga`) ship hardcoded; user-added entries persist
  to `localStorage` (`optcg:variants:v1`) and are managed from the **Manage
  variants** modal in the Resolve view.
- `detectPrintingAttributes(name)` matches against OPTCGAPI `card_name` AND
  TCGPlayer product `name` (same regex applied both sides). Each catalog
  card carries `card.attributes: string[]`; each product gets `attributes`
  decorated client-side in `searchTcgProducts` so user-defined patterns apply
  even though the proxy doesn't know about them.
- `pickBestMatchForCard` / `confidentMatchForCard` loop the registry: +60 per
  attribute the card and product agree on; confidence requires every
  registered attribute to agree.
- `diagnoseResolution` returns `attributeMatches: {key, label, ok}[]` driven
  by the registry, so the diagnostic panel renders one row per attribute
  without naming any.
- The catalog cache key is `optcg:catalog:v10:<fingerprint>` where
  `printingAttributesFingerprint()` is a stable hash of the active ruleset —
  editing variants invalidates the cache so the next load re-derives every
  card's attributes.
- Derived `isParallel` / `isManga` booleans are still kept on catalog cards
  for back-compat with older consumer code; new consumers should prefer
  `card.attributes`.

---

## Schema (actual, shared mode)

Tables live in `src/storage.js` as SQL comments — that file is the source of
truth for what's currently expected to exist in Supabase. All tables are
partitioned by `vault_key` (text).

### `collections`
`(id uuid, vault_key text, name text, members jsonb, created_at timestamptz)`

`members` is an array of member name strings used for contribution dropdowns.

### `entries`
One row per physical card copy. Cost-basis source of truth.

Core: `(id uuid, vault_key, collection_id uuid→collections, card_id text, condition text, purchase_price numeric, owner_name text, contributions jsonb, notes text, added_at, acquired_at)`

Grading fields (added later): `grading_company`, `grade`, `bgs_black bool`,
`cert_number`, `graded_price`, `pc_product_id`, `pc_product_name`,
`price_source`, `price_fetched_at`.

`card_id` is a **canonical card id** derived by `canonicalIdOf(card)` in
[src/catalog.js](src/catalog.js). Shape:
`[<sourceSet>:]<displayId>[-<variantTag>]` — the `<sourceSet>:` prefix is
included only when the printing comes from a different set than its identity
suggests (e.g. `OP12:ST01-004-p2` for an OP12 parallel reprint of ST01-004).
Examples: `OP11-118` (base), `OP11-118-p1` (parallel), `OP01-016-pre-errata`
(pre-errata twin), `PROMO:OP09-077-tournament-winner` (promo printing).

A one-time client-side migration in [src/migrate.js](src/migrate.js)
rewrites legacy OPTCG-flavored `card_id` values across all DB tables on
first boot, gated by an `optcg:canonical-migration:v1` localStorage flag.

> Card identity is **not** a UUID indirection — the canonical id is the
> primary key. There is no separate `card_mappings` table; the TCGPlayer
> productId lives on `card_resolutions.tcg_id`. Add additional source
> mappings as columns or as a future mappings table when a second pricing
> source lands.

### `transactions`
Append-ish ledger. Each entry creation writes a `buy` tx; each sale writes a
`sell` and deletes the entry; `transfer` and `expense` are logged from the
Transactions view.

`(id uuid, vault_key, collection_id uuid, card_id text, card_display_name text, type text, amount numeric, contributions jsonb, occurred_at date, notes text, created_at timestamptz, entry_id text)`

`entry_id` links card-scoped expenses (and buy txs) to a specific entry so
cost-basis can roll grading fees into the entry's effective cost. The user
can also delete arbitrary transactions via the trash icon (see Decisions Log).

> **MISMATCH** — the context doc treats `sales` as sacred / append-only.
> In this code, sales are part of the `transactions` table, and any tx
> (including sells) is user-deletable. There is no separate `sales` or
> `price_history` table.

### `card_resolutions`
`(id, vault_key, card_id text, tcg_id text, snapshot jsonb, updated_at, unique(vault_key, card_id))`

Caches the TCGPlayer printing each canonical card has been resolved to,
plus a `snapshot` with the product summary (name, image_url, rarity,
is_parallel). Lets a team's variant-resolution work be collective.

> Tables that pre-date 2026-05-27 also carry three PriceCharting-era
> columns (`pc_product_id`, `pc_product_name`, `pc_console`) that no
> longer get written to. SQL to drop them is in
> [src/storage.js](src/storage.js) near the schema comment.

### `watchlist`
`(id, vault_key, card_id, card_display_name, target_price, notes, last_checked_at, last_seen_url, last_seen_price, last_seen_source, created_at)`

The `last_seen_*` fields are placeholders for a future scraper integration;
nothing populates them today.

### RLS

Enabled on every shared table but with permissive `using (true)` policies.
The README explicitly notes this is "fine for a friend group" but vulnerable
to vault-key enumeration. No Supabase Auth, no per-user gating.

> **MISMATCH** — context doc says "RLS from day one on user-scoped tables
> (`holdings` especially)." There is no `holdings` and no per-user scoping.
> Effective access control = "knows the vault key."

---

## File layout

```
src/
  main.jsx       React entry point
  App.jsx        Everything: views, modals, equity engine. ~3.7k lines, single
                 file by design — the project values "all the React in one
                 place" over splitting.
  styles.css     All CSS, BEM-ish op-* class names
  storage.js     Solo↔shared storage adapter + Supabase schema as SQL comments
  catalog.js     OPTCGAPI catalog/history fetch + cache, pre-errata twins,
                 set sort buckets, canonicalIdOf
  pricing.js     TCGCSV pricing client + variant resolver. Market price
                 lookups by tcg_id, product search by card number, image
                 fallback via TCGPlayer CDN, shared-mode resolution sync
                 (hydrateResolutionsFromShared / subscribeToSharedResolutions),
                 onPriceResolved emitter.
  psa.js         PSA cert client + OPTCG match heuristics (multi-strategy:
                 full-ID extract → set-prefix + card-number pairing →
                 name+number intersection → fuzzy subject match → parallel
                 disambiguation). findCandidateCards returns all siblings
                 for the user picker.
  migrate.js     One-time client-side migrations gated by versioned
                 localStorage flags. runCanonicalMigration rewrites
                 entries/transactions/watchlist/card_resolutions to
                 canonical card_ids; runPcCleanup promotes legacy
                 PriceCharting tcg_id mappings into the new resolution
                 cache and deletes the PC localStorage keys.

api/
  psa.js         Vercel serverless function: PSA cert proxy. Reads
                 VITE_PSA_TOKEN (or PSA_TOKEN) server-side.
  tcgcsv.js      Vercel serverless function: TCGCSV price proxy. Maintains
                 module-level caches (productId→groupId index, 24h TTL;
                 per-group prices, 6h TTL) so warm calls are O(1) Map
                 lookups + at most one upstream prices fetch.

vite.config.js   Vite config + dev-time middleware mirroring /api/psa and
                 /api/tcgcsv locally. Same caching semantics as the Vercel
                 functions; module-level Maps live for the dev server's
                 lifetime.

.claude/
  commands/
    cleanup.md   Project slash command — invoke /cleanup to run a directed
                 deadwood sweep (unused JS, stale CSS, stale comments,
                 superseded code paths). Approval required before deletion.
    sync-docs.md Project slash command — processes the directions/ inbox
                 into CLAUDE.md / PLANNING.md, then audits both docs for
                 drift against the code. Approval required before edits.

directions/      Inbox folder for idea/status/decision markdown notes you
                 want integrated into CLAUDE.md / PLANNING.md. Files are
                 read, integrated, and deleted by /sync-docs. See
                 directions/README.md.
```

There is no `tests/`, no `scripts/`, no Python, no scraper code, no `lib/`.

---

## Conventions

### Code

- **Single-file React.** `App.jsx` is the monolith. New view? New modal? Add
  it inline. Don't split unless asked — the file is consistent and grep-able.
- **Functional components + hooks** everywhere. No classes, no HOCs.
- **`useStoredState`** wraps `useState` with localStorage persistence for
  filter UI that should survive reload (sort orders, search queries, etc.).
- **`useMemo` heavily** for derived state — `catalogIndex`, `equity`,
  `sortedEntries`, etc. The `variantRev` integer counter is a dep that
  re-renders downstream consumers when TCGCSV price snapshots land
  asynchronously (subscribed via `onPriceResolved`).
- **Comments document the WHY, not the what.** There are many one-paragraph
  comments explaining domain edge cases (pre-errata twin handling, transfer
  sign convention, the canonical-id source-set prefix, etc.). Preserve this
  style when adding non-obvious code.
- **No automated tests.** Manual verification via `npm run dev`. `npm run
  build` catches syntax/import errors.

### Storage

- **Always go through `store` from `src/storage.js`** — never read/write
  `localStorage` or Supabase directly for app data. Caches in `pricing.js`
  and `catalog.js` are the exception (per-card lookup caches, not app state).
- **Insert failures are silent in shared mode** — `shared.insert` returns
  `null` on PostgREST errors (e.g. missing column). Surface failures with a
  user-visible alert if you add a new write path; see `addEntry` /
  `onLogTransaction` for examples.
- **Schema migrations are manual** — there is no migration runner. New
  columns get added as `alter table ... add column if not exists` SQL the
  user runs in the Supabase SQL editor. Document the SQL inline in
  `src/storage.js` next to the table comment so it's discoverable.

### Variant / parallel handling

- Cards with parallel/alt-art printings share a `displayId` (e.g. `OP11-118`)
  but have unique `id`s (e.g. `OP11-118`, `OP11-118_p1`).
- `isParallel` is detected via regex on `card_name` / `card_image_id`.
- `findCandidateCards(cert, catalog)` returns all printings sharing a
  resolved `displayId` so the AddByCertModal can show a picker.
- Pre-errata is a per-card user toggle (`togglePreErrata`) that synthesizes a
  twin entry with a suffixed `__pre-errata` id and `variant: 'Pre-errata'`.

### Money

- Dollars. All prices stored as `numeric` / float USD.
- TCGCSV returns prices as decimals (no conversion needed).

---

## Environment

`.env.local` (gitignored), example in `.env.example`:

| Var | Required when | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | Shared mode | Supabase project URL |
| `VITE_SUPABASE_KEY` | Shared mode | Anon/public key (RLS does the partitioning) |
| `VITE_VAULT_KEY` | Shared mode | Partition string — anyone with this key sees the same data |
| `VITE_PSA_TOKEN` | Add-by-cert flow | PSA Bearer token (also read server-side by `api/psa.js`) |

TCGCSV requires no auth — the proxy sends a polite User-Agent and that's it.

`VITE_` prefix exposes the var to the client bundle. Vercel passes *all*
env vars to serverless functions regardless of prefix, so `api/psa.js` can
read `VITE_PSA_TOKEN`.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173 (or next free port)
npm run build        # production build to dist/
npm run preview      # serve the built bundle
```

Build is the de-facto type check / smoke test. Use it before declaring a
non-trivial change done.

---

## Discrepancies with `CONVERSATION_CONTEXT.md` (consolidated)

These are flagged inline above; collected here for review:

| Context doc says | Code says |
|---|---|
| Backend in Python | No Python; two tiny Vercel JS functions (`api/psa.js`, `api/tcgcsv.js`) |
| PriceCharting being phased out | **Resolved (2026-05-27)**: PriceCharting fully removed in Stage 5 of the TCGCSV migration. No code path touches PC anymore; the `card_resolutions.pc_*` columns still exist on legacy DBs (SQL to drop them is in `src/storage.js`). |
| TCGCSV is the next price baseline | **Resolved (2026-05-27)**: TCGCSV is the sole price source. `/api/tcgcsv` proxy + `src/pricing.js` client + Resolve view variant resolver. |
| eBay / Cardmarket / Yuyu-tei / Cardrush / Snkrdunk | Zero integration |
| Schema: `cards`, `sets`, `card_mappings`, `holdings`, `current_prices`, `price_history`, `listings`, `sales`, `fair_values`, `scrape_log`, `events` | Schema: `collections`, `entries`, `transactions`, `card_resolutions`, `watchlist` |
| Internal UUID `card_id` + external mappings table | **Resolved (2026-05-27)**: card IDs are canonical (`canonicalIdOf(card)`, source-stable). Not UUIDs and there's still no separate mappings table — TCGPlayer productId lives on `card_resolutions.tcg_id`. |
| Supabase Auth + per-user RLS from day one | No auth; shared `VITE_VAULT_KEY` + permissive `using (true)` RLS |
| `sales` and `price_history` are append-only | No such tables; transactions are user-deletable |
| Playwright scrapers, residential proxies, rotating UAs | No scrapers exist |
| Admin review queue for matcher | Closest analog is the Resolve view: per-card TCGCSV picker + "Auto-resolve all" bulk action. Not a confidence-bucketed review queue. |
| Fair value model | Not built. Graded prices are manual entry on entries — auto-fetch parked until eBay/fair-value source exists. |
| Grade premiums via pop-aware regression | Not built. Same status as fair value above. |

The context doc describes the **future** product. This codebase is closer to
**Phase 0 / Phase 1**: a personal collection ledger with live read-only
pricing, dual-mode persistence, and reasonably sophisticated equity math.
See `PLANNING.md` for the phased path forward.
