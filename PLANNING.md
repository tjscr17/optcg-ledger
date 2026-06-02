# PLANNING.md

Roadmap and decisions log. Pairs with `CLAUDE.md` (current state) and
`CONVERSATION_CONTEXT.md` (long-form product vision).

Status conventions:
- ✅ Built and in production
- 🟡 Partially built / stubbed
- ⬜ Not started
- ❌ Explicitly out of scope (or reversed)

---

## Status snapshot — what's actually built

| Capability | Status | Notes |
|---|---|---|
| Card catalog (TCGPlayer-sourced via TCGCSV) | ✅ | ~5000 products incl. release-event / tournament sets OPTCGAPI didn't ship. Iterates `?groups=1` + `?groupAbbr=X` per group; 24h localStorage cache keyed by `optcg:catalog:v11:<variant-fingerprint>`. OPTCGAPI fully removed 2026-06-01. |
| Set / Rarity / Sort filters in Search | ✅ | Plus expand/collapse Hide-rarities row. Color / Type / Cost / Power filters dropped with the catalog-source switch (TCGPlayer has no game data). |
| Collection-level cost basis & P&L | ✅ | Cost basis = `purchase_price + linked card-scoped expenses` |
| Per-entry actions (edit, expense, sell, delete) | ✅ | Trash icon = silent delete (no tx); $ icon = sell flow with proceeds |
| Sell flow with sale proceeds and contributions | ✅ | `SellModal` writes a `sell` tx and removes the entry |
| Transactions ledger | ✅ | Buy / sell / transfer / expense / payout rows, type & collection filters |
| Delete transactions | ✅ | Trash icon on every tx row; equity recalculates live |
| Transfers (cash between members) | ✅ | Sign convention: sender +, receiver − |
| Pool expenses | ✅ | `ExpenseModal`, optionally card-scoped via `entry_id` |
| Payouts (cash out to members) | ✅ | `PayoutModal` (2026-06-01); UI amounts are positive per recipient, EquityPanel treats `type:'payout'` like `sell` so the recipient's net contribution drops. |
| Card-scoped expenses (grading, shipping) | ✅ | Roll into the entry's cost basis |
| Bulk grading flow | ✅ | Multi-card select, per-card cost, payer splits scaled proportionally |
| Capital-mode equity | ✅ | Net signed contributions, equity % from positive nets |
| Time-weighted equity | ✅ | Fund-accounting units, two-direction NAV mark on buys/sells, transfer is zero-sum at current unit price |
| Catalog tab (was Resolve) | ✅ | Browse 5000+ TCGPlayer printings; per-card view shows "Related printings" siblings; Reported queue for user-flagged cards. The override-resolution picker workflow was retired 2026-06-01. |
| Printing-attribute registry + Variants manager | ✅ | Regex registry in `src/printing-attributes.js` (builtins: parallel, manga; user-added via the Variants manager modal). Drives detection, canonical id construction, UI pills. Cache key v11 includes the ruleset fingerprint. |
| Per-card attribute overrides | ✅ | Manual classification add/remove from the card detail drawer. Localstorage `optcg:card-attribute-overrides:v1`. Effective attributes = `(detected − remove) ∪ add`. Canonical ids stay rooted in *detected* attributes for stability. |
| Card image / TCGPlayer link consistency | ✅ | Catalog card is authoritative — `card.imageUrl` + `card.tcgplayerUrl` always come from the same TCGPlayer product. The resolution-layer image_url override was retired (fixed "SP Silver image / SP Gold link" drift). |
| PSA cert lookup → entry pre-fill | ✅ | Vercel function proxies CORS; multi-strategy catalog matcher. `setNorm.startsWith` so PSA "OP14" hits OP14 + OP14 RE + OP14 ANN groups; `fullName` fallback for subjects mentioning alt-art / manga. |
| PSA parallel/alt-art picker | ✅ | `findCandidateCards` returns all printings sharing a displayId |
| Pre-errata twin support | ✅ | Per-card toggle; synthesizes a twin in the augmented catalog |
| Watchlist | 🟡 | UI + storage exist; `last_seen_*` fields never populated (no scraper) |
| Solo/shared mode toggle | ✅ | Driven by `VITE_SUPABASE_*` env vars; runtime indicator pill |
| Supabase Realtime sync | ✅ | Per-table subscriptions update local state on remote writes |
| Pop-up / silent insert failure surfacing | ✅ | `addEntry` / `onLogTransaction` alert when shared insert returns null. Alert now includes the Supabase error code/message/details/hint via `getLastStoreError()`. |
| Real auth (per-user) | ❌ | Replaced by `vault_key` shared-secret partitioning; permissive RLS. Bug-reporter initiative would force this. |
| Append-only ledger guarantees | ❌ | Transactions are user-deletable; no immutable `sales` / `price_history` |
| Historical price snapshots in DB | ⬜ | OPTCGAPI's 14-day endpoint is gone (catalog source removed); no local persistence |
| Live listings / underpriced alerts | ⬜ | Future Phase 3 |
| Fair value model | ⬜ | Future Phase 4 |
| Grade premium model | ⬜ | Graded prices are manual entry only (auto-fetch parked Stage 4); a pop-aware scarcity model needs eBay-sold data |
| JP / EU coverage | ⬜ | English-only catalog. JP / Korean spec work parked. |
| Python anywhere | ❌ | Project is React + Vite + JS only; reversed from the original context doc |
| TCGCSV integration (catalog + prices) | ✅ | Complete (2026-06-01): TCGCSV is both the catalog source AND the price source. OPTCGAPI fully removed. |
| Canonical card IDs (TCGPlayer-source form) | ✅ | `canonicalIdOf(card)` in catalog.js; attribute-tag suffix (`-parallel`, `-manga`, `-manga-parallel`); `runTcgplayerMigration` bridged the OPTCGAPI-era `_p\d` form via tcg_id on 2026-06-01. |
| Playwright scrapers | ⬜ | Future Phase 3 |
| Daily backups of price/sales history | ⬜ | Not configured |
| Automated tests | ⬜ | None; smoke test is `npm run build` |
| Remote bug-fix pipeline (in-site report → GH issue → Claude Code PR → preview → phone notify) | ⬜ | Spec in `directions/`; see initiative below |

