# CLAUDE.md

Working notes for Claude Code on this repo. Reflects what is actually in the
codebase as of 2026-06-02, not aspirational state. See `PLANNING.md` for
roadmap and future direction.

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
| Search | `SearchView` | Browses the TCGPlayer-sourced catalog (~5000 cards including release-event / tournament sets). Filters: set, rarity, sort; expand/collapse Hide-rarities row. |
| Transactions | `TransactionsView` | Log of buys/sells/transfers/expenses/payouts with totals, type & collection filters, the EquityPanel, and `+ Transfer / + Expense / + Payout / + Bulk grade` actions. |
| Watch | `WatchView` | Watchlist with target prices and (stub) last-seen-listing fields. |
| Catalog | `ResolveView` | Renamed from "Resolve" in the nav, internal function name unchanged. Browse every TCGPlayer printing; per-card view shows "Related printings" siblings (base / parallel / manga / event-stamped reprints); **Manage variants** opens the printing-attribute registry; Reported queue surfaces user-flagged cards. The override-resolution picker workflow is retired. |

Modals: `AddCardModal`, `AddByCertModal`, `SellModal`, `TransferModal`,
`ExpenseModal` (pool-level or entry-scoped), `PayoutModal`, `BulkGradingModal`,
`VariantsModal` (regex registry), `CardDetailDrawer`.

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
| Backend code | Two Vercel serverless functions: [api/psa.js](api/psa.js) — PSA cert proxy; [api/tcgcsv.js](api/tcgcsv.js) — TCGPlayer catalog + price proxy |
| Dev-time backend mirror | `vite.config.js` `configureServer` middleware mirrors `/api/psa` and `/api/tcgcsv` locally so `npm run dev` works the same as production |

> **MISMATCH vs CONVERSATION_CONTEXT.md** — the context doc says
> "Backend / scrapers / ETL: Python." There is no Python in this repo. The
> only server-side code is one Vercel serverless function in JS.

---

## Data sources (actual)

| Source | What we pull | Where |
|---|---|---|
| [TCGCSV](https://tcgcsv.com) | **Both the catalog and the prices.** Every TCGPlayer product in the OP TCG category (`categoryId 68`) — ~5000 products including release-event (`OPxx RE`) and tournament (`OPxx ANN`) sets. Each catalog card carries `tcg_id`, `imageUrl`, `tcgplayerUrl`, and the daily market/low/mid/high snapshot baked in. | `src/catalog.js` iterates `/api/tcgcsv?groups=1` then `/api/tcgcsv?groupAbbr=X` per group (browser-side concurrency 6; ~5–15s first load, 24h-cached). `src/pricing.js` keeps per-card price snapshots warm via `/api/tcgcsv?tcgId=N`. Upstream blocks the default Node UA; both function and dev middleware send `optcg-ledger/1.0`. |
| [PSA Public API](https://www.psacard.com/publicapi) | Cert lookup by cert number | `src/psa.js` (client) + `api/psa.js` (Vercel proxy, since PSA blocks CORS). Requires `VITE_PSA_TOKEN`. |

OPTCGAPI was the catalog source through 2026-06-01 and is **fully removed**
as of the catalog-source switch — no fetches, no schema dependencies, no
game-data fields (`color`, `cost`, `power`, `life`, `counter`, `attribute`,
`sub_types`, card text). The trade is complete printing coverage (every
TCGPlayer product, every event set OPTCGAPI didn't ship) for those game
data fields. See `PLANNING.md` Decisions Log for the switch entry.

Graded prices are **manual entry only** on entries — no auto-fetch source
for PSA 10 / BGS 10 / etc. `PLANNING.md` Phase 4–5 covers re-enabling this
via eBay sold data + a fair-value model.

### Card identity → TCGPlayer product

In the TCGPlayer-sourced catalog, each card object **is** a specific
TCGPlayer product. `card.tcg_id`, `card.imageUrl`, `card.tcgplayerUrl`,
and `card.marketPrice` are baked in at catalog-build time — no per-card
"resolve" step is needed for the default mapping. Look up market price
via `getMarketPriceForCard(card)` in `pricing.js`; it routes through
`effectiveTcgId(card)` which checks for a saved override resolution
first, then falls back to `card.tcg_id`.

A vestigial **resolution layer** still lives in `src/pricing.js`
(`resolutionMap`, the `optcg:tcgcsv:resolutions:v1` localStorage blob,
the Supabase `card_resolutions` table). It's written only by
`runTcgplayerMigration` in `migrate.js` to bridge the OPTCGAPI-era
canonical ids onto the new TCGPlayer-source canonicals on first boot.
The user-facing override picker that wrote here was retired in the
Catalog tab rebrand. `runClearLegacyResolutions` (gated by
`optcg:clear-resolutions:v1`) wipes the layer once on first boot after
the switch so legacy snapshots can't disagree with the catalog (a saved
snapshot's image_url from one product mixed with the catalog's
`tcgplayerUrl` from another caused "SP Silver image but SP Gold link"
drift — see Decisions Log).

`pricing.js` public surface:
- `getMarketPriceForCard(card)` — pure read; resolution override → catalog tcg_id → baked snapshot
- `ensurePriceForCard(card)` — fire-and-forget warm-up of the price cache
- `getCachedImageForCard(card)` — `card.imageUrl` is authoritative; the
  TCGPlayer CDN URL constructed from tcg_id is a last-resort fallback
- `whenResolutionsReady()` — promise that resolves once the shared-mode
  Supabase hydrate finishes (still used by the migration)
- `onPriceResolved(cb)` — emitted when a TCGCSV price snapshot lands
- `reportBadMatch / getMatchReport / clearMatchReport / onMatchReportChanged`
  — the Reported queue on the Catalog tab

### Printing-attribute registry

Every printing facet (parallel, manga, plus any user-defined variant like
event stamps) is declared in [src/printing-attributes.js](src/printing-attributes.js)
as `{ key, label, mode: 'text'|'regex', value }`. Detection, attribute-aware
canonical-id construction, and UI pills all iterate this list — adding a
new facet is a single entry, no other code edits.

- Builtins (`parallel`, `manga`) ship hardcoded; user-added entries persist
  to `localStorage` (`optcg:variants:v1`) and are managed from the **Manage
  variants** modal in the Catalog tab.
- `detectPrintingAttributes(name)` matches against the TCGPlayer product
  `name`. Each catalog card carries `card.attributes: string[]` plus
  derived `card.isParallel` / `card.isManga` booleans for back-compat.
- The catalog cache key is `optcg:catalog:v11:<fingerprint>` where
  `printingAttributesFingerprint()` is a stable hash of the active ruleset —
  editing variants invalidates the cache so the next load re-derives every
  card's attributes.

### Per-card attribute overrides

When TCGPlayer's product name doesn't include the keyword for a variant
(e.g. a card that IS a manga rare but isn't named with `(Manga Rare)`),
the user can manually tag it from the card detail drawer. Conversely they
can remove a detected attribute. Stored in
[src/card-attribute-overrides.js](src/card-attribute-overrides.js):

- `optcg:card-attribute-overrides:v1` localStorage, keyed by canonical card
  id. Shape: `{ [cardId]: { add: ['manga'], remove: ['parallel'] } }`.
- Effective attributes = `(detected − remove) ∪ add`. Differential, so the
  override survives detection-rule changes.
- Canonical IDs are computed from *detected* attributes only, so overrides
  don't shift identity and break references in entries / transactions /
  watchlist.
- `attrsOf(card)` in `App.jsx` and `cardHasAttr(card, key)` in `pricing.js`
  both apply overrides at read time.
- `onCardAttributeOverridesChanged` bumps the App-level `variantRev` so all
  UI pills update without per-component subscriptions.

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

Grading fields (added later, each gated by `alter table ... add column if
not exists` SQL documented in `src/storage.js`): `grading_company`, `grade`,
`bgs_black bool`, `cert_number`, `graded_price`, `grade_description`,
plus the legacy PriceCharting columns `pc_product_id`, `pc_product_name`,
`price_source`, `price_fetched_at` that no longer get written. Migration
order in case you're spinning up a fresh vault:

```sql
alter table entries add column if not exists bgs_black boolean default false;
alter table entries add column if not exists cert_number text;
alter table entries add column if not exists grading_company text;
alter table entries add column if not exists grade numeric;
alter table entries add column if not exists graded_price numeric;
alter table entries add column if not exists grade_description text;
notify pgrst, 'reload schema';
```

`card_id` is a **canonical card id** derived by `canonicalIdOf(card)` in
[src/catalog.js](src/catalog.js). Shape:
`[<sourceSet>:]<displayId>[-<attributeTag>]` — the `<sourceSet>:` prefix is
included only when the printing comes from a different TCGPlayer group
than its identity suggests (e.g. `OP14RE:OP14-118` for the OP14 release-
event reprint of `OP14-118`). The attribute tag is the sorted list of
detected printing attributes joined by `-`. Examples:

- `OP11-118` — base
- `OP11-118-parallel` — parallel
- `OP11-118-manga` — manga rare
- `OP11-118-manga-parallel` — manga rare parallel
- `OP14RE:OP14-118` — release-event stamped printing
- `OP01-016-pre-errata` — pre-errata twin (user-marked)

(The pre-2026-06-01 form used `_p\d`-style suffixes like `OP11-118-p1`;
those were rewritten on first boot after the source switch by
`runTcgplayerMigration` using each saved resolution's `tcg_id` as a bridge
to the new canonical, gated by `optcg:tcgplayer-migration:v1`.)

> Card identity is **not** a UUID indirection — the canonical id is the
> primary key. There is no separate `card_mappings` table; the TCGPlayer
> `productId` lives directly on the catalog card as `card.tcg_id` (no
> mapping table needed in the TCGPlayer-sourced era).

### `transactions`
Append-ish ledger. Each entry creation writes a `buy` tx; each sale writes a
`sell` and deletes the entry; `transfer`, `expense`, and `payout` are logged
from the Transactions view.

`(id uuid, vault_key, collection_id uuid, card_id text, card_display_name text, type text, amount numeric, contributions jsonb, occurred_at date, notes text, created_at timestamptz, entry_id text)`

`type` is one of `buy`, `sell`, `transfer`, `expense`, `payout`. `payout`
represents cash leaving the pool to a member; it's structurally a sibling
of `expense` and the EquityPanel treats its `contributions[]` like `sell`
(negates the amounts so the recipient's net contribution drops).

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
  main.jsx                       React entry point
  App.jsx                        Everything: views, modals, equity engine.
                                 ~4k lines, single file by design — the
                                 project values "all the React in one
                                 place" over splitting.
  styles.css                     All CSS, BEM-ish op-* class names
  storage.js                     Solo↔shared storage adapter + Supabase
                                 schema as SQL comments
  catalog.js                     TCGPlayer-sourced catalog (via /api/tcgcsv?
                                 groups=1 + ?groupAbbr=X). Pre-errata twins,
                                 set sort buckets, internal canonicalIdOf
  pricing.js                     TCGCSV price client. card.tcg_id is the
                                 default; the resolution layer (Map +
                                 localStorage + Supabase card_resolutions)
                                 is vestigial — only the boot migration
                                 writes to it. effectiveTcgId / market price
                                 / image cache / report flagging.
  printing-attributes.js         Variant detection registry: builtins
                                 (parallel, manga) + user-added via the
                                 Variants manager modal. Stored in
                                 optcg:variants:v1.
  card-attribute-overrides.js    Per-card manual classification overrides
                                 (e.g. "this card IS manga even though
                                 TCGPlayer doesn't say so"). Differential
                                 add / remove shape, stored in
                                 optcg:card-attribute-overrides:v1.
  psa.js                         PSA cert client + OPTCG match heuristics.
                                 setNorm.startsWith() so a PSA "OP14" hits
                                 the base group AND OP14 RE / OP14 ANN
                                 sub-groups; fullName fallback so subjects
                                 like "MONKEY D. LUFFY ALTERNATE ART"
                                 still match.
  migrate.js                     One-time client-side migrations gated by
                                 versioned localStorage flags.
                                 runCanonicalMigration (legacy OPTCG ids →
                                 first canonical scheme), runPcCleanup
                                 (legacy PriceCharting localStorage purge),
                                 runTcgplayerMigration (OPTCGAPI canonicals
                                 → TCGPlayer-source canonicals via the
                                 tcg_id bridge), runClearLegacyResolutions
                                 (wipe the now-vestigial resolution layer).

api/
  psa.js         Vercel serverless function: PSA cert proxy. Reads
                 VITE_PSA_TOKEN (or PSA_TOKEN) server-side.
  tcgcsv.js      Vercel serverless function: TCGCSV catalog + price proxy.
                 Endpoints: ?tcgId=N (price snapshot by productId),
                 ?number=X (every printing of one number),
                 ?groupAbbr=X (one group's products + prices — used by the
                 catalog loader, doesn't build the full index so cold
                 starts stay inside the serverless timeout),
                 ?groups=1 (group list), ?all=1 (full dump; left in for
                 hot-cache scenarios but the client uses the per-group
                 path because ?all=1 502'd on cold function instances).
                 Module-level caches: productId→groupId index (24h TTL),
                 per-group prices (6h TTL), in-flight-fetch dedup so a
                 bulk handler shares one upstream call per group.

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

- Each TCGPlayer product is a distinct catalog entry. Cards sharing a number
  (e.g. base vs parallel vs manga) have different canonical ids derived from
  their detected attributes — see "Card identity → TCGPlayer product" above.
- `card.attributes` is the authoritative list; `card.isParallel` /
  `card.isManga` are derived booleans kept around for back-compat.
- Detection is regex-driven via the printing-attribute registry. Users add
  new variants (e.g. event-stamp) from the Catalog tab's Manage variants
  modal.
- Per-card overrides handle cases where TCGPlayer's name doesn't include the
  keyword that should match (see "Per-card attribute overrides").
- `findCandidateCards(cert, catalog)` (psa.js) returns all printings sharing
  a `displayId` so AddByCertModal can show a picker.
- Pre-errata is a per-card user toggle (`togglePreErrata`) that synthesizes a
  twin entry with a suffixed `__pre-errata` id and `variantTag: 'pre-errata'`.

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
| TCGCSV is the next price baseline | **Resolved (2026-05-27 → expanded 2026-06-01)**: TCGCSV is the sole price source AND the catalog source. OPTCGAPI fully removed in the catalog-source switch. |
| eBay / Cardmarket / Yuyu-tei / Cardrush / Snkrdunk | Zero integration |
| Schema: `cards`, `sets`, `card_mappings`, `holdings`, `current_prices`, `price_history`, `listings`, `sales`, `fair_values`, `scrape_log`, `events` | Schema: `collections`, `entries`, `transactions`, `card_resolutions`, `watchlist` |
| Internal UUID `card_id` + external mappings table | **Resolved (2026-05-27 → expanded 2026-06-01)**: card ids are canonical strings derived from the TCGPlayer product (attribute-tag form: `OP11-118`, `OP11-118-parallel`, `OP14RE:OP14-118`). No UUIDs, no mappings table — `card.tcg_id` is the TCGPlayer productId, baked into the catalog card directly. |
| Supabase Auth + per-user RLS from day one | No auth; shared `VITE_VAULT_KEY` + permissive `using (true)` RLS. (Will be revisited if/when the bug-reporter pipeline in `PLANNING.md` initiative section lands.) |
| `sales` and `price_history` are append-only | No such tables; transactions are user-deletable |
| Playwright scrapers, residential proxies, rotating UAs | No scrapers exist |
| Admin review queue for matcher | **Retired (2026-06-01)**: the override picker that approximated this was removed in the Catalog tab rebrand. Today the catalog *is* the TCGPlayer product list (no per-card resolution work needed); user-extension happens via the Variants manager (regex rules) and per-card classification overrides. |
| Fair value model | Not built. Graded prices are manual entry on entries — auto-fetch parked until eBay/fair-value source exists. |
| Grade premiums via pop-aware regression | Not built. Same status as fair value above. |

The context doc describes the **future** product. This codebase is closer to
**Phase 0 / Phase 1**: a personal collection ledger with live read-only
pricing, dual-mode persistence, and reasonably sophisticated equity math.
See `PLANNING.md` for the phased path forward.