---

## Phased roadmap

### Phase 0 — Personal ledger (CURRENT)

What exists today: dual-mode collection tracker with TCGCSV-backed market
prices, sophisticated equity tracking, manual PSA cert ingestion, manual
graded-price entry (auto-fetch parked), shared-vault sync. Roughly the
project as a personal/friend-group tool before any of the broader
marketplace ambitions land.

**Exit criteria for this phase** (proposed):
- [ ] Equity math feels stable in real use across both modes
- [ ] No silent-failure regressions on schema drift
- [ ] User decides whether to invest in real auth before scaling beyond
      the friend group

### Phase 1 — Fix price data foundation ✅ (mostly)

Per context doc: replace PriceCharting with TCGCSV, build the matcher
pipeline + review queue.

**Current state (post-2026-06-01 catalog switch):**
- ✅ TCGCSV is both the price source AND the catalog source. Every catalog
  card carries `tcg_id`, `imageUrl`, `tcgplayerUrl`, and the current
  market/low/mid/high snapshot. No per-card "resolve" step needed — the
  catalog IS the mapping.
- ✅ Matcher pipeline collapsed: the override picker was retired with the
  TCGPlayer-source switch (catalog cards are TCGPlayer products, so there's
  no ambiguity to resolve). Variant detection happens via the printing-
  attribute registry; user-extensible via the Variants manager modal in
  the Catalog tab.
- ✅ User-extension path for misclassified cards: per-card attribute
  overrides (drawer → Classifications). Handles "TCGPlayer's name doesn't
  say manga but this card IS manga" cases.
- ❌ Confidence-bucketed admin review queue: no longer applicable —
  there's no auto-matching workflow to bucket. The Reported queue on the
  Catalog tab is the user-driven analog.

**Exit criteria** (per context doc): ≥95% of cards have a confirmed mapping
and a current price. **Effectively met by construction** since every catalog
card is a TCGPlayer product with a tcg_id baked in.

### Phase 2 — Historical price capture ⬜

Per context doc: `price_history` table + daily snapshots + backups + simple
history charts.

**Current state:**
- ⬜ No `price_history` table in the Supabase schema (`src/storage.js`).
- ❌ OPTCGAPI's 14-day endpoint is gone with the catalog-source switch.
  The detail drawer's 14-day trend chart was removed.
- ⬜ No daily snapshot job. No S3/B2 backup. Vercel doesn't run our scheduled
  jobs.

**Open question** before starting: where do the daily snapshots run? GitHub
Actions on a cron, or a small VPS? Vercel cron has limits.

### Phase 3 — Listing scrapers & alerts ⬜

Per context doc: eBay Browse API + targeted TCGPlayer scraper (Playwright)
on a VPS, alert rules, notifications.

**Current state:**
- ⬜ `watchlist` table has `last_seen_*` fields wired in the schema; nothing
  writes them.
- ⬜ No scraper code. No notification integration.
- ⬜ Hosting target for Playwright not decided (VPS vs GitHub Actions).

### Phase 4 — Fair value model ⬜

eBay Marketplace Insights → `sales` (append-only), liquid + illiquid models,
`fair_values` publish.

**Current state:** none of this exists. Prices are direct TCGCSV reads.

### Phase 5 — Grade premiums ⬜

Pop-aware scarcity multipliers.

**Current state:** graded prices are manual entry on entries — auto-fetch
parked in Stage 4 of the TCGCSV migration. Re-enable once Phase 4 lands
eBay sold data, or pull from a different graded source if one shows up.

### Later

JP (Yuyu-tei, Cardrush, Snkrdunk), Cardmarket EU, Whatnot pricing, portfolio
analytics. All ⬜.

---

## Cross-cutting initiative — Remote bug-fix pipeline ⬜

Off the main pricing roadmap, but high-leverage: capture bugs from a phone
while away from the dev machine, get a Vercel preview link with a proposed
fix back as a push notification, approve on the phone. Spec lives in
`directions/REMOTE_BUGFIX_PIPELINE.md` (integrated 2026-06-02). Four
independently useful phases:

1. **In-site bug reporter** (highest ROI). Floating "Report bug" button →
   `bug_reports` Supabase row with description, severity, page URL,
   viewport, console/network errors, optional screenshot. Phase 1 exit:
   submitting from any page lands a full-context row.
2. **Supabase → GitHub bridge.** Edge Function triggered on
   `bug_reports` insert, formats the report into a GH issue with
   `bug` / `reported-from-site` labels; auto-adds `auto-fix` for
   low/medium severity. Stamps `github_issue_number` on the row.
3. **Claude Code auto-fix.** GitHub Actions workflow listens for
   `auto-fix` label, runs `anthropics/claude-code-action` with the
   issue as the prompt, opens a branch + PR. Vercel deploys a preview
   automatically.
4. **Mobile notifications.** Discord (easiest) or Telegram webhook on
   PR open → push notification with the preview link.

**Schema (Phase 1):** `bug_reports (id uuid pk, reporter_id uuid →
auth.users, created_at, description text, severity check (low|medium|high),
page_url, user_agent, viewport_width/height, console_errors jsonb,
network_errors jsonb, screenshot_url, app_state jsonb, status check (new|
queued|in_progress|pr_opened|resolved|wont_fix), github_issue_number int,
github_pr_number int, resolved_at)`. Needs `authorized_users` for RLS gating
— current vault-key model doesn't have user identities, so the bug reporter
forces the auth question (one of the existing "before Phase 2" architectural
decisions).

**Required secrets** (per phase): GitHub PAT (`issues:write`,
`contents:write`), `ANTHROPIC_API_KEY` in GH Actions, Discord/Telegram
webhook URL.

**Open decisions** (from the spec, unresolved):
- Severity routing: should `high` skip auto-fix until trust is built? Spec
  defaults yes.
- Auto-merge for trivial fixes? Spec says never — always human review.
- Notification channel: Discord vs Telegram vs ntfy.sh / Pushover?
- Screenshot storage: public Supabase bucket vs signed URLs.
- What gets the `auto-fix` label automatically (all low/medium) vs manual
  opt-in only?

Estimated cost (per spec): under $10/mo at personal-use volume —
Anthropic API at ~$0.10–$1.00 per auto-fix attempt is the dominant line item.

Forcing function: this initiative wants real Supabase Auth, which is
already one of the "before Phase 2" open decisions.

---

## Architectural drift (resolve before Phase 2)

The current schema (`collections / entries / transactions / card_resolutions
/ watchlist` keyed by `vault_key`) is **not** the schema proposed in the
context doc (`cards / sets / card_mappings / holdings / current_prices /
price_history / ...` keyed by internal UUID with user-scoped RLS).

Before any of the data-foundation phases is worth building, decide:

1. **Auth & multi-tenancy** — keep the `vault_key` model (cheap, weak) or
   move to Supabase Auth + per-user `holdings`? Phase 3+ alerts effectively
   require per-user notification settings, which is a forcing function for
   real users.
2. **Card identity** — keep OPTCG card id as the primary key (current
   simplicity), or introduce internal UUIDs + `card_mappings` (future-proof
   for multiple catalog sources)? The Phase 1 TCGCSV join effectively forces
   this question.
3. **Ledger immutability** — should `transactions` (or a new `sales`) become
   strictly append-only? Currently the user can delete any tx. Useful in
   practice for cleanup; bad for the "sacred sold data" property the context
   doc wants.

These are noted, not resolved. They belong in the next planning conversation
with the user, not in a code change.

---

## Decisions Log

Dates inferred from git history. Where multiple commits cluster, the date
shown is the first commit introducing the change.

| Date | Decision | Why | Where |
|---|---|---|---|
| 2026-05-19 | Repo initialized as React + Vite (no Python backend). | Started as a personal ledger; backend not yet needed. | First commits |
| 2026-05-19 | Storage adapter pattern: `solo` (localStorage) and `shared` (Supabase) behind one `store` interface. | Lets the same UI run zero-setup for one user and multi-user for a friend group with three env vars. | `src/storage.js` |
| 2026-05-19 | Vault-key partitioning instead of Supabase Auth. | Friend-group context; explicit acceptance of weak access control. | README §"Going shared", `src/storage.js` |
| 2026-05-20 | Adopt OPTCGAPI as canonical catalog source. | Free, no auth, daily refresh, covers OPTCG well. | `src/catalog.js` |
| 2026-05-21 | Switch dedup key from `card_id` to `card_image_id` so parallels stay distinct. | Earlier dedup collapsed `OP01-016` and `OP01-016_p1` into the same entry. | `17316fa Fix dedup collapsing parallel/alt-art printings` |
| 2026-05-22 | Add transactions ledger (`buy` / `sell` / `transfer` / `expense`) backing the EquityPanel. | Per-card cost basis wasn't enough — wanted full capital tracking with sells, transfers, and pool expenses. | `635b38e transaction update` |
| 2026-05-22 | BGS 10 Black Label handled manually (no PC field). | PriceCharting has no field for it; we don't want to silently use the regular BGS 10 price. | `8e4778a add black label` |
| 2026-05-22 | Members panel on collections; member name dropdown in contribution rows. | Less typo churn when splitting cost across the same set of people. | `eefce76 member section` |
| 2026-05-23 | PSA cert lookup integration (`AddByCertModal`). | Lets graded cards skip manual catalog picking. | `d25dc44 added psa` |
| 2026-05-23 | Schema migration discipline: `alter table ... add column if not exists` documented inline in `src/storage.js`. | First silent-insert failure (`bgs_black` column missing) made the cost of un-documented schema drift very visible. | `src/storage.js` comments |
| 2026-05-23 | Surface `shared.insert` returning null as a user alert. | Same root cause: schema mismatches were failing silently and looking like UI bugs. | `addEntry`, `onLogTransaction` |
| 2026-05-26 | PSA proxy through Vercel function `api/psa.js` (+ Vite dev middleware). | PSA's public API blocks browser CORS; production was failing. | `api/psa.js`, `vite.config.js` |
| 2026-05-26 | Move card-expense (grading, etc.) into the entry's cost basis. | Profit/loss has to count grading fees against the card, not just the pool. | `ExpenseModal`, `EntryRow` |
| 2026-05-26 | Bulk grading modal with per-card costs + proportional payer scaling. | Submitting 20 cards for grading manually was painful. | `BulkGradingModal` |
| 2026-05-26 | Flip transfer sign convention: sender +, receiver − (was the inverse). | Matches the user's mental model — "Alice sending Bob $100" should give Alice equity credit, not deduct it. | `TransferModal` |
| 2026-05-26 | Time-weighted NAV marks **both** directions on buys (drop `Math.max(0, ...)`). | Pool depreciation was invisible — new contributions weren't getting larger shares when the collection was down. | `EquityPanel`, `1c3da92 Update App.jsx` |
| 2026-05-26 | Sells also mark NAV down by the card's current market (not just proceeds). | Mirror of the buy-side fix; otherwise selling below market leaves phantom NAV. | `EquityPanel` |
| 2026-05-26 | PSA → OPTCG matcher upgraded: set-prefix-only extraction (e.g. "OP11" from Brand="ONE PIECE OP11-A FIST OF DIVINE SPEED") paired with CardNumber digits. | PSA's CardNumber is often just `118` with the set hidden in `Brand` text; the existing full-ID regex missed these. | `src/psa.js` |
| 2026-05-26 | `findCandidateCards` returns all printings sharing the matched displayId so AddByCertModal can show a picker. | Auto-pick was confidently wrong on parallels; better to expose siblings and let the user choose. | `src/psa.js`, `AddByCertModal` |
| 2026-05-27 | Project slash command `/cleanup` for repeatable deadwood sweeps; first pass removed unused `React` default import, dead `matchCatalogCard` import in App.jsx, the `variantTick` channel in `useEnhancedImage`, unused exports `refreshCard` / `getErrataIds` / `hasCachedVariant`, the `export` on `fieldForGrade` (still used internally), and one orphan CSS class `.op-card-tile-set`. | Codebase had accumulated leftovers from the candidate-picker, errata, and image-resolution refactors. Slash command makes future sweeps cheap. | `.claude/commands/cleanup.md`, `src/App.jsx`, `src/catalog.js`, `src/grading.js`, `src/styles.css` |
| 2026-05-27 | `/sync-docs` slash command, plus `directions/` inbox folder. Drop free-form markdown in `directions/`; the command reads each file, proposes integrations into CLAUDE.md / PLANNING.md, and deletes the file after applying approved edits. Phase 2 of the same command audits both docs for drift against the code. | Wanted a low-friction way to keep the docs current as ideas land — the existing `feedback-keep-docs-current` memory covers in-flight changes but not user-driven roadmap thinking. | `.claude/commands/sync-docs.md`, `directions/README.md` |
| 2026-05-27 | Canonical card IDs (`canonicalIdOf(card)` in catalog.js, format `[<sourceSet>:]<displayId>[-<variantTag>]`) become the primary card key everywhere — catalogIndex, entries.card_id, transactions.card_id, watchlist.card_id, card_resolutions.card_id. One-time client-side migration in `src/migrate.js` rewrites legacy OPTCG-flavored ids on first boot, gated by an `optcg:canonical-migration:v1` localStorage flag. | Foundation for cross-source pricing — the upcoming TCGCSV swap (and any future eBay / Cardmarket source) needs a stable, source-agnostic card identity. Handles parallels-from-different-sets cleanly (e.g. `OP12:ST01-004-p2`). | `src/catalog.js`, `src/migrate.js`, `src/App.jsx`, `src/grading.js`, `CLAUDE.md` |
| 2026-05-27 | TCGCSV migration Stage 1: scaffold `/api/tcgcsv` (Vercel function + Vite dev middleware) and `src/pricing.js` client. Lookup is by TCGPlayer `productId`; proxy maintains a lazy module-level `productId → groupId` index (24h TTL) plus per-group price caches (6h TTL). Client localStorage-caches per-card snapshots (6h TTL) with an `onPriceResolved` emitter for re-renders. End-to-end verified against real OP01 (`455865`) and OP16 (`689336`) productIds. | First step of the full PriceCharting → TCGCSV swap. Additive — no UI consumers yet, so PriceCharting still drives every visible price. TCGCSV requires a custom User-Agent (default Node UA gets 401); both the function and dev middleware send `optcg-ledger/1.0`. | `api/tcgcsv.js`, `vite.config.js`, `src/pricing.js`, `CLAUDE.md` |
| 2026-05-27 | TCGCSV migration Stage 2: `effectiveRawPrice(card)` reads TCGCSV's market price as the primary source, with PriceCharting `loose-price` as a transition fallback. `pricing.js` reads tcg_id mappings from PriceCharting's legacy `optcg:pc:images:v1` localStorage cache so Stage 2 doesn't need a new resolver. `useEnhancedImage` warms the TCGCSV cache on viewport entry; `variantRev` now bumps on both PC and TCGCSV resolutions so derived memos (equity NAV, sort orders, collection stats) recompute. SearchView's `sorted` memo also picks up `variantRev` so search tiles re-render when prices land. | Switches the user-visible price column over to TCGCSV without breaking unresolved cards. PC still owns variant resolution and image fallback until Stage 3. | `src/App.jsx`, `src/pricing.js` |
| 2026-05-27 | TCGCSV migration Stage 3: `/api/tcgcsv?number=X` search endpoint returns every TCGPlayer printing for a card identity. New helpers `searchTcgProducts`, `saveResolution`, `getResolution`, `cardNumberFromCanonical` in `pricing.js`. Resolutions write to a new `optcg:tcgcsv:resolutions:v1` localStorage cache + (shared mode) `card_resolutions.tcg_id`. ResolveView rewritten around TCGCSV — "Auto-resolve all" picks the non-parallel base for each unresolved card; manual picker shows market/low/mid/high per candidate; `getTcgId` reads from the new cache first, legacy PC cache second. Stage 3d (AddCardModal variant dropdown) deferred to Stage 4 since that whole grading section gets parked. | Removes the last hard dependency on PriceCharting search for new resolutions — all cards (including freshly unresolved ones) can now be pointed at a TCGPlayer printing without a PC token. | `api/tcgcsv.js`, `vite.config.js`, `src/pricing.js`, `src/App.jsx` |
| 2026-05-27 | Fix: `loadPriceHistory(cardId)` strips parallel/variant suffixes (`_p1`, `-p1`, `-pre-errata`, `__<tag>`) before hitting OPTCGAPI's `/twoweeks` endpoints. The upstream returns 500 (without CORS headers) for any id beyond the base `<setCode>-<cardNumber>`, which surfaced in the browser as a scary CORS error even though we caught the network failure. | Came in as a user-visible "CORS errors in console" after Stage 2 deployed. Unrelated to the TCGCSV migration; standalone bug. | `src/catalog.js` |
| 2026-05-27 | TCGCSV migration Stage 4: park PriceCharting-driven graded auto-refresh. Removed the "Price as" tier toggle in Search (Raw is the only tier the new data source exposes), the PriceCharting variant dropdown + Refresh button + auto-refetch effects in AddCardModal, the PSA 10 hint chips in AddCardModal/CardDetailDrawer, and the `priceTier`/`showTier` rendering path in CardTile/SetGroup. Entry-level grading fields (grading_company, grade, bgs_black, cert_number, graded_price) stay manual-entry; AddByCertModal still works because PSA cert lookup is independent of PC. Dropped 9 imports from grading.js (`fetchGradedPrice`, `isAggregateAcrossCompanies`, `searchVariants`, `getSavedPick`, `savePick`, `priceFromProduct`, `PRICE_TIERS`, `getCachedTierPrice`). Bundle shrank ~5 KB. | Decouples the UI from PriceCharting so Stage 5 can delete `src/grading.js` outright. Re-enable graded auto-refresh later once a real graded-pricing source (eBay sold data / fair-value model) is in place. | `src/App.jsx` |
| 2026-05-27 | PSA cert matcher widened: `findCandidateCards` now accumulates from five strategies (sibling-by-displayId, number-suffix + name overlap, set-prefix × number, **cross-set reprints** where `card.setId` matches the PSA-derived set even though the catalog `displayId` belongs to a different set, and **name-only matching** that ignores number entirely). Replaced the "first word includes" heuristic with token-set matching — significant subject tokens (length > 1, not stopwords) must all appear in the card's name. Modal also always offers a manual catalog search alongside auto-matched candidates (was previously only shown when zero matches). | The cross-set case (e.g. PSA "OP12 / 004" for a card whose canonical id is `OP12:ST01-004-p1`) was completely missed before because the matcher only looked at `displayId`, which carries the card's **identity** set (ST01) not its **physical** printing set (OP12). Token-set name matching catches cases where PSA's Subject is shorter/longer than our card name (e.g. "ZORO" vs "Roronoa Zoro"). | `src/psa.js`, `src/App.jsx` |
| 2026-05-27 | `/api/optcg-history` proxy added: OPTCGAPI's `/twoweeks/` endpoints return 500 (without CORS headers) for any card with no recent history, surfacing as scary CORS errors in the browser console. The proxy runs the three OPTCGAPI history endpoints server-side and always responds 200 with a (possibly empty) `points` array. `loadPriceHistory` rerouted through the proxy. | The 500-on-no-history was the dominant remaining console-noise source post-Stage 5. Suppressing it fully required absorbing the response server-side; the catalog cache layer (incl. empty-result caching) still helps the warm path. | `api/optcg-history.js`, `vite.config.js`, `src/catalog.js` |
| 2026-05-27 | `/api/tcgcsv` returns 200 + `{ not_found: true }` instead of 404 for unknown productIds or empty price records. The client treats both identically (negative-cache for 6h) but the browser console no longer logs 404s for stale resolutions carried over from the PriceCharting era. | Same family of noise-suppression fix. A 404 is technically correct HTTP, but every cert-modal-ish encounter with a retired TCGPlayer product becomes a console error otherwise. | `api/tcgcsv.js`, `vite.config.js`, `src/pricing.js` |
| 2026-05-27 | TCGCSV migration Stage 5: PriceCharting fully removed. `src/grading.js` deleted; image fallback and shared-mode resolution sync moved into `src/pricing.js` (`getCachedImageForCard`, `hydrateResolutionsFromShared`, `subscribeToSharedResolutions`). `useEnhancedImage` rewritten to drop the PC fetch path. `effectiveRawPrice` no longer falls back to PC's `getCachedLoosePrice`. `runPcCleanup` in `src/migrate.js` promotes the legacy `optcg:pc:images:v1` tcg_id mappings into the new TCGCSV resolution cache before deleting all `optcg:pc:*` localStorage keys (idempotent via `optcg:pc-cleanup:v1` flag). `VITE_PRICECHARTING_TOKEN` removed from `.env.example`. README + CLAUDE.md + storage.js schema comments updated. Legacy `card_resolutions.pc_*` columns in Supabase stay until the user runs the drop-column SQL documented in `src/storage.js`. Bundle 464 KB (gzip 130 KB) — back to roughly pre-migration size despite the new TCGCSV plumbing. | Final stage of the PriceCharting → TCGCSV swap. End state: TCGCSV is the only price source; PC is gone from the bundle, env vars, and active code paths. | `src/App.jsx`, `src/pricing.js`, `src/migrate.js`, `src/storage.js`, `.env.example`, `README.md`, deleted `src/grading.js` |
| 2026-05-28 | Resolutions held in an in-memory `resolutionMap` as the source of truth for reads, with localStorage as a debounced best-effort warm-start and Supabase as the durable shared-mode store. `listResolutions` paginates via `.range()` to beat PostgREST's 1000-row default cap. `whenResolutionsReady()` gate prevents the viewport-driven autoResolveCard from re-resolving already-saved cards on every refresh in shared mode. `effectiveTcgId` / `getMarketPriceForCard` / `getCachedImageForCard` / `ensurePriceForCard` route through the override layer cleanly. Surfaced silent shared-mode upsert failures via a one-time `[resolutions] Supabase upsert ... failed` console error. | Bulk auto-resolve reported "3602 saved" but the count stayed 3922 because the resolution cache was a single localStorage JSON blob that overflowed the ~5 MB quota — writes threw silently and reads pulled the partial cache. The Map fixes reads; Supabase fixes persistence; the pagination + ready-gate fix the refresh re-resolve loop. | `src/pricing.js`, `src/storage.js`, `src/App.jsx`, `CLAUDE.md` |
| 2026-05-29 | Printing-attribute registry: `src/printing-attributes.js` declares all variants as `{ key, label, mode: 'text'\|'regex', value }`. Builtins are `parallel` and `manga`; users add their own (event-stamp etc.) via the **Manage variants** modal in the (then-)Resolve view. Detection, match scoring, diagnosis, and UI pills all iterate the list. Catalog cache key bumps to v10 and includes a fingerprint of the active ruleset. `card.attributes: string[]` replaces the per-facet booleans as the source of truth; `isParallel` / `isManga` are kept as derived shortcuts for back-compat. Per-card overrides live in `src/card-attribute-overrides.js`: differential `{add, remove}` so adding "manga" to a specific card survives later detection-rule changes. Canonical IDs are still rooted in *detected* attributes so overrides don't break references in entries / transactions / watchlist. | User reported manga rares were getting matched as parallels; the fix was to make manga its own facet. Generalizing the regex registry made adding future variants (event stamps, language tags, etc.) a one-line registry edit instead of a touchpoint in every consumer. Per-card overrides cover the case where TCGPlayer's product name doesn't include the right keyword. | `src/printing-attributes.js`, `src/card-attribute-overrides.js`, `src/catalog.js`, `src/pricing.js`, `src/App.jsx` |
| 2026-05-29 | Payouts: new transaction `type: 'payout'` for cash leaving the pool to one or more members. `PayoutModal` mirrors `ExpenseModal`'s recipient-split shape; EquityPanel's `signedContribsOf` treats `payout` like `sell` (negates each recipient's contribution so equity drops). Stat row + filter + delete-label all updated. | User asked to log "either payouts or negative expenses" for cash outflow. Picked the dedicated `payout` type so equity math is unambiguous: payout = pool → member (reduces equity), expense = pool → external vendor (raises cost basis). | `src/App.jsx` |
| 2026-05-29 | Search in the Resolve view: text input that narrows the current queue case-insensitively against `card.name` / `card.displayId` / `card.id` / `card.setName`. Resets the index to 0 on change. Auto-resolve gated to Unresolved / Issues queues only — In All, In-collection, Reported, navigating to a card no longer silently saves a resolution. | Browsing the catalog via Resolve was awkward without a search box, and the per-card auto-resolve effect was over-eager (saved confident matches on every card the user clicked through, even outside a deliberate resolve workflow). | `src/App.jsx` |
| 2026-05-29 | Catalog-drawer reports flow into the Reported queue via a new `onMatchReportChanged` pub/sub. `reportBadMatch` / `clearMatchReport` emit; ResolveView subscribes to bump `resolveRev` so counts/queue recompute even when the report happens in the detail drawer overlaying the page. | The drawer's local `bumpResolutionTick` only re-rendered the drawer itself; the Resolve queue stayed stale until the user touched a local control. | `src/pricing.js`, `src/App.jsx` |
| 2026-06-01 | **Catalog source switched OPTCGAPI → TCGPlayer (the big one).** Catalog comes from `/api/tcgcsv?groups=1` + `/api/tcgcsv?groupAbbr=X` iterated per group with browser concurrency 6. The proxy was extended with `?all=1`, `?groups=1`, `?groupAbbr=X`, and the per-group path was made independent of the full-index build so cold serverless calls fit Vercel's timeout (the original `?all=1` 502'd). Catalog cards now ARE TCGPlayer products: `card.tcg_id`, `card.imageUrl`, `card.tcgplayerUrl`, `card.marketPrice` baked in. The override picker workflow is retired — the catalog already knows the tcg_id. `runTcgplayerMigration` (`optcg:tcgplayer-migration:v1`) rewrites OPTCGAPI-era canonicals to the new attribute-tag form via each saved resolution's `tcg_id` as a bridge (high-confidence) with a displayId+variant fallback for unresolved entries. The PSA matcher was widened to handle the new TCGPlayer-style names + sub-token set match (PSA "OP14" → OP14 + OP14 RE + OP14 ANN). Trade: no more game data (color, cost, power, life, counter, attribute, sub_types, card text) but complete printing coverage including release-event and tournament-prize sets OPTCGAPI never shipped. `api/optcg-history.js` deleted. | OPTCGAPI didn't carry release-event variants, tournament prize cards, anniversary prints, etc. — significant gaps for the user's actual collection. TCGPlayer is the source-of-truth for what's actually purchasable and has those gaps filled. The catalog-IS-TCGPlayer-product model also collapses an entire layer of complexity (the per-card resolve workflow). | `src/catalog.js`, `src/pricing.js`, `src/migrate.js`, `src/App.jsx`, `api/tcgcsv.js`, `vite.config.js`, deleted `api/optcg-history.js` |
| 2026-06-01 | Catalog tab rebrand (was "Resolve"). Nav button + page title + subtitle + filter dropdown all reframed — Browse / In my collections / Reported by me. Per-card view dropped the side-by-side OPTCG-vs-TCGPlayer compare in favor of a single hero + "Related printings" list (clickable buttons that open the sibling card's drawer). Save & Next button + the diagnostic panel + searchTcgProducts and the auto-resolve effect all removed. CardDetailDrawer's TCGPlayer match panel reads from the catalog card directly (not the resolution layer). Search view's Color / Type / Cost / Power refine + Hide dimensions removed (no data behind them after the source switch). 14-day price-history chart + PriceChart component + card.text hero line all dropped. Net: +80 / -415 lines. | The override picker was a leftover from the OPTCGAPI-source workflow. Every distinct TCGPlayer printing is now its own catalog entry, so there's nothing to override — you just navigate to the right entry. | `src/App.jsx`, `src/catalog.js`, `src/styles.css` |
| 2026-06-01 | Catalog is now authoritative for image/link. `getCachedImageForCard` no longer consults the resolution layer (it preferred `resolution.image_url` over `card.imageUrl`, which caused "SP Silver image but the link goes to SP Gold" drift when the heuristic's pick disagreed with the catalog's assigned product). `useEnhancedImage` stops calling `autoResolveCard` on viewport entry — that was the source of bad resolutions. `runClearLegacyResolutions` (`optcg:clear-resolutions:v1`) wipes the in-memory Map + localStorage warm-start + Supabase `card_resolutions` rows for this vault on first boot so nothing stale leaks through. New `store.deleteAllResolutions` (shared mode) backs the wipe. | Concrete user-reported bug: Marshall.D.Teach SP Silver showed SP Silver's image but the TCGPlayer link went to SP Gold. Two products share the card number; the heuristic and the catalog picked different ones. Making the catalog the single source of truth eliminates the whole class of drift. | `src/pricing.js`, `src/storage.js`, `src/migrate.js`, `src/App.jsx` |
| 2026-06-01 | Surface Supabase insert errors in the alert. `storage.js` captures `error.code/message/details/hint` to `lastStoreError`; `addEntry` reads it via `getLastStoreError()` and includes the detail in the "Couldn't save the entry" alert. | The generic alert sent the user to the console; concrete reports were easier than diagnosing remotely. The first real use diagnosed a missing `grade_description` column without round-trips. | `src/storage.js`, `src/App.jsx` |
| 2026-06-02 | Cleanup sweep via `/cleanup` (post-rebrand). Dropped unused exports/imports across App.jsx, pricing.js, catalog.js, printing-attributes.js, card-attribute-overrides.js, psa.js, storage.js. Deleted `searchTcgProducts`, `pickBestMatchForCard`, `confidentMatchForCard`, `autoResolveCard`, `diagnoseResolution`, `cardNumberFromCanonical`, `getAllMatchReports`, `matchCatalogCard`, `listUserVariants`, `updateUserVariant`, `clearCardAttributeOverride`, `clearLastStoreError`. Unexported `getTcgId` (pricing.js) and `canonicalIdOf` (catalog.js). Internal helpers `cardHasAttr`/`productHasAttr` dropped along with their callers. Stale CSS removed: `op-chart*`, `op-drawer-hero-text`, `op-graded-caveat`, `op-prefetch-*` family, `op-resolve-meta/name/sub/prices/price-*/diag-head`. Net: +41 / -344 lines. | Codebase had accumulated leftovers from the catalog-source switch, override-picker removal, and per-card override refactor. | `src/App.jsx`, `src/pricing.js`, `src/catalog.js`, `src/printing-attributes.js`, `src/card-attribute-overrides.js`, `src/psa.js`, `src/storage.js`, `src/styles.css` |
| 2026-06-02 | Remote bug-fix pipeline spec integrated from `directions/REMOTE_BUGFIX_PIPELINE.md`. Four-phase initiative: in-site bug reporter → Supabase→GitHub bridge → Claude Code auto-fix via GitHub Actions → mobile notifications. Captured as a cross-cutting initiative section in PLANNING.md plus a status snapshot row. Forces the long-pending "real Supabase Auth?" decision because the `bug_reports` table needs a real `reporter_id`. | The user wanted a way to report bugs from a phone away from the dev machine and get a Vercel preview link back. Off the main pricing roadmap but high personal leverage. | `PLANNING.md` (this file) |

### Decisions explicitly **not** taken (despite the context doc)

- Did **not** move backend to Python. Project is JS end-to-end.
- Did **not** adopt the proposed `cards / card_mappings / holdings / ...`
  schema. Current schema is `collections / entries / transactions / ...`
  keyed by vault, with canonical card ids as direct keys.
- Did **not** add real user auth. `VITE_VAULT_KEY` is the access boundary.
- Did **not** make `sales` / `transactions` append-only. The user
  intentionally has a delete-tx action.

Any of these can be revisited; flagging them so the next planning pass is
informed by the gap.

---

## Open questions (from context doc + new)

From the original context doc, still open:

- **Scraper hosting** — VPS vs scheduled GitHub Actions. (Relevant when
  Phase 3 starts.)
- **Notification channel** — email / Telegram / Discord. (Phase 3.)
- **JP coverage scope** — full parity or English-first indefinitely. (Phase 6+.)
- **Supabase free → Pro tier** — not pressing at current data volume but
  needed by Phase 2 once `price_history` lands.

New, from current code state:

- **Real auth before sharing publicly?** Today's vault-key model is fine for
  a known friend group; it's the wrong basis for any user-facing alerting.
  The bug-reporter initiative needs a `reporter_id`, which forces this
  question.
- **Append-only constraints on `transactions`** — keep current delete-tx UX
  or move to a soft-delete / void model to preserve audit trail?
- ~~**Card identity refactor (`card_mappings` table)** — wait until a second
  pricing source is being added, or pre-empt it now?~~ **Resolved 2026-05-27
  / 2026-06-01**: pre-empted via canonical IDs, twice. First via the OPTCGAPI-
  era canonical form, then rewritten to the TCGPlayer attribute-tag form on
  the source switch. No separate `card_mappings` table; the TCGPlayer
  `productId` lives directly on the catalog card.
- **Watchlist scraping target** — TCGPlayer first (matches existing catalog
  bridge via `tcg_id`)? eBay first (richer for alerts)? Both?
- **JP / Korean catalog support** — pending design discussion. TCGPlayer is
  English-only; a JP source (Bandai's official catalog, Yuyu-tei, etc.)
  would need its own data pipeline and pricing source. Parked.
- **Move `VITE_PSA_TOKEN` to a non-`VITE_` server-only var** — the token is
  in the client bundle today even though only the server actually needs it.
  Low priority; not exploitable through the proxy alone, but it's an
  unnecessary exposure.

---

## When you add a feature

1. Match the conventions in `CLAUDE.md` (single-file React, hooks, BEM-ish
   CSS, comments explain WHY).
2. If the feature writes to Supabase: add the `alter table ... add column if
   not exists` SQL as a comment in `src/storage.js` next to the relevant
   table, and surface insert failures.
3. Update this file's Status snapshot when the feature lands. Add a row to
   the Decisions Log if the change reflects a meaningful design choice (not
   just bug fixes).
4. `npm run build` before declaring done.
