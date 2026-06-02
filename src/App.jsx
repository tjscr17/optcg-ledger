import { useState, useEffect, useMemo, useRef, useCallback, useReducer } from 'react';
import { Search, Plus, X, TrendingUp, TrendingDown, Folder, Trash2, DollarSign, Anchor, ChevronRight, Package, BarChart3, RefreshCw, Cloud, HardDrive, ImageOff, Award, Loader2, Pencil, Eye, EyeOff } from 'lucide-react';
import { store, MODE, VAULT_LABEL } from './storage.js';
import { loadCatalog, loadPriceHistory, groupBySet, compareSets, augmentWithErrata, hasPreErrata, togglePreErrata } from './catalog.js';
import { hasPsaToken, fetchCert, findCandidateCards } from './psa.js';
import { runCanonicalMigration, runPcCleanup } from './migrate.js';
import {
  getMarketPriceForCard, ensurePriceForCard, onPriceResolved,
  searchTcgProducts, saveResolution, getResolution, clearResolution, cardNumberFromCanonical,
  getCachedImageForCard,
  hydrateResolutionsFromShared, subscribeToSharedResolutions, whenResolutionsReady,
  getHydratedResolutionCount,
  autoResolveCard, getTcgId, pickBestMatchForCard, confidentMatchForCard,
  diagnoseResolution, reportBadMatch, getMatchReport, clearMatchReport, getAllMatchReports,
  onMatchReportChanged,
} from './pricing.js';
import {
  getPrintingAttributes, detectPrintingAttributes, printingAttribute,
  listUserVariants, addUserVariant, updateUserVariant, removeUserVariant,
  onPrintingAttributesChanged,
} from './printing-attributes.js';

// Effective attribute keys for a card / product / resolution snapshot,
// falling back to derived booleans on legacy objects that pre-date the
// attribute-list refactor.
const attrsOf = (obj) => {
  if (!obj) return [];
  if (Array.isArray(obj.attributes)) return obj.attributes;
  const fallback = [];
  if (obj.isParallel || obj.is_parallel) fallback.push('parallel');
  if (obj.isManga || obj.is_manga) fallback.push('manga');
  return fallback;
};
const attrLabel = (key) => printingAttribute(key)?.label || key;

// Like useState, but persists to localStorage. `serialize`/`deserialize` are
// optional escape hatches for non-JSON-friendly values (e.g. Sets).
const useStoredState = (key, initial, opts = {}) => {
  const { serialize = JSON.stringify, deserialize = JSON.parse } = opts;
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) return deserialize(raw);
    } catch {}
    return typeof initial === 'function' ? initial() : initial;
  });
  useEffect(() => {
    try { localStorage.setItem(key, serialize(value)); } catch {}
  }, [key, value, serialize]);
  return [value, setValue];
};

// Raw market price for a card. Source of truth is TCGCSV (TCGPlayer market)
// via src/pricing.js. Returns 0 when the card hasn't been resolved to a
// TCGPlayer productId yet, or the price snapshot isn't cached — the
// viewport-based lazy fetch in useEnhancedImage eventually populates it
// and components re-render via the onPriceResolved emitter.
const effectiveRawPrice = (card) => {
  if (!card) return 0;
  return getMarketPriceForCard(card) ?? 0;
};

// useEnhancedImage: returns [ref, url]. Attach ref to the rendered element
// so we only kick off a price fetch when the card scrolls into the viewport
// (with a 200px margin so we pre-fetch just before it appears). Image
// fallback comes from the saved TCGCSV resolution (or the TCGPlayer CDN
// constructed from tcg_id) when OPTCGAPI didn't supply card.imageUrl.
const useEnhancedImage = (card) => {
  const ref = useRef(null);
  const synchronousImage = card?.imageUrl || (card ? getCachedImageForCard(card) : null);
  const needsImage = !synchronousImage;
  const [url, setUrl] = useState(synchronousImage);
  const [inView, setInView] = useState(!needsImage);

  useEffect(() => {
    if (inView || !ref.current) return;
    const el = ref.current;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setInView(true); obs.disconnect(); }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);

  useEffect(() => {
    if (!card) return;
    const fallback = card.imageUrl || getCachedImageForCard(card);
    if (fallback && fallback !== url) setUrl(fallback);
    if (!inView) return;
    const cid = card.canonicalId || card.id;
    if (getTcgId(cid, card.id)) {
      // Already resolved — just keep the price snapshot warm.
      ensurePriceForCard(card);
    } else {
      // No tcg_id yet. Run the smart resolver: searches TCGCSV by card
      // number, scores by set + parallel match, persists the pick. Fire-
      // and-forget; the saveResolution emit triggers downstream re-renders.
      autoResolveCard(card).then(picked => {
        if (picked) ensurePriceForCard(card);
      });
    }
  }, [card, inView, url]);

  return [ref, url];
};

const COLOR_TOKENS = {
  Red: '#c8442a', Blue: '#2d5d8f', Green: '#3d7a4a', Yellow: '#d4a23a',
  Purple: '#6b4a8a', Black: '#2a2a2a', Multicolor: '#7a6a4a',
};
const fallbackColor = (color) => COLOR_TOKENS[color] || '#5a4d3a';

const RARITY_LABELS = {
  L: 'Leader', SR: 'Super Rare', SEC: 'Secret Rare', R: 'Rare',
  UC: 'Uncommon', C: 'Common', P: 'Promo', SP: 'Special', TR: 'Treasure',
};
const CONDITIONS = ['Mint', 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

// Grading companies + per-company allowed grades. Pure UI data — the app no
// longer auto-fetches graded prices, so these only populate the dropdowns
// in AddCardModal's grading section. Half-grades only meaningful at 9.5.
const GRADING_COMPANIES = ['PSA', 'BGS', 'CGC', 'SGC'];
const GRADES_BY_COMPANY = {
  PSA: [10, 9.5, 9, 8, 7],
  BGS: [10, 9.5, 9, 8, 7],
  CGC: [10, 9.5, 9, 8, 7],
  SGC: [10, 9.5, 9, 8, 7],
};

const uid = () => Math.random().toString(36).slice(2, 10);

// ============================================================================
export default function App() {
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(null);

  const [collections, setCollections] = useState([]);
  const [entries, setEntries] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState('collection');
  const [activeCollectionId, setActiveCollectionId] = useState(null);
  const [detailCard, setDetailCard] = useState(null);
  const [addingCard, setAddingCard] = useState(null);
  const [editingEntry, setEditingEntry] = useState(null);
  const [sellingEntry, setSellingEntry] = useState(null);
  const [addByCertOpen, setAddByCertOpen] = useState(false);
  const [expenseForEntry, setExpenseForEntry] = useState(null); // entry object

  // Load card catalog
  useEffect(() => {
    (async () => {
      try {
        const cards = await loadCatalog();
        setCatalog(cards);
      } catch (e) {
        console.error(e);
        setCatalogError(e.message);
      } finally {
        setCatalogLoading(false);
      }
    })();
  }, []);

  // Pull shared-mode TCGCSV resolutions into the local cache, then subscribe
  // to real-time updates from teammates. No-ops in solo mode.
  useEffect(() => {
    hydrateResolutionsFromShared().catch(() => {});
    const unsub = subscribeToSharedResolutions();
    return () => unsub();
  }, []);

  // Load user data
  const refreshData = useCallback(async () => {
    const [cols, ents, txs, watches] = await Promise.all([
      store.list('collections'),
      store.list('entries'),
      store.list('transactions').catch(() => []),
      store.list('watchlist').catch(() => []),
    ]);
    let cs = cols;
    if (cs.length === 0) {
      const seed = await store.insert('collections', { id: uid(), name: 'Main Collection', created_at: new Date().toISOString() });
      cs = [seed].filter(Boolean);
    }
    setCollections(cs);
    setEntries(ents);
    setTransactions(txs);
    setWatchlist(watches);
    setActiveCollectionId(prev => prev || cs[0]?.id || null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // Rewrites legacy OPTCG card_ids to canonical form on first run, then
        // no-ops on subsequent loads. Must run before refreshData so the UI
        // doesn't briefly show pre-migration card_ids that don't index into
        // the (canonical-keyed) catalog.
        await runCanonicalMigration();
        // Promote legacy PriceCharting tcg_id mappings into the new TCGCSV
        // resolution cache, then drop the PC localStorage keys. Sync — fast
        // and no network.
        runPcCleanup();
        await refreshData();
      } finally { setLoading(false); }
    })();
    // Realtime sync (shared mode only)
    const unsubC = store.subscribe('collections', refreshData);
    const unsubE = store.subscribe('entries', refreshData);
    const unsubT = store.subscribe('transactions', refreshData);
    const unsubW = store.subscribe('watchlist', refreshData);
    return () => { unsubC(); unsubE(); unsubT(); unsubW(); };
  }, [refreshData]);

  // erratTick bumps whenever the user toggles a pre-errata mark so the
  // augmented catalog recomputes and twins appear/disappear in search.
  const [erratTick, setErratTick] = useState(0);

  // variantRev increments whenever any card's TCGCSV price snapshot lands
  // in the cache. Used as a useMemo dep so derived computations (collection
  // stats, equity, sort orders) re-read fresh prices. The name is a holdover
  // from the PriceCharting era; semantically it's a "prices changed" tick.
  const [variantRev, setVariantRev] = useState(0);
  useEffect(() => onPriceResolved(() => setVariantRev(r => r + 1)), []);
  const augmentedCatalog = useMemo(
    () => augmentWithErrata(catalog),
    // erratTick is read inside augmentWithErrata via readErrataSet()
    [catalog, erratTick] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Quick catalog lookup (uses augmented list so entries can resolve to twins).
  // Keyed by canonicalId — that's what every DB row's card_id resolves to
  // post-migration. The catalog card object still exposes its OPTCG-style
  // `id` for cache keys, React keys, image loading, etc.; canonicalId is
  // the cross-source-stable identity used for joins.
  const catalogIndex = useMemo(() => {
    const m = new Map();
    for (const c of augmentedCatalog) {
      if (c.canonicalId) m.set(c.canonicalId, c);
    }
    return m;
  }, [augmentedCatalog]);

  const addCollection = async (name) => {
    const created = await store.insert('collections', { id: uid(), name, created_at: new Date().toISOString() });
    if (created) setCollections([...collections, created]);
  };

  const renameCollection = async (id, name) => {
    const updated = await store.update('collections', id, { name });
    if (updated) setCollections(collections.map(c => c.id === id ? updated : c));
  };

  const updateMembers = async (id, members) => {
    const updated = await store.update('collections', id, { members });
    if (updated) setCollections(collections.map(c => c.id === id ? updated : c));
  };

  const deleteCollection = async (id) => {
    if (collections.length <= 1) return;
    if (!confirm('Delete this collection and all its entries? This cannot be undone.')) return;
    await store.remove('collections', id);
    await store.removeWhere('entries', (e) => e.collection_id === id);
    setCollections(collections.filter(c => c.id !== id));
    setEntries(entries.filter(e => e.collection_id !== id));
    if (activeCollectionId === id) setActiveCollectionId(collections.find(c => c.id !== id)?.id || null);
  };

  // Helper: append a transaction row. card lookup is best-effort so the log
  // remains useful even if the catalog entry later gets removed/renamed.
  // `entry_id` links buy/sell txs back to the entry so cross-collection
  // moves can carry the buy's capital allocation along with the card.
  const logTransaction = async ({ type, entry, sale }) => {
    const card = catalogIndex.get(entry.card_id);
    const tx = {
      id: uid(),
      collection_id: entry.collection_id,
      card_id: entry.card_id,
      card_display_name: card ? `${card.displayId || card.id} ${card.name}` : entry.card_id,
      entry_id: entry.id,
      type, // 'buy' | 'sell'
      amount: type === 'sell' ? Number(sale?.amount) || 0 : Number(entry.purchase_price) || 0,
      contributions: type === 'sell'
        ? (sale?.contributions || [])
        : (entry.contributions || []),
      occurred_at: type === 'sell' ? (sale?.date || null) : (entry.acquired_at || null),
      notes: type === 'sell' ? (sale?.notes || '') : (entry.notes || ''),
      created_at: new Date().toISOString(),
    };
    const created = await store.insert('transactions', tx);
    if (created) setTransactions(prev => [...prev, created]);
  };

  const addEntry = async (entry) => {
    const created = await store.insert('entries', {
      ...entry,
      id: uid(),
      added_at: new Date().toISOString(),
    });
    if (created) {
      setEntries(prev => [...prev, created]);
      logTransaction({ type: 'buy', entry: created });
    } else {
      // shared.insert returned null — Supabase rejected the row. Surface it
      // so the user notices instead of silently swallowing the failure.
      alert("Couldn't save the entry. Check the console for the Supabase error — most likely a missing column. See storage.js for the migration SQL.");
    }
  };

  const updateEntry = async (id, patch) => {
    const before = entries.find(e => e.id === id);
    const updated = await store.update('entries', id, patch);
    if (!updated) return;
    setEntries(entries.map(e => e.id === id ? updated : e));

    // If the user moved the entry to a different collection, drag its buy
    // and card-scoped expense transactions along so the capital allocation
    // follows the card. Match by entry_id when available, otherwise fall
    // back to card_id + occurred_at heuristic for legacy buy txs.
    if (before && patch.collection_id && patch.collection_id !== before.collection_id) {
      const oldDate = (before.acquired_at || (before.added_at || '').slice(0, 10) || '').slice(0, 10);
      const linked = transactions.filter(t => {
        if (t.entry_id === id) return true;
        if (t.type !== 'buy') return false;
        if (t.collection_id !== before.collection_id) return false;
        if (t.card_id !== before.card_id) return false;
        const txDate = (t.occurred_at || '').slice(0, 10);
        return txDate === oldDate;
      });
      for (const tx of linked) {
        const patchTx = { collection_id: patch.collection_id };
        // Backfill the entry_id link too if it was missing.
        if (!tx.entry_id) patchTx.entry_id = id;
        const updatedTx = await store.update('transactions', tx.id, patchTx);
        if (updatedTx) setTransactions(prev => prev.map(t => t.id === tx.id ? updatedTx : t));
      }
    }
  };

  // Cleanup removal — used for mis-logged entries (and orphan rows where
  // there's not enough info to record a sell). Also nukes any matching buy
  // tx and any card-scoped expense txs (grading fees, etc.) so the equity
  // panel rebalances as if the entry never existed. The Sell flow remains
  // the normal path for actual divestments.
  const removeEntry = async (id) => {
    const before = entries.find(e => e.id === id);
    await store.remove('entries', id);
    setEntries(entries.filter(e => e.id !== id));
    if (!before) return;
    const oldDate = (before.acquired_at || (before.added_at || '').slice(0, 10) || '').slice(0, 10);
    const linkedTxs = transactions.filter(t => {
      if (t.entry_id === id) return true;
      if (t.type !== 'buy') return false;
      if (t.collection_id !== before.collection_id) return false;
      if (t.card_id !== before.card_id) return false;
      return (t.occurred_at || '').slice(0, 10) === oldDate;
    });
    for (const tx of linkedTxs) {
      await store.remove('transactions', tx.id);
      setTransactions(prev => prev.filter(t => t.id !== tx.id));
    }
  };

  const addToWatchlist = async (card, opts = {}) => {
    const cid = card.canonicalId || card.id;
    if (watchlist.some(w => w.card_id === cid)) return;
    const created = await store.insert('watchlist', {
      id: uid(),
      card_id: cid,
      card_display_name: card.name ? `${card.displayId || card.id} ${card.name}` : (card.displayId || card.id),
      target_price: opts.target_price ?? null,
      notes: opts.notes || '',
      last_checked_at: null,
      last_seen_url: '',
      last_seen_price: 0,
      last_seen_source: '',
      created_at: new Date().toISOString(),
    });
    if (created) setWatchlist(prev => [...prev, created]);
  };

  const updateWatchlistItem = async (id, patch) => {
    const updated = await store.update('watchlist', id, patch);
    if (updated) setWatchlist(watchlist.map(w => w.id === id ? updated : w));
  };

  const removeFromWatchlist = async (id) => {
    await store.remove('watchlist', id);
    setWatchlist(watchlist.filter(w => w.id !== id));
  };

  const sellEntry = async (id, sale) => {
    const entry = entries.find(e => e.id === id);
    if (!entry) return;
    await logTransaction({ type: 'sell', entry, sale });
    await store.remove('entries', id);
    setEntries(entries.filter(e => e.id !== id));
    // Don't delete linked card-expense txs — they're part of the cost-basis
    // story that the equity panel still needs to attribute capital correctly.
    // The entry is gone but the historical expense remains in the ledger.
  };

  // Manual transaction removal. Used to clean up mis-logged transfers/expenses
  // (or buys/sells the user wants to scrub). For buy/sell rows this leaves the
  // underlying entry alone — only the equity bookkeeping is undone.
  const removeTransaction = async (id) => {
    await store.remove('transactions', id);
    setTransactions(prev => prev.filter(t => t.id !== id));
  };

  // 'all' is a synthetic collection that aggregates entries/transactions
  // across every real collection. We materialize it here so the rest of the
  // app can treat it like any other collection.
  const isAllMode = activeCollectionId === 'all';
  const allMembers = useMemo(() => {
    const set = new Set();
    for (const c of collections) for (const m of (c.members || [])) set.add(m);
    return [...set];
  }, [collections]);
  const activeCollection = isAllMode
    ? { id: 'all', name: 'All Collections', members: allMembers, synthetic: true }
    : collections.find(c => c.id === activeCollectionId);
  const activeEntries = isAllMode ? entries : entries.filter(e => e.collection_id === activeCollectionId);

  if (loading || catalogLoading) {
    return (
      <div className="op-shell op-loading">
        <Anchor size={42} className="op-loading-icon" />
        <div className="op-loading-text">
          {catalogLoading ? 'Pulling the bounty board…' : 'Hoisting the colors…'}
        </div>
        <div className="op-loading-sub">Loading card catalog from OPTCGAPI</div>
      </div>
    );
  }

  return (
    <div className="op-shell">
      <Header
        view={view} setView={setView}
        collections={collections}
        activeCollectionId={activeCollectionId} setActiveCollectionId={setActiveCollectionId}
        addCollection={addCollection} deleteCollection={deleteCollection} renameCollection={renameCollection}
      />

      {catalogError && (
        <div className="op-banner op-banner-warn">
          Couldn't reach the OPTCGAPI card catalog ({catalogError}). Some features may be limited.
        </div>
      )}

      <main className="op-main">
        {view === 'collection' && (
          <CollectionView
            collection={activeCollection}
            entries={activeEntries}
            transactions={transactions}
            catalogIndex={catalogIndex}
            variantRev={variantRev}
            onSearchClick={() => setView('search')}
            onAddByCertClick={hasPsaToken() ? () => setAddByCertOpen(true) : null}
            onCardClick={(card) => setDetailCard(card)}
            onRemoveEntry={removeEntry}
            onSellEntry={(entry) => setSellingEntry(entry)}
            onExpenseEntry={(entry) => setExpenseForEntry(entry)}
            onUpdateMembers={isAllMode ? null : (members) => updateMembers(activeCollection.id, members)}
            onEditEntry={(entry) => {
              const card = catalogIndex.get(entry.card_id);
              if (!card) return;
              setAddingCard(card);
              setEditingEntry(entry);
            }}
          />
        )}
        {view === 'search' && (
          <SearchView
            catalog={augmentedCatalog}
            watchlist={watchlist}
            variantRev={variantRev}
            onAddCard={setAddingCard}
            onCardClick={setDetailCard}
            onToggleWatch={async (card) => {
              const cid = card.canonicalId || card.id;
              const existing = watchlist.find(w => w.card_id === cid);
              if (existing) await removeFromWatchlist(existing.id);
              else await addToWatchlist(card);
            }}
          />
        )}
        {view === 'resolve' && (
          <ResolveView
            catalog={augmentedCatalog}
            entries={entries}
            onAddCard={setAddingCard}
            onCardClick={setDetailCard}
          />
        )}
        {view === 'watch' && (
          <WatchView
            watchlist={watchlist}
            catalogIndex={catalogIndex}
            variantRev={variantRev}
            onCardClick={setDetailCard}
            onBrowseCatalog={() => setView('search')}
            onRemove={removeFromWatchlist}
            onUpdate={updateWatchlistItem}
          />
        )}
        {view === 'transactions' && (
          <TransactionsView
            transactions={transactions}
            collections={collections}
            entries={entries}
            catalogIndex={catalogIndex}
            variantRev={variantRev}
            activeCollectionId={activeCollectionId}
            onLogTransaction={async (tx) => {
              const created = await store.insert('transactions', { id: uid(), ...tx, created_at: new Date().toISOString() });
              if (created) setTransactions(prev => [...prev, created]);
              else alert("Couldn't save the transaction. Check the console for the Supabase error.");
            }}
            onRemoveTransaction={removeTransaction}
          />
        )}
      </main>

      {addingCard && (
        <AddCardModal
          card={addingCard}
          entry={editingEntry}
          collections={collections}
          activeCollectionId={activeCollectionId}
          onClose={() => { setAddingCard(null); setEditingEntry(null); }}
          onSave={async (payload) => {
            if (editingEntry) {
              const { id, ...patch } = payload;
              await updateEntry(id, patch);
            } else {
              await addEntry(payload);
            }
            setAddingCard(null);
            setEditingEntry(null);
          }}
        />
      )}

      {addByCertOpen && (
        <AddByCertModal
          catalog={augmentedCatalog}
          collections={collections}
          activeCollectionId={isAllMode ? (collections[0]?.id || null) : activeCollectionId}
          onClose={() => setAddByCertOpen(false)}
          onSave={async (entry) => {
            await addEntry(entry);
            setAddByCertOpen(false);
          }}
        />
      )}

      {sellingEntry && (
        <SellModal
          entry={sellingEntry}
          card={catalogIndex.get(sellingEntry.card_id)}
          members={Array.isArray(collections.find(c => c.id === sellingEntry.collection_id)?.members) ? collections.find(c => c.id === sellingEntry.collection_id).members : []}
          onClose={() => setSellingEntry(null)}
          onSave={async (sale) => {
            await sellEntry(sellingEntry.id, sale);
            setSellingEntry(null);
          }}
        />
      )}

      {expenseForEntry && (() => {
        const c = collections.find(col => col.id === expenseForEntry.collection_id);
        const members = Array.isArray(c?.members) ? c.members : [];
        return (
          <ExpenseModal
            card={catalogIndex.get(expenseForEntry.card_id)}
            entry={expenseForEntry}
            collection={c}
            members={members}
            onClose={() => setExpenseForEntry(null)}
            onSave={async (tx) => {
              const created = await store.insert('transactions', { id: uid(), ...tx, created_at: new Date().toISOString() });
              if (created) setTransactions(prev => [...prev, created]);
              else alert("Couldn't save the expense. Check the console for the Supabase error.");
              setExpenseForEntry(null);
            }}
          />
        );
      })()}

      {detailCard && (() => {
        const detailCid = detailCard.canonicalId || detailCard.id;
        return (
        <CardDetailDrawer
          card={detailCard}
          entries={entries.filter(e => e.card_id === detailCid)}
          collections={collections}
          watchEntry={watchlist.find(w => w.card_id === detailCid) || null}
          onClose={() => setDetailCard(null)}
          onAddToCollection={() => { setAddingCard(detailCard); setDetailCard(null); }}
          onRemoveEntry={removeEntry}
          onToggleWatch={() => {
            const existing = watchlist.find(w => w.card_id === detailCid);
            if (existing) removeFromWatchlist(existing.id);
            else addToWatchlist(detailCard);
          }}
          onToggleErrata={() => {
            // Pre-errata twins are stored against the BASE card id (not the
            // twin's suffixed id), so strip the suffix if the user opened the
            // twin and clicks "remove pre-errata".
            const baseId = detailCard.id.replace(/__pre-errata$/, '');
            togglePreErrata(baseId);
            setErratTick(t => t + 1);
          }}
        />
        );
      })()}

      <ModeIndicator />
    </div>
  );
}

// ============================================================================
function Header({ view, setView, collections, activeCollectionId, setActiveCollectionId, addCollection, deleteCollection, renameCollection }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const menuRef = useRef(null);

  const startEdit = (c) => { setEditingId(c.id); setEditingName(c.name); };
  const commitEdit = async () => {
    const next = editingName.trim();
    if (next && editingId) {
      const current = collections.find(c => c.id === editingId);
      if (current && current.name !== next) await renameCollection(editingId, next);
    }
    setEditingId(null);
    setEditingName('');
  };

  useEffect(() => {
    const onClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const active = activeCollectionId === 'all'
    ? { id: 'all', name: 'All Collections' }
    : collections.find(c => c.id === activeCollectionId);

  return (
    <header className="op-header">
      <div className="op-brand">
        <div className="op-brand-mark"><Anchor size={22} strokeWidth={2.5} /></div>
        <div>
          <div className="op-brand-name">50.50</div>
          <div className="op-brand-sub">One Piece TCG · Collection Tracker</div>
        </div>
      </div>

      <nav className="op-nav">
        <button className={`op-nav-btn ${view === 'collection' ? 'is-active' : ''}`} onClick={() => setView('collection')}>
          <Folder size={15} /> Collection
        </button>
        <button className={`op-nav-btn ${view === 'transactions' ? 'is-active' : ''}`} onClick={() => setView('transactions')}>
          <BarChart3 size={15} /> Transactions
        </button>
        <button className={`op-nav-btn ${view === 'search' ? 'is-active' : ''}`} onClick={() => setView('search')}>
          <Search size={15} /> Search
        </button>
        <button className={`op-nav-btn ${view === 'watch' ? 'is-active' : ''}`} onClick={() => setView('watch')}>
          <Eye size={15} /> Watch
        </button>
        <button className={`op-nav-btn ${view === 'resolve' ? 'is-active' : ''}`} onClick={() => setView('resolve')}>
          <RefreshCw size={15} /> Resolve
        </button>
      </nav>

      <div className="op-collection-picker" ref={menuRef}>
        <button className="op-collection-btn" onClick={() => setMenuOpen(!menuOpen)}>
          <span className="op-collection-label">Collection</span>
          <span className="op-collection-name">{active?.name || '—'}</span>
          <ChevronRight size={14} className={`op-chev ${menuOpen ? 'is-open' : ''}`} />
        </button>
        {menuOpen && (
          <div className="op-collection-menu">
            {collections.length > 1 && (
              <div className={`op-collection-item op-collection-item-all ${activeCollectionId === 'all' ? 'is-active' : ''}`}>
                <button className="op-collection-item-btn" onClick={() => { setActiveCollectionId('all'); setMenuOpen(false); }}>
                  ★ All Collections
                </button>
              </div>
            )}
            {collections.map(c => (
              <div key={c.id} className={`op-collection-item ${c.id === activeCollectionId ? 'is-active' : ''}`}>
                {editingId === c.id ? (
                  <input
                    autoFocus
                    className="op-collection-item-input"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit();
                      if (e.key === 'Escape') { setEditingId(null); setEditingName(''); }
                    }}
                  />
                ) : (
                  <button className="op-collection-item-btn" onClick={() => { setActiveCollectionId(c.id); setMenuOpen(false); }}>
                    {c.name}
                  </button>
                )}
                <button className="op-collection-del" onClick={() => startEdit(c)} title="Rename collection">
                  <Pencil size={13} />
                </button>
                {collections.length > 1 && (
                  <button className="op-collection-del" onClick={() => deleteCollection(c.id)} title="Delete collection">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            <div className="op-collection-new">
              <input
                placeholder="New collection name"
                value={newColName}
                onChange={(e) => setNewColName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newColName.trim()) {
                    addCollection(newColName.trim());
                    setNewColName('');
                  }
                }}
              />
              <button onClick={() => { if (newColName.trim()) { addCollection(newColName.trim()); setNewColName(''); } }}>
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

function ModeIndicator() {
  return (
    <div className="op-mode-indicator" title={MODE === 'shared' ? `Shared workspace: ${VAULT_LABEL}` : 'Local-only storage on this device'}>
      {MODE === 'shared' ? <Cloud size={12} /> : <HardDrive size={12} />}
      <span>{MODE === 'shared' ? `shared · ${VAULT_LABEL}` : 'local'}</span>
    </div>
  );
}

// ============================================================================
function CollectionView({ collection, entries, transactions = [], catalogIndex, variantRev = 0, onSearchClick, onAddByCertClick, onCardClick, onRemoveEntry, onSellEntry = () => {}, onExpenseEntry = () => {}, onEditEntry = () => {}, onUpdateMembers }) {
  const members = Array.isArray(collection?.members) ? collection.members : [];
  const isSynthetic = Boolean(collection?.synthetic);
  const [entrySort, setEntrySort] = useStoredState('optcg:collection:entrySort', 'recent');
  const [colQ, setColQ] = useStoredState('optcg:collection:q', '');

  // Per-entry expense sum (card-scoped expense txs linked via entry_id). Used
  // for cost-basis display so grading/shipping/etc costs roll into the entry's
  // effective "Paid" total.
  const expensesByEntry = useMemo(() => {
    const m = new Map();
    for (const t of transactions) {
      if (t.type !== 'expense' || !t.entry_id) continue;
      m.set(t.entry_id, (m.get(t.entry_id) || 0) + (Number(t.amount) || 0));
    }
    return m;
  }, [transactions]);

  // Effective market value for an entry. Graded entries use their stored
  // graded_price — and ONLY that, no raw fallback, because the raw market
  // doesn't represent a slabbed card's value. Graded entries the user
  // hasn't entered a price for yet contribute 0 (and the UI shows "—" so
  // it's obviously pending). Raw entries fall through to the TCGCSV raw
  // market price.
  const marketValueOf = useCallback((e) => {
    if (e.grading_company) return Number(e.graded_price) || 0;
    const card = catalogIndex.get(e.card_id);
    return card ? effectiveRawPrice(card) : 0;
  }, [catalogIndex]);

  const searchedEntries = useMemo(() => {
    const needle = colQ.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(e => {
      const c = catalogIndex.get(e.card_id);
      const hay = [
        c?.name, c?.fullName, c?.variant, c?.id, c?.displayId, c?.setName,
        e.condition, e.notes, e.grading_company,
        ...(e.contributions || []).map(x => x.name),
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }, [entries, catalogIndex, colQ]);

  const sortedEntries = useMemo(() => {
    const arr = [...searchedEntries];
    const cardOf = (e) => catalogIndex.get(e.card_id);
    switch (entrySort) {
      case 'name':
        arr.sort((a, b) => (cardOf(a)?.name || '').localeCompare(cardOf(b)?.name || ''));
        break;
      case 'set':
        arr.sort((a, b) => {
          const ca = cardOf(a), cb = cardOf(b);
          if (!ca && !cb) return 0;
          if (!ca) return 1;
          if (!cb) return -1;
          if (ca.setId !== cb.setId) return compareSets(ca, cb);
          return (ca.displayId || ca.id || '').localeCompare(cb.displayId || cb.id || '');
        });
        break;
      case 'market-desc': arr.sort((a, b) => marketValueOf(b) - marketValueOf(a)); break;
      case 'market-asc':  arr.sort((a, b) => marketValueOf(a) - marketValueOf(b)); break;
      case 'paid-desc':   arr.sort((a, b) => (Number(b.purchase_price)||0) - (Number(a.purchase_price)||0)); break;
      case 'paid-asc':    arr.sort((a, b) => (Number(a.purchase_price)||0) - (Number(b.purchase_price)||0)); break;
      case 'acquired-desc': arr.sort((a, b) => (b.acquired_at || b.added_at || '').localeCompare(a.acquired_at || a.added_at || '')); break;
      case 'acquired-asc':  arr.sort((a, b) => (a.acquired_at || a.added_at || '').localeCompare(b.acquired_at || b.added_at || '')); break;
      case 'recent':
      default:
        arr.sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''));
    }
    return arr;
    // variantRev forces resort when fresh PC prices land
  }, [searchedEntries, catalogIndex, entrySort, variantRev, marketValueOf]);
  const stats = useMemo(() => {
    let totalPaid = 0, totalMarket = 0, gradedCount = 0, totalExpenses = 0;
    for (const e of entries) {
      totalPaid += Number(e.purchase_price) || 0;
      totalExpenses += expensesByEntry.get(e.id) || 0;
      if (e.grading_company) {
        // Graded: only the manual graded_price counts; missing → 0 (don't
        // fall back to raw, since slabbed value isn't raw value).
        const gp = Number(e.graded_price) || 0;
        totalMarket += gp;
        gradedCount += 1;
      } else {
        const card = catalogIndex.get(e.card_id);
        if (card) totalMarket += effectiveRawPrice(card);
      }
    }
    return { totalPaid, totalExpenses, totalMarket, count: entries.length, gradedCount };
    // variantRev forces recompute when PC variant snapshots land
  }, [entries, catalogIndex, expensesByEntry, variantRev]);

  const totalCostBasis = stats.totalPaid + stats.totalExpenses;
  const profit = stats.totalMarket - totalCostBasis;
  const profitPct = totalCostBasis > 0 ? (profit / totalCostBasis) * 100 : 0;

  return (
    <div className="op-view">
      <div className="op-page-head">
        <div>
          <div className="op-eyebrow">Active Collection</div>
          <h1 className="op-page-title">{collection?.name || 'No collection'}</h1>
          <div className="op-page-sub">{stats.count} {stats.count === 1 ? 'card' : 'cards'} logged in this collection</div>
        </div>
        <div className="op-page-head-actions">
          {onAddByCertClick && (
            <button className="op-btn-ghost" onClick={onAddByCertClick} title="Add a PSA-graded card by entering its cert number">
              <Award size={15} /> Add by cert
            </button>
          )}
          <button className="op-btn-primary" onClick={onSearchClick}>
            <Plus size={16} /> Add Cards
          </button>
        </div>
      </div>

      {!isSynthetic && onUpdateMembers && (
        <MembersPanel members={members} onUpdate={onUpdateMembers} />
      )}

      <div className="op-stats">
        <Stat
          label="Paid In"
          value={`$${stats.totalPaid.toFixed(2)}`}
          sub={stats.totalExpenses > 0 ? `+ $${stats.totalExpenses.toFixed(2)} expenses` : null}
        />
        <Stat label="Market Value" value={`$${stats.totalMarket.toFixed(2)}`} accent />
        <Stat
          label={profit >= 0 ? 'Unrealized Gain' : 'Unrealized Loss'}
          value={`${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`}
          sub={`${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%`}
          tone={profit >= 0 ? 'pos' : 'neg'}
        />
        <Stat label="Cards Tracked" value={stats.count} />
      </div>

      {entries.length === 0 ? (
        <div className="op-empty">
          <Package size={36} strokeWidth={1.2} />
          <div className="op-empty-title">This collection is empty</div>
          <div className="op-empty-sub">Search the One Piece TCG catalog and add your first card to start tracking.</div>
          <button className="op-btn-primary" onClick={onSearchClick}>
            <Search size={15} /> Open the Catalog
          </button>
        </div>
      ) : (
        <>
          <div className="op-search-bar op-search-bar-inline">
            <Search size={16} className="op-search-icon" />
            <input
              className="op-search-input"
              placeholder="Search this collection — name, ID, set, owner, notes…"
              value={colQ}
              onChange={(e) => setColQ(e.target.value)}
            />
            {colQ && (
              <button className="op-search-clear" onClick={() => setColQ('')}>
                <X size={15} />
              </button>
            )}
          </div>
          <div className="op-entries-sort">
            <span className="op-entries-sort-label">Sort by</span>
            <select value={entrySort} onChange={(e) => setEntrySort(e.target.value)}>
              <option value="recent">Recently logged</option>
              <option value="acquired-desc">Date acquired (newest)</option>
              <option value="acquired-asc">Date acquired (oldest)</option>
              <option value="name">Name (A → Z)</option>
              <option value="set">Set</option>
              <option value="market-desc">Market value ↓</option>
              <option value="market-asc">Market value ↑</option>
              <option value="paid-desc">Paid ↓</option>
              <option value="paid-asc">Paid ↑</option>
            </select>
          </div>
          <div className="op-entries">
            {sortedEntries.map(entry => {
              const card = catalogIndex.get(entry.card_id);
              if (!card) {
                return (
                  <div key={entry.id} className="op-entry op-entry-missing">
                    <div className="op-entry-missing-text">Card {entry.card_id} not found in catalog</div>
                    <button className="op-entry-remove" onClick={() => onRemoveEntry(entry.id)}><X size={15} /></button>
                  </div>
                );
              }
              // Graded entries use only their stored graded_price; no raw
              // fallback. A graded entry without a price is "pending" — UI
              // renders the market column as "—" so the user knows to fill it in.
              const isGradedEntry = Boolean(entry.grading_company);
              const gradedPrice = Number(entry.graded_price) || 0;
              const marketKnown = isGradedEntry ? gradedPrice > 0 : true;
              const marketValue = isGradedEntry ? gradedPrice : effectiveRawPrice(card);
              const expenses = expensesByEntry.get(entry.id) || 0;
              const costBasis = (Number(entry.purchase_price) || 0) + expenses;
              const delta = marketKnown ? marketValue - costBasis : 0;
              return (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  card={card}
                  marketValue={marketValue}
                  marketKnown={marketKnown}
                  expenses={expenses}
                  costBasis={costBasis}
                  delta={delta}
                  onClick={() => onCardClick(card)}
                  onSell={() => onSellEntry(entry)}
                  onExpense={() => onExpenseEntry(entry)}
                  onEdit={() => onEditEntry(entry)}
                  onDelete={() => {
                    if (confirm(`Delete this ${card.name} entry? This doesn't record a sale — use the $ button if you sold the card.`)) {
                      onRemoveEntry(entry.id);
                    }
                  }}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// EquityPanel: who owns how much of this collection.
//
// Two modes:
//   - 'capital' (default): equity % = your_contributions / total_contributions.
//     Ignores market and timing.
//   - 'time-weighted': fund-accounting unit model. Each contribution issues
//     units priced against the collection's NAV (current market value of
//     cards already in the pool) at the time of that contribution. Earlier
//     contributors capture pre-contribution appreciation; later contributors
//     buy in at the inflated unit price. Uses CURRENT market prices to
//     approximate NAV at each point in time (we don't have historical
//     per-card prices), so it's directionally correct but not exact for
//     long-running collections.
//
// Entries without a `contributions` array fall back to a single contribution
// of `purchase_price` attributed to `owner_name` (or "Unattributed").
function EquityPanel({ entries, transactions = [], catalogIndex, totalMarket, collectionId }) {
  const [mode, setMode] = useState('capital');

  const equity = useMemo(() => {
    // Build a per-tx signed contribution iterator. Sign convention:
    //   buy / expense: contributors put money in (positive = money in)
    //   sell / payout: contributors took money out (positive in storage,
    //                  negated here so equity reduces their net contribution)
    //   transfer:      contributions are already signed (positive = sender, negative = receiver)
    const signedContribsOf = (tx) => {
      const list = Array.isArray(tx.contributions) ? tx.contributions : [];
      return list.flatMap(c => {
        const amt = Number(c.amount) || 0;
        if (!c.name || amt === 0) return [];
        if (tx.type === 'sell' || tx.type === 'payout') return [{ name: c.name.trim(), amount: -Math.abs(amt) }];
        if (tx.type === 'transfer') return [{ name: c.name.trim(), amount: amt }];
        // buy / expense (and anything else): positive amount means money in.
        return [{ name: c.name.trim(), amount: amt }];
      });
    };

    // Legacy entries that pre-date the transaction log have contributions on
    // the entry itself but no matching buy tx. Detect & include them so old
    // data doesn't vanish from the equity panel.
    const allMode = !collectionId || collectionId === 'all';
    const scopedTxs = allMode ? transactions : transactions.filter(t => t.collection_id === collectionId);
    const buyTxKeys = new Set(
      scopedTxs.filter(t => t.type === 'buy').map(t => `${t.card_id}|${(t.occurred_at || t.created_at || '').slice(0, 10)}`)
    );
    const legacyBuyContribs = entries
      .filter(e => {
        if (!allMode && e.collection_id !== collectionId) return false;
        if (!Array.isArray(e.contributions) || e.contributions.length === 0) return false;
        const key = `${e.card_id}|${(e.acquired_at || e.added_at || '').slice(0, 10)}`;
        return !buyTxKeys.has(key);
      })
      .flatMap(e => e.contributions.map(c => ({
        name: c.name?.trim() || 'Unattributed',
        amount: Number(c.amount) || 0,
        date: e.acquired_at || (e.added_at || '').slice(0, 10),
      })).filter(c => c.amount > 0));

    if (mode === 'capital') {
      const totals = new Map();
      const gross = new Map(); // gross in (positive contributions only) for "Contributed" column
      for (const tx of scopedTxs) {
        for (const c of signedContribsOf(tx)) {
          totals.set(c.name, (totals.get(c.name) || 0) + c.amount);
          if (c.amount > 0) gross.set(c.name, (gross.get(c.name) || 0) + c.amount);
        }
      }
      for (const c of legacyBuyContribs) {
        totals.set(c.name, (totals.get(c.name) || 0) + c.amount);
        gross.set(c.name, (gross.get(c.name) || 0) + c.amount);
      }

      // Equity % uses positive net only; members in the red get 0%.
      const positiveNets = Array.from(totals.values()).filter(v => v > 0);
      const positiveSum = positiveNets.reduce((s, v) => s + v, 0);

      const rows = Array.from(totals.entries())
        .filter(([name, net]) => name && (net !== 0 || gross.get(name)))
        .map(([name, net]) => ({
          name,
          paid: gross.get(name) || 0,
          net,
          units: null,
          pct: net > 0 && positiveSum > 0 ? net / positiveSum : 0,
          value: net > 0 && positiveSum > 0 ? totalMarket * (net / positiveSum) : 0,
        }))
        .sort((a, b) => b.net - a.net);
      const totalPaid = Array.from(gross.values()).reduce((s, v) => s + v, 0);

      return { rows, totalPaid, totalUnits: null };
    }

    // Time-weighted: fund-accounting units. Walk transactions chronologically.
    //   buy / expense: cash in → issue units to contributors at current unit price.
    //                  NAV grows by their cash; for buys, also bump NAV by any
    //                  card-market premium over what was paid (deal upside).
    //   sell:          cash out → redeem units from each recipient at current
    //                  unit price. NAV shrinks by the cash distributed.
    //   transfer:      no NAV change. Sender's units are redeemed and reissued
    //                  to receiver at current unit price (zero-sum).
    // Legacy entries (no buy tx) are treated as a synthetic buy tx in date order.
    const dateOfTx = (t) => (t.occurred_at || t.created_at || '').slice(0, 10);
    const events = [
      ...scopedTxs.map(t => ({ kind: t.type, date: dateOfTx(t), tx: t })),
      ...legacyBuyContribs.length > 0
        ? entries
            .filter(e => {
              if (!allMode && e.collection_id !== collectionId) return false;
              if (!Array.isArray(e.contributions) || e.contributions.length === 0) return false;
              const key = `${e.card_id}|${(e.acquired_at || e.added_at || '').slice(0, 10)}`;
              return !buyTxKeys.has(key);
            })
            .map(e => ({
              kind: 'buy',
              date: e.acquired_at || (e.added_at || '').slice(0, 10),
              tx: { type: 'buy', card_id: e.card_id, contributions: e.contributions, amount: Number(e.purchase_price) || 0 },
            }))
        : [],
    ].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const units = new Map();
    const grossIn = new Map();
    let totalUnits = 0;
    let nav = 0;

    const currentNavOfCard = (cardId) => {
      const c = catalogIndex.get(cardId);
      return c ? effectiveRawPrice(c) : 0;
    };

    for (const ev of events) {
      const t = ev.tx;
      const unitPrice = totalUnits > 0 && nav > 0 ? nav / totalUnits : 1;
      for (const c of signedContribsOf(t)) {
        if (c.amount === 0) continue;
        const issued = c.amount / unitPrice;
        units.set(c.name, (units.get(c.name) || 0) + issued);
        totalUnits += issued;
        if (c.amount > 0) grossIn.set(c.name, (grossIn.get(c.name) || 0) + c.amount);
        nav += c.amount; // signed cash flow into the pool
      }
      // For buys, bump NAV to reflect today's market value of the acquired
      // card — positive when the card's up vs. cost, negative when it's down.
      // Net effect: NAV change on a buy = card's current market (cash + delta).
      // This is what lets new contributions buy in at a depressed unit price
      // when the pool is underwater, and a premium when the pool is up.
      if (ev.kind === 'buy') {
        const market = currentNavOfCard(t.card_id);
        const paid = Number(t.amount) || 0;
        const bonus = market - paid;
        if (bonus !== 0) nav += bonus;
      }
      // For sells, the cash-out leg only reduced NAV by proceeds. The card
      // itself is also leaving the pool, so subtract its current market on
      // top — total NAV change ends up at -market, matching reality even if
      // proceeds came in below (or above) today's market.
      if (ev.kind === 'sell') {
        const market = currentNavOfCard(t.card_id);
        const proceeds = Number(t.amount) || 0;
        const adjustment = -(market - proceeds);
        if (adjustment !== 0) nav += adjustment;
      }
    }

    const positiveUnits = Array.from(units.values()).filter(v => v > 0).reduce((s, v) => s + v, 0);
    const rows = Array.from(units.entries())
      .filter(([name, u]) => name && (u !== 0 || grossIn.get(name)))
      .map(([name, u]) => ({
        name,
        paid: grossIn.get(name) || 0,
        net: grossIn.get(name) || 0,
        units: u,
        pct: u > 0 && positiveUnits > 0 ? u / positiveUnits : 0,
        value: u > 0 && positiveUnits > 0 ? totalMarket * (u / positiveUnits) : 0,
      }))
      .sort((a, b) => b.units - a.units);
    return { rows, totalPaid: Array.from(grossIn.values()).reduce((s, v) => s + v, 0), totalUnits: positiveUnits };
  }, [entries, transactions, catalogIndex, totalMarket, mode, collectionId]);

  if (equity.rows.length === 0) return null;

  return (
    <div className="op-equity">
      <div className="op-equity-head">
        <div>
          <div className="op-eyebrow">Equity</div>
          <h2 className="op-equity-title">Capital &amp; ownership</h2>
          <div className="op-equity-sub">
            {mode === 'capital'
              ? 'Net per-member capital across buys, sells, transfers, and expenses. Ignores market timing.'
              : 'Fund-accounting units. Earlier net contributions to an appreciating pool get a bigger slice.'}
          </div>
        </div>
        <div className="op-equity-mode">
          <button className={`op-equity-mode-btn ${mode === 'capital' ? 'is-active' : ''}`} onClick={() => setMode('capital')}>Capital</button>
          <button className={`op-equity-mode-btn ${mode === 'time-weighted' ? 'is-active' : ''}`} onClick={() => setMode('time-weighted')}>Time-weighted</button>
        </div>
      </div>

      <div className="op-equity-table">
        <div className="op-equity-row op-equity-header-row">
          <div>Member</div>
          <div className="op-equity-num">Gross in</div>
          {mode === 'capital' && <div className="op-equity-num">Net</div>}
          {mode === 'time-weighted' && <div className="op-equity-num">Units</div>}
          <div className="op-equity-num">Equity %</div>
          <div className="op-equity-num">Stake value</div>
          <div className="op-equity-num">Gain</div>
        </div>
        {equity.rows.map(r => {
          const net = r.net != null ? r.net : r.paid;
          const gain = r.value - net;
          return (
            <div key={r.name} className="op-equity-row">
              <div className="op-equity-name">{r.name}</div>
              <div className="op-equity-num">${r.paid.toFixed(2)}</div>
              {mode === 'capital' && (
                <div className={`op-equity-num ${net >= 0 ? '' : 'is-neg'}`}>
                  {net >= 0 ? '' : '−'}${Math.abs(net).toFixed(2)}
                </div>
              )}
              {mode === 'time-weighted' && <div className="op-equity-num">{(r.units || 0).toFixed(2)}</div>}
              <div className="op-equity-num">{(r.pct * 100).toFixed(1)}%</div>
              <div className="op-equity-num">${r.value.toFixed(2)}</div>
              <div className={`op-equity-num ${gain >= 0 ? 'is-pos' : 'is-neg'}`}>
                {gain >= 0 ? '+' : ''}${gain.toFixed(2)}
              </div>
            </div>
          );
        })}
        <div className="op-equity-row op-equity-total-row">
          <div>Total</div>
          <div className="op-equity-num">${equity.totalPaid.toFixed(2)}</div>
          {mode === 'capital' && (
            <div className="op-equity-num">
              ${equity.rows.reduce((s, r) => s + (r.net != null ? r.net : r.paid), 0).toFixed(2)}
            </div>
          )}
          {mode === 'time-weighted' && <div className="op-equity-num">{(equity.totalUnits || 0).toFixed(2)}</div>}
          <div className="op-equity-num">100.0%</div>
          <div className="op-equity-num">${totalMarket.toFixed(2)}</div>
          <div className={`op-equity-num ${totalMarket - equity.totalPaid >= 0 ? 'is-pos' : 'is-neg'}`}>
            {totalMarket - equity.totalPaid >= 0 ? '+' : ''}${(totalMarket - equity.totalPaid).toFixed(2)}
          </div>
        </div>
      </div>
    </div>
  );
}

// Used in both AddCardModal and SellModal contribution sections. When members
// are configured on the active collection, the name field becomes a dropdown
// (with an "Other…" escape hatch to type a free-form name).
function ContribRow({ value, members = [], onChange, onRemove }) {
  const [customMode, setCustomMode] = useState(value.name && !members.includes(value.name));
  const useDropdown = members.length > 0 && !customMode;
  return (
    <div className="op-contrib-row">
      {useDropdown ? (
        <select
          value={value.name || ''}
          onChange={(e) => {
            if (e.target.value === '__other__') { setCustomMode(true); onChange({ name: '' }); }
            else onChange({ name: e.target.value });
          }}
        >
          <option value="">— Pick member —</option>
          {members.map(m => <option key={m} value={m}>{m}</option>)}
          <option value="__other__">Other…</option>
        </select>
      ) : (
        <input
          type="text" placeholder="Name"
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
          onBlur={() => { if (members.length > 0 && !value.name) setCustomMode(false); }}
        />
      )}
      <div className="op-contrib-amount">
        <DollarSign size={13} />
        <input
          type="number" step="0.01" placeholder="0.00"
          value={value.amount} onChange={(e) => onChange({ amount: e.target.value })}
        />
      </div>
      <button className="op-contrib-remove" onClick={onRemove}><X size={14} /></button>
    </div>
  );
}

function MembersPanel({ members, onUpdate }) {
  const [adding, setAdding] = useState('');

  const addMember = () => {
    const name = adding.trim();
    if (!name) return;
    if (members.includes(name)) { setAdding(''); return; }
    onUpdate([...members, name]);
    setAdding('');
  };
  const removeMember = (name) => {
    if (!confirm(`Remove "${name}" from this collection's members? Existing contributions stay intact, you just won't see their name in the dropdown anymore.`)) return;
    onUpdate(members.filter(m => m !== name));
  };

  return (
    <div className="op-members">
      <div className="op-members-label">Members</div>
      <div className="op-members-list">
        {members.length === 0 && <span className="op-members-empty">No members yet — add one to enable name dropdowns when splitting contributions.</span>}
        {members.map(m => (
          <span key={m} className="op-member-chip">
            {m}
            <button onClick={() => removeMember(m)} title={`Remove ${m}`}><X size={11} /></button>
          </span>
        ))}
        <input
          className="op-members-add"
          placeholder="+ Add member"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addMember(); }}
          onBlur={addMember}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone, accent }) {
  return (
    <div className={`op-stat ${accent ? 'is-accent' : ''} ${tone ? `is-${tone}` : ''}`}>
      <div className="op-stat-label">{label}</div>
      <div className="op-stat-value">{value}</div>
      {sub && <div className="op-stat-sub">{sub}</div>}
    </div>
  );
}

function EntryRow({ entry, card, marketValue, marketKnown = true, expenses = 0, costBasis, delta, onClick, onSell, onExpense, onEdit, onDelete }) {
  const isGraded = Boolean(entry.grading_company);
  const paid = Number(entry.purchase_price || 0);
  const hasExpenses = expenses > 0;
  return (
    <div className="op-entry">
      <button className="op-entry-main" onClick={onClick}>
        <CardThumb card={card} size={48} />
        <div className="op-entry-info">
          <div className="op-entry-cardname">
            <span className="op-entry-cardname-text">{card.name}</span>
            <VariantPill variant={card.variant} />
            {isGraded
              ? <GradingBadge company={entry.grading_company} grade={entry.grade} bgsBlack={entry.bgs_black} gradeDescription={entry.grade_description} />
              : <RawBadge condition={entry.condition} />}
          </div>
          <div className="op-entry-cardset">
            <span className="op-entry-id">{card.displayId || card.id}</span> · {card.setName} · {RARITY_LABELS[card.rarity] || card.rarity}
          </div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">{hasExpenses ? 'Cost basis' : 'Paid'}</div>
          <div className="op-entry-cell-val">${(costBasis ?? paid).toFixed(2)}</div>
          {hasExpenses && (
            <div className="op-entry-cell-sub">${paid.toFixed(2)} + ${expenses.toFixed(2)} exp</div>
          )}
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">Market</div>
          <div className="op-entry-cell-val" title={!marketKnown ? 'No graded price entered yet — edit the entry to add one' : undefined}>
            {marketKnown ? `$${(marketValue || 0).toFixed(2)}` : '—'}
          </div>
          {!marketKnown && (
            <div className="op-entry-cell-sub">graded price pending</div>
          )}
        </div>
        {marketKnown ? (
          <div className={`op-entry-delta ${delta >= 0 ? 'is-pos' : 'is-neg'}`}>
            {delta >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            {delta >= 0 ? '+' : ''}${delta.toFixed(2)}
          </div>
        ) : (
          <div className="op-entry-delta">—</div>
        )}
      </button>
      <button className="op-entry-remove" onClick={onEdit} title="Edit entry">
        <Pencil size={14} />
      </button>
      {onExpense && (
        <button className="op-entry-remove op-entry-expense" onClick={onExpense} title="Log an expense for this card (grading, shipping, etc.)">
          <Plus size={14} />
        </button>
      )}
      <button className="op-entry-remove op-entry-sell" onClick={onSell} title="Record a sale">
        <DollarSign size={14} />
      </button>
      <button className="op-entry-remove" onClick={onDelete} title="Delete entry (no transaction logged)">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function GradingBadge({ company, grade, bgsBlack, gradeDescription }) {
  const label = bgsBlack ? `${company} ${grade} BL` : `${company} ${grade}`;
  const classKey = bgsBlack ? 'bgs-black' : (company || '').toLowerCase();
  // Prefer the verbatim PSA grade description on hover when it's available
  // ("GEM MT 10"); else fall back to "BGS 10 Black Label" or "PSA 10".
  const titleText = bgsBlack
    ? `${company} ${grade} Black Label (Perfect 10)`
    : (gradeDescription || `${company} ${grade}`);
  return (
    <span className={`op-grade-badge is-${classKey}`} title={titleText}>
      <Award size={11} />
      {label}
    </span>
  );
}

// Compact condition labels for the raw badge (don't blow up the chip width).
const CONDITION_ABBR = {
  'Mint': 'M', 'Near Mint': 'NM', 'Lightly Played': 'LP',
  'Moderately Played': 'MP', 'Heavily Played': 'HP', 'Damaged': 'DMG',
};
function RawBadge({ condition }) {
  const cond = condition && CONDITION_ABBR[condition] ? CONDITION_ABBR[condition] : null;
  return (
    <span className="op-grade-badge is-raw" title={condition ? `Raw · ${condition}` : 'Raw / Ungraded'}>
      Raw{cond ? ` ${cond}` : ''}
    </span>
  );
}

function VariantPill({ variant }) {
  if (!variant) return null;
  return <span className="op-variant-pill" title={variant}>{variant}</span>;
}

function CardThumb({ card, size = 60 }) {
  const [errored, setErrored] = useState(false);
  const [ref, imageUrl] = useEnhancedImage(card);
  if (!imageUrl || errored) {
    return (
      <div
        ref={ref}
        className="op-card-thumb-fallback"
        style={{ width: size, height: size * 1.4, background: `linear-gradient(135deg, ${fallbackColor(card.color)} 0%, ${fallbackColor(card.color)}aa 100%)` }}
      >
        <ImageOff size={size / 3} opacity={0.5} />
      </div>
    );
  }
  return (
    <img
      ref={ref}
      src={imageUrl}
      alt={card.name}
      className="op-card-thumb"
      style={{ width: size, height: size * 1.4 }}
      loading="lazy"
      onError={() => setErrored(true)}
    />
  );
}

// ============================================================================
function SearchView({ catalog, watchlist = [], variantRev = 0, onAddCard, onCardClick, onToggleWatch = () => {} }) {
  const watchedIds = useMemo(() => new Set(watchlist.map(w => w.card_id)), [watchlist]);
  const [q, setQ] = useStoredState('optcg:search:q', '');
  const [setFilter, setSetFilter] = useStoredState('optcg:search:setFilter', 'all');
  const [filterDim, setFilterDim] = useStoredState('optcg:search:filterDim', 'none'); // 'none' | 'rarity' | 'color'
  const [filterValue, setFilterValue] = useStoredState('optcg:search:filterValue', 'all');
  const [sortBy, setSortBy] = useStoredState('optcg:search:sortBy', 'set'); // 'set' | 'name' | 'price-desc' | 'price-asc'
  // Stage 4 removed the "Price as" tier toggle (raw only). Stage 5 will
  // garbage-collect the persisted localStorage value.
  // Hide filter: per-dimension Sets so multiple hides apply at once. `hideDim`
  // controls which dimension's pills are visible — the other dimensions stay
  // active in the background.
  const [hideDim, setHideDim] = useStoredState('optcg:search:hideDim', 'none'); // 'none' | 'rarity' | 'color' | 'type'
  const [hiddenByDim, setHiddenByDim] = useStoredState(
    'optcg:search:hiddenByDim',
    () => ({ rarity: new Set(), color: new Set(), type: new Set() }),
    {
      serialize: (v) => JSON.stringify({ rarity: [...v.rarity], color: [...v.color], type: [...v.type] }),
      deserialize: (s) => {
        const o = JSON.parse(s);
        return { rarity: new Set(o.rarity || []), color: new Set(o.color || []), type: new Set(o.type || []) };
      },
    }
  );

  const currentHidden = hideDim !== 'none' ? hiddenByDim[hideDim] : null;
  const totalHidden = hiddenByDim.rarity.size + hiddenByDim.color.size + hiddenByDim.type.size;

  const toggleHiddenValue = (val) => {
    if (hideDim === 'none') return;
    setHiddenByDim(prev => {
      const next = new Set(prev[hideDim]);
      if (next.has(val)) next.delete(val); else next.add(val);
      return { ...prev, [hideDim]: next };
    });
  };
  const clearCurrentDim = () => {
    if (hideDim === 'none') return;
    setHiddenByDim(prev => ({ ...prev, [hideDim]: new Set() }));
  };
  const clearAllHides = () => setHiddenByDim({ rarity: new Set(), color: new Set(), type: new Set() });

  // Pills for the active hide dimension. Rarity & color are fixed lists; type
  // is derived from the catalog so we cover every card_type the API returns.
  const hideValueOptions = useMemo(() => {
    if (hideDim === 'rarity') {
      return ['L','SR','SEC','R','UC','C','P','SP','TR'].map(v => ({ v, l: RARITY_LABELS[v] || v }));
    }
    if (hideDim === 'color') {
      return ['Red','Blue','Green','Yellow','Purple','Black','Multicolor'].map(v => ({ v, l: v }));
    }
    if (hideDim === 'type') {
      const seen = new Set();
      for (const c of catalog) if (c.type) seen.add(c.type);
      return [...seen].sort().map(v => ({ v, l: v }));
    }
    return [];
  }, [hideDim, catalog]);

  // All distinct sets, sorted
  const sets = useMemo(() => {
    const m = new Map();
    for (const c of catalog) {
      if (!c.setId) continue;
      if (!m.has(c.setId)) m.set(c.setId, { id: c.setId, name: c.setName });
    }
    return Array.from(m.values()).sort((a, b) => compareSets({ setId: a.id }, { setId: b.id }));
  }, [catalog]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const fieldByDim = { rarity: 'rarity', color: 'color' };
    const activeField = fieldByDim[filterDim];
    return catalog.filter(c => {
      if (hiddenByDim.rarity.has(c.rarity)) return false;
      if (hiddenByDim.color.has(c.color)) return false;
      if (hiddenByDim.type.has(c.type)) return false;
      if (setFilter !== 'all' && c.setId !== setFilter) return false;
      if (activeField && filterValue !== 'all' && c[activeField] !== filterValue) return false;
      if (!needle) return true;
      return (c.name || '').toLowerCase().includes(needle) ||
        (c.fullName || '').toLowerCase().includes(needle) ||
        (c.variant || '').toLowerCase().includes(needle) ||
        (c.id || '').toLowerCase().includes(needle) ||
        (c.displayId || '').toLowerCase().includes(needle) ||
        (c.setName || '').toLowerCase().includes(needle) ||
        (c.text || '').toLowerCase().includes(needle);
    });
  }, [catalog, q, setFilter, filterDim, filterValue, hiddenByDim]);

  // Values for the secondary cascade dropdown.
  const filterValueOptions = useMemo(() => {
    if (filterDim === 'rarity') {
      return [
        { v: 'all', l: 'All rarities' }, { v: 'L', l: 'Leader' }, { v: 'SR', l: 'Super Rare' },
        { v: 'SEC', l: 'Secret' }, { v: 'R', l: 'Rare' }, { v: 'UC', l: 'Uncommon' },
        { v: 'C', l: 'Common' }, { v: 'P', l: 'Promo' },
      ];
    }
    if (filterDim === 'color') {
      return [
        { v: 'all', l: 'All colors' }, { v: 'Red', l: 'Red' }, { v: 'Blue', l: 'Blue' },
        { v: 'Green', l: 'Green' }, { v: 'Yellow', l: 'Yellow' },
        { v: 'Purple', l: 'Purple' }, { v: 'Black', l: 'Black' },
      ];
    }
    return [];
  }, [filterDim]);

  const changeFilterDim = (dim) => {
    setFilterDim(dim);
    setFilterValue('all');
  };

  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sortBy === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (sortBy === 'price-desc') arr.sort((a, b) => effectiveRawPrice(b) - effectiveRawPrice(a));
    else if (sortBy === 'price-asc') arr.sort((a, b) => effectiveRawPrice(a) - effectiveRawPrice(b));
    else arr.sort((a, b) => {
      if (a.setId !== b.setId) return compareSets(a, b);
      return (a.id || '').localeCompare(b.id || '');
    });
    return arr;
    // variantRev forces the array to re-create when fresh prices land, so
    // tiles re-render with the latest cached price too.
  }, [filtered, sortBy, variantRev]); // eslint-disable-line react-hooks/exhaustive-deps

  // When sorting by set, group; otherwise flat list
  const grouped = useMemo(() => sortBy === 'set' ? groupBySet(sorted) : null, [sortBy, sorted]);

  return (
    <div className="op-view">
      <div className="op-page-head">
        <div>
          <div className="op-eyebrow">Catalog</div>
          <h1 className="op-page-title">Card Search</h1>
          <div className="op-page-sub">{catalog.length.toLocaleString()} cards indexed · live prices from OPTCGAPI</div>
        </div>
      </div>

      <div className="op-search-bar">
        <Search size={18} className="op-search-icon" />
        <input
          autoFocus
          className="op-search-input"
          placeholder="Search by name, card ID, set, or card text…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button className="op-search-clear" onClick={() => setQ('')}>
            <X size={16} />
          </button>
        )}
      </div>

      <div className="op-filters">
        <FilterGroup label="Set" value={setFilter} onChange={setSetFilter} mode="select" options={[
          { v: 'all', l: 'All Sets' },
          ...sets.map(s => ({ v: s.id, l: `${s.id} · ${s.name}` })),
        ]} />

        <FilterGroup label="Refine by" value={filterDim} onChange={changeFilterDim} mode="select" options={[
          { v: 'none', l: 'No refinement' },
          { v: 'rarity', l: 'Rarity' },
          { v: 'color', l: 'Color' },
        ]} />

        {filterDim !== 'none' && (
          <FilterGroup
            label={filterDim === 'rarity' ? 'Rarity' : 'Color'}
            value={filterValue}
            onChange={setFilterValue}
            mode="select"
            options={filterValueOptions}
          />
        )}

        <FilterGroup label="Sort" value={sortBy} onChange={setSortBy} options={[
          { v: 'set', l: 'By Set' },
          { v: 'name', l: 'Name' },
          { v: 'price-desc', l: 'Price ↓' },
          { v: 'price-asc', l: 'Price ↑' },
        ]} />

        <FilterGroup label={`Hide by${totalHidden > 0 ? ` (${totalHidden})` : ''}`} value={hideDim} onChange={setHideDim} mode="select" options={[
          { v: 'none', l: 'Nothing hidden' },
          { v: 'rarity', l: `Rarity${hiddenByDim.rarity.size > 0 ? ` · ${hiddenByDim.rarity.size}` : ''}` },
          { v: 'color', l: `Color${hiddenByDim.color.size > 0 ? ` · ${hiddenByDim.color.size}` : ''}` },
          { v: 'type', l: `Card type${hiddenByDim.type.size > 0 ? ` · ${hiddenByDim.type.size}` : ''}` },
        ]} />

        {hideDim !== 'none' && (
          <div className="op-filter-group">
            <div className="op-filter-label">
              {`Hide ${hideDim}${currentHidden && currentHidden.size > 0 ? ` (${currentHidden.size})` : ''}`}
              {currentHidden && currentHidden.size > 0 && (
                <button className="op-clear-filters" style={{ marginLeft: 8 }} onClick={clearCurrentDim}>clear</button>
              )}
            </div>
            <div className="op-filter-pills">
              {hideValueOptions.map(o => (
                <button
                  key={o.v}
                  className={`op-filter-pill is-compact ${currentHidden && currentHidden.has(o.v) ? 'is-active' : ''}`}
                  onClick={() => toggleHiddenValue(o.v)}
                  title={`Hide ${o.l}`}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="op-results-count">
        {sorted.length.toLocaleString()} {sorted.length === 1 ? 'result' : 'results'}
        {(q || setFilter !== 'all' || totalHidden > 0 || (filterDim !== 'none' && filterValue !== 'all')) && (
          <button className="op-clear-filters" onClick={() => {
            setQ(''); setSetFilter('all'); setFilterDim('none'); setFilterValue('all'); setHideDim('none'); clearAllHides();
          }}>Clear filters</button>
        )}
      </div>

      {grouped ? (
        <div>
          {grouped.map(group => (
            <SetGroup
              key={group.setId}
              group={group}
              onAddCard={onAddCard}
              onCardClick={onCardClick}
              onToggleWatch={onToggleWatch}
              watchedIds={watchedIds}
            />
          ))}
        </div>
      ) : (
        <div className="op-card-grid">
          {sorted.map(card => (
            <CardTile
              key={card.id}
              card={card}
              onAddCard={onAddCard}
              onCardClick={onCardClick}
              onToggleWatch={onToggleWatch}
              isWatched={watchedIds.has(card.canonicalId || card.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
function SellModal({ entry, card, members = [], onClose, onSave }) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [contributions, setContributions] = useState(
    (entry.contributions && entry.contributions.length > 0)
      ? entry.contributions.map(c => ({ name: c.name, amount: '' }))
      : []
  );
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const addRow = () => setContributions([...contributions, { name: '', amount: '' }]);
  const updateRow = (i, patch) => setContributions(contributions.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const removeRow = (i) => setContributions(contributions.filter((_, idx) => idx !== i));

  const amountNum = Number(amount) || 0;
  const paid = Number(entry.purchase_price) || 0;
  const profit = amountNum - paid;
  const splitTotal = contributions.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const splitMismatch = contributions.length > 0 && Math.abs(splitTotal - amountNum) > 0.01;

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      amount: amountNum,
      date: date || null,
      notes: notes.trim(),
      contributions: contributions.filter(c => c.name.trim() && Number(c.amount) > 0).map(c => ({ name: c.name.trim(), amount: Number(c.amount) })),
    });
    setSaving(false);
  };

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="op-modal-header">
          {card && <div className="op-modal-art-wrap"><CardArt card={card} /></div>}
          <div>
            <div className="op-eyebrow">Recording sale</div>
            <div className="op-modal-title">{card ? card.name : entry.card_id}</div>
            <div className="op-modal-sub">
              {card ? `${card.displayId || card.id} · ${card.setName}` : ''}
            </div>
            <div className="op-modal-market">
              Originally paid: <strong>${paid.toFixed(2)}</strong>
            </div>
          </div>
        </div>

        <div className="op-form">
          <div className="op-form-row">
            <Field label="Sale price (USD)">
              <input
                type="number" step="0.01" placeholder="0.00"
                value={amount} onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            </Field>
            <Field label="Date of sale">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>

          {amount && (
            <div className={`op-graded-meta ${profit >= 0 ? '' : 'op-graded-error'}`}>
              {profit >= 0 ? 'Realized gain' : 'Realized loss'}: <strong>{profit >= 0 ? '+' : ''}${profit.toFixed(2)}</strong>
              {paid > 0 && <> ({((profit / paid) * 100).toFixed(1)}%)</>}
            </div>
          )}

          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">Who receives the proceeds</div>
                <div className="op-form-section-sub">Split the sale among contributors. Leave empty if one person keeps it all.</div>
              </div>
              <button className="op-btn-ghost" onClick={addRow}>
                <Plus size={14} /> Add split
              </button>
            </div>

            {contributions.map((c, i) => (
              <ContribRow
                key={i}
                value={c}
                members={members}
                onChange={(patch) => updateRow(i, patch)}
                onRemove={() => removeRow(i)}
              />
            ))}

            {contributions.length > 0 && (
              <div className={`op-contrib-check ${splitMismatch ? 'is-warn' : 'is-ok'}`}>
                Splits total: <strong>${splitTotal.toFixed(2)}</strong> of <strong>${amountNum.toFixed(2)}</strong>
                {splitMismatch && <span> · doesn't match sale price</span>}
              </div>
            )}
          </div>

          <Field label="Notes (optional)">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Buyer name, marketplace, etc." />
          </Field>

          <div className="op-form-actions">
            <button className="op-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="op-btn-primary" onClick={handleSave} disabled={saving || amountNum <= 0}>
              {saving ? 'Saving…' : 'Record sale'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// WatchView: cards you're tracking for new listings. Scraper integration is
// stubbed for now — each row exposes target price, notes, and a placeholder
// for the most recent listing the scraper found (last_seen_*). When a scraper
// pipeline lands later it just needs to call `updateWatchlistItem(id, {
// last_checked_at, last_seen_url, last_seen_price, last_seen_source })`.
function WatchView({ watchlist, catalogIndex, variantRev = 0, onCardClick, onBrowseCatalog = () => {}, onRemove, onUpdate }) {
  const [q, setQ] = useStoredState('optcg:watch:q', '');

  const enriched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return watchlist
      .map(w => ({ w, card: catalogIndex.get(w.card_id) }))
      .filter(({ w, card }) => {
        if (!needle) return true;
        const hay = [w.card_display_name, card?.name, card?.fullName, w.notes, card?.setName].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(needle);
      })
      .sort((a, b) => (b.w.created_at || '').localeCompare(a.w.created_at || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist, catalogIndex, q, variantRev]);

  return (
    <div className="op-view">
      <div className="op-page-head">
        <div>
          <div className="op-eyebrow">Watch list</div>
          <h1 className="op-page-title">Cards on watch</h1>
          <div className="op-page-sub">
            {watchlist.length.toLocaleString()} {watchlist.length === 1 ? 'card' : 'cards'} · scraper integration pending — last-seen fields will populate once it's wired up
          </div>
        </div>
        <button className="op-btn-primary" onClick={onBrowseCatalog}>
          <Plus size={16} /> Add Cards
        </button>
      </div>

      <div className="op-search-bar op-search-bar-inline">
        <Search size={16} className="op-search-icon" />
        <input
          className="op-search-input"
          placeholder="Search your watch list…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button className="op-search-clear" onClick={() => setQ('')}><X size={15} /></button>
        )}
      </div>

      {watchlist.length === 0 ? (
        <div className="op-empty">
          <Eye size={36} strokeWidth={1.2} />
          <div className="op-empty-title">Nothing on watch yet</div>
          <div className="op-empty-sub">Open any card from search and click the Watch button to start tracking listings for it.</div>
        </div>
      ) : (
        <div className="op-watch-list">
          {enriched.map(({ w, card }) => (
            <WatchRow
              key={w.id}
              w={w}
              card={card}
              onCardClick={card ? () => onCardClick(card) : null}
              onRemove={() => onRemove(w.id)}
              onUpdate={(patch) => onUpdate(w.id, patch)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WatchRow({ w, card, onCardClick, onRemove, onUpdate }) {
  const [target, setTarget] = useState(w.target_price != null ? String(w.target_price) : '');
  const [notes, setNotes] = useState(w.notes || '');
  const raw = card ? effectiveRawPrice(card) : 0;
  const targetNum = Number(target) || 0;
  const lastSeen = Number(w.last_seen_price) || 0;
  const beatsTarget = targetNum > 0 && lastSeen > 0 && lastSeen <= targetNum;

  const commitTarget = () => {
    const next = target.trim() === '' ? null : Number(target);
    if (next !== w.target_price) onUpdate({ target_price: next });
  };
  const commitNotes = () => {
    if (notes !== (w.notes || '')) onUpdate({ notes });
  };

  return (
    <div className={`op-watch-row ${beatsTarget ? 'is-hit' : ''}`}>
      <button className="op-watch-art" onClick={onCardClick} disabled={!onCardClick} title={card ? 'Open card details' : 'Card not found in catalog'}>
        {card ? <CardThumb card={card} size={48} /> : <div className="op-card-thumb-fallback" style={{ width: 48, height: 67, background: 'var(--paper-warm)' }}><ImageOff size={16} opacity={0.5} /></div>}
      </button>
      <div className="op-watch-main">
        <div className="op-watch-name">{card ? card.name : w.card_display_name || w.card_id}</div>
        <div className="op-watch-meta">
          {card ? <>{card.displayId || card.id} · {card.setName}</> : <>{w.card_id} · (not in catalog)</>}
          {raw > 0 && <> · Raw <strong>${raw.toFixed(2)}</strong></>}
        </div>
      </div>
      <div className="op-watch-field">
        <label>Target $</label>
        <input
          type="number" step="0.01" placeholder="—"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onBlur={commitTarget}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      </div>
      <div className="op-watch-field op-watch-last-seen">
        <label>Last seen</label>
        {lastSeen > 0 ? (
          <a href={w.last_seen_url || '#'} target="_blank" rel="noreferrer" className={beatsTarget ? 'is-hit' : ''}>
            ${lastSeen.toFixed(2)}{w.last_seen_source ? ` · ${w.last_seen_source}` : ''}
          </a>
        ) : (
          <span className="op-watch-empty">—</span>
        )}
      </div>
      <div className="op-watch-notes">
        <label>Notes</label>
        <input
          type="text" placeholder="e.g. only PSA 10, must be English"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={commitNotes}
        />
      </div>
      <button className="op-entry-remove" onClick={onRemove} title="Remove from watch list">
        <X size={15} />
      </button>
    </div>
  );
}

// ============================================================================
// AddByCertModal: type a PSA cert number, we hit PSA's API, try to match the
// result against the OPTCG catalog, then save the entry with grading fields
// pre-filled. Falls back to a manual catalog picker if the auto-match misses.
function AddByCertModal({ catalog, collections, activeCollectionId, onClose, onSave }) {
  const [certNumber, setCertNumber] = useState('');
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');
  const [cert, setCert] = useState(null); // PSA cert payload (normalized)
  const [candidates, setCandidates] = useState([]); // all catalog cards sharing the matched displayId
  const [selectedCardId, setSelectedCardId] = useState(''); // which candidate the user picked
  const [overrideCardId, setOverrideCardId] = useState(''); // when no auto-match
  const [collectionId, setCollectionId] = useState(activeCollectionId || collections[0]?.id || null);
  const [purchasePrice, setPurchasePrice] = useState('');
  const [gradedPrice, setGradedPrice] = useState('');
  const [contributions, setContributions] = useState([]);
  const [acquiredAt, setAcquiredAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const collectionsList = collections.filter(c => c.id !== 'all');

  // Members for the contribution dropdowns come from the selected collection.
  const members = useMemo(() => {
    const col = collections.find(c => c.id === collectionId);
    return Array.isArray(col?.members) ? col.members : [];
  }, [collections, collectionId]);

  const addContribRow = () => setContributions([...contributions, { name: '', amount: '' }]);
  const updateContrib = (i, patch) => setContributions(contributions.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const removeContrib = (i) => setContributions(contributions.filter((_, idx) => idx !== i));

  const priceNum = Number(purchasePrice) || 0;
  const contribTotal = contributions.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const contribMismatch = contributions.length > 0 && Math.abs(contribTotal - priceNum) > 0.01;

  const doLookup = async () => {
    setError('');
    setCert(null);
    setCandidates([]);
    setSelectedCardId('');
    setOverrideCardId('');
    const cleaned = certNumber.trim();
    if (!cleaned) { setError('Enter a cert number.'); return; }
    setLooking(true);
    try {
      const result = await fetchCert(cleaned);
      if (!result) {
        setError(`PSA didn't find cert #${cleaned}.`);
        return;
      }
      setCert(result);
      const cands = findCandidateCards(result, catalog);
      setCandidates(cands);
      if (cands.length > 0) setSelectedCardId(cands[0].id);
    } catch (e) {
      setError(e.message || 'PSA lookup failed.');
    } finally {
      setLooking(false);
    }
  };

  const matchedCard = candidates.find(c => c.id === selectedCardId) || candidates[0] || null;
  // Manual override beats the auto-matched candidate when the user explicitly
  // picks something from the catalog search.
  const overrideCard = overrideCardId ? catalog.find(c => c.id === overrideCardId) : null;
  const card = overrideCard || matchedCard;

  const handleSave = async () => {
    if (!cert || !card) return;
    setSaving(true);
    await onSave({
      card_id: card.canonicalId || card.id,
      collection_id: collectionId,
      condition: 'Near Mint',
      purchase_price: priceNum,
      contributions: contributions
        .filter(c => c.name.trim() && Number(c.amount) > 0)
        .map(c => ({ name: c.name.trim(), amount: Number(c.amount) })),
      notes: notes.trim(),
      acquired_at: acquiredAt || null,
      grading_company: 'PSA',
      grade: cert.grade,
      grade_description: cert.grade_description || '',
      bgs_black: false,
      cert_number: cert.cert_number,
      graded_price: Number(gradedPrice) || 0,
    });
    setSaving(false);
  };

  // Manual catalog autocomplete when PSA's CardNumber doesn't match anything.
  const [pickerQ, setPickerQ] = useState('');
  const pickerResults = useMemo(() => {
    const q = pickerQ.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return catalog
      .filter(c => {
        const hay = [c.name, c.fullName, c.id, c.displayId].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 8);
  }, [catalog, pickerQ]);

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="op-modal-header">
          <div>
            <div className="op-eyebrow">PSA cert lookup</div>
            <div className="op-modal-title">Add by cert number</div>
            <div className="op-modal-sub">Pulls card + grade directly from PSA's API.</div>
          </div>
        </div>

        <div className="op-form">
          <Field label="PSA cert number">
            <div className="op-variant-row">
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 12345678"
                value={certNumber}
                autoFocus
                onChange={(e) => setCertNumber(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doLookup(); }}
              />
              <button type="button" className="op-btn-ghost" onClick={doLookup} disabled={looking}>
                {looking ? <Loader2 size={14} className="op-spin" /> : <Search size={14} />}
                {looking ? 'Looking up…' : 'Look up'}
              </button>
            </div>
          </Field>

          {error && <div className="op-graded-error">{error}</div>}

          {cert && (
            <div className="op-cert-result">
              <div className="op-cert-row">
                <span className="op-cert-label">PSA says</span>
                <span className="op-cert-val">
                  {cert.subject || '(no subject)'} · {cert.grade_description || (cert.grade != null ? `Grade ${cert.grade}` : '?')}
                  {cert.card_number && <> · {cert.card_number}</>}
                </span>
              </div>
              <details className="op-cert-debug">
                <summary>What PSA returned</summary>
                <pre>{JSON.stringify({
                  CardNumber: cert.raw?.CardNumber,
                  VarietyPedigree: cert.raw?.VarietyPedigree,
                  Subject: cert.raw?.Subject,
                  Brand: cert.raw?.Brand,
                  Year: cert.raw?.Year,
                  Category: cert.raw?.Category,
                  GradeDescription: cert.raw?.GradeDescription,
                }, null, 2)}</pre>
              </details>

              {matchedCard && (
                <div className="op-cert-match">
                  <CardArt card={matchedCard} />
                  <div className="op-cert-match-meta">
                    <div className="op-eyebrow">
                      {candidates.length > 1 ? `Pick the right printing (${candidates.length})` : 'Matched catalog card'}
                    </div>
                    <div className="op-cert-match-name">
                      {matchedCard.name}
                      <VariantPill variant={matchedCard.variant} />
                    </div>
                    <div className="op-cert-match-sub">
                      {matchedCard.displayId || matchedCard.id} · {matchedCard.setName} · {RARITY_LABELS[matchedCard.rarity] || matchedCard.rarity}
                    </div>
                    {candidates.length > 1 && (
                      <div className="op-cert-candidates">
                        {candidates.map(c => (
                          <button
                            key={c.id}
                            type="button"
                            className={`op-cert-pick ${selectedCardId === c.id ? 'is-active' : ''}`}
                            onClick={() => { setSelectedCardId(c.id); setOverrideCardId(''); }}
                            title={c.fullName || c.name}
                          >
                            <span className="op-entry-id">{c.displayId || c.id}</span>
                            {' · '}{c.setId}
                            {c.variant ? ` · ${c.variant}` : attrsOf(c).map(k => ` · ${attrLabel(k)}`).join('')}
                            {' · '}{RARITY_LABELS[c.rarity] || c.rarity}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <details className="op-cert-manual" {...(matchedCard ? {} : { open: true })}>
                <summary>
                  {matchedCard
                    ? "Wrong card? Search the catalog manually"
                    : `PSA returned card number ${cert.card_number || '?'} but nothing in the catalog matched. Pick the right card.`}
                </summary>
                <div style={{ marginTop: 8 }}>
                  <input
                    type="text"
                    placeholder="Search catalog by name or ID…"
                    value={pickerQ}
                    onChange={(e) => setPickerQ(e.target.value)}
                    style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--line-strong)', background: 'var(--paper)' }}
                  />
                  {pickerResults.length > 0 && (
                    <div className="op-cert-picker">
                      {pickerResults.map(c => (
                        <button
                          key={c.id}
                          className={`op-cert-pick ${overrideCardId === c.id ? 'is-active' : ''}`}
                          onClick={() => {
                            setOverrideCardId(c.id);
                            setSelectedCardId('');
                            setPickerQ(`${c.displayId || c.id} ${c.name}`);
                          }}
                        >
                          <span className="op-entry-id">{c.displayId || c.id}</span> {c.name} · {c.setName}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </details>

              <div className="op-form-row">
                <Field label="Collection">
                  <select value={collectionId || ''} onChange={(e) => setCollectionId(e.target.value)}>
                    {collectionsList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Field>
                <Field label="Total paid (USD)">
                  <input type="number" step="0.01" placeholder="0.00" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
                </Field>
                <Field label="Date acquired">
                  <input type="date" value={acquiredAt} onChange={(e) => setAcquiredAt(e.target.value)} />
                </Field>
              </div>

              <div className="op-form-section">
                <div className="op-form-section-head">
                  <div>
                    <div className="op-form-section-title">Who paid what</div>
                    <div className="op-form-section-sub">Split cost between people. Leave empty if one person paid in full.</div>
                  </div>
                  <button className="op-btn-ghost" onClick={addContribRow}>
                    <Plus size={14} /> Add split
                  </button>
                </div>
                {contributions.map((c, i) => (
                  <ContribRow
                    key={i}
                    value={c}
                    members={members}
                    onChange={(patch) => updateContrib(i, patch)}
                    onRemove={() => removeContrib(i)}
                  />
                ))}
                {contributions.length > 0 && (
                  <div className={`op-contrib-check ${contribMismatch ? 'is-warn' : 'is-ok'}`}>
                    Splits total: <strong>${contribTotal.toFixed(2)}</strong> of <strong>${priceNum.toFixed(2)}</strong>
                    {contribMismatch && <span> · doesn't match total paid</span>}
                  </div>
                )}
              </div>

              <div className="op-form-section">
                <div className="op-form-section-head">
                  <div>
                    <div className="op-form-section-title">
                      <Award size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                      Grade · {cert.grade_description || (cert.grade != null ? `PSA ${cert.grade}` : 'PSA')}
                    </div>
                    <div className="op-form-section-sub">
                      Pulled from PSA. Enter a graded market price manually; auto-fetch is parked until a graded data source lands.
                    </div>
                  </div>
                </div>
                <Field label="Graded market price (USD)">
                  <input
                    type="number" step="0.01" placeholder="0.00"
                    value={gradedPrice} onChange={(e) => setGradedPrice(e.target.value)}
                  />
                </Field>
              </div>

              <Field label="Notes (optional)">
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where bought, condition notes, etc." />
              </Field>

              <div className="op-form-actions">
                <button className="op-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
                <button className="op-btn-primary" onClick={handleSave} disabled={saving || !card || cert.grade == null}>
                  {saving ? 'Saving…' : 'Save to Collection'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
function TransferModal({ members = [], collection, onClose, onSave }) {
  const [fromName, setFromName] = useState(members[0] || '');
  const [toName, setToName] = useState(members[1] || '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const amt = Number(amount) || 0;
  const valid = fromName.trim() && toName.trim() && fromName !== toName && amt > 0;

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      collection_id: collection?.id || null,
      card_id: null,
      card_display_name: `Transfer · ${fromName} → ${toName}`,
      type: 'transfer',
      amount: amt,
      // Sign convention: sender is positive (money provided), receiver is
      // negative (money taken). The EquityPanel reads these as-is.
      contributions: [
        { name: fromName.trim(), amount: amt },
        { name: toName.trim(), amount: -amt },
      ],
      occurred_at: date || null,
      notes: notes.trim(),
    });
    setSaving(false);
  };

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="op-modal-header">
          <div>
            <div className="op-eyebrow">Logging cash transfer</div>
            <div className="op-modal-title">Cash between members</div>
            <div className="op-modal-sub">{collection?.name || 'Unscoped'}</div>
          </div>
        </div>

        <div className="op-form">
          <div className="op-form-row">
            <Field label="From">
              {members.length > 0 ? (
                <select value={fromName} onChange={(e) => setFromName(e.target.value)}>
                  <option value="">— Pick —</option>
                  {members.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Name" />
              )}
            </Field>
            <Field label="To">
              {members.length > 0 ? (
                <select value={toName} onChange={(e) => setToName(e.target.value)}>
                  <option value="">— Pick —</option>
                  {members.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input value={toName} onChange={(e) => setToName(e.target.value)} placeholder="Name" />
              )}
            </Field>
          </div>
          <div className="op-form-row">
            <Field label="Amount (USD)">
              <input type="number" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </Field>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Notes (optional)">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Venmo, cash, reason for transfer…" />
          </Field>
          <div className="op-form-actions">
            <button className="op-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="op-btn-primary" onClick={handleSave} disabled={saving || !valid}>
              {saving ? 'Saving…' : 'Record transfer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// ExpenseModal: pool-level or card-scoped expenses. When `card` and `entry`
// are supplied (e.g. opened from an entry row), the expense is tied to that
// specific copy via entry_id + card_id, so cost-basis can roll it in and
// equity tracks who paid for grading / shipping / etc.
function ExpenseModal({ members = [], collection, card = null, entry = null, onClose, onSave }) {
  const cardScoped = Boolean(card && entry);
  const [description, setDescription] = useState(cardScoped ? 'Grading fee' : '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [contributions, setContributions] = useState([]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const addRow = () => setContributions([...contributions, { name: '', amount: '' }]);
  const updateRow = (i, patch) => setContributions(contributions.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const removeRow = (i) => setContributions(contributions.filter((_, idx) => idx !== i));

  const amt = Number(amount) || 0;
  const splitTotal = contributions.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const splitMismatch = contributions.length > 0 && Math.abs(splitTotal - amt) > 0.01;
  const valid = description.trim() && amt > 0;

  const handleSave = async () => {
    setSaving(true);
    const cardLabel = cardScoped ? `${card.displayId || card.id} ${card.name}` : null;
    await onSave({
      collection_id: cardScoped ? entry.collection_id : (collection?.id || null),
      card_id: cardScoped ? card.id : null,
      card_display_name: cardScoped
        ? `${description.trim() || 'Expense'} · ${cardLabel}`
        : (description.trim() || 'Expense'),
      entry_id: cardScoped ? entry.id : null,
      type: 'expense',
      amount: amt,
      contributions: contributions.filter(c => c.name.trim() && Number(c.amount) > 0).map(c => ({ name: c.name.trim(), amount: Number(c.amount) })),
      occurred_at: date || null,
      notes: notes.trim(),
    });
    setSaving(false);
  };

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="op-modal-header">
          {cardScoped && (
            <div className="op-modal-art-wrap">
              <CardArt card={card} />
            </div>
          )}
          <div>
            <div className="op-eyebrow">{cardScoped ? 'Card expense' : 'Logging expense'}</div>
            <div className="op-modal-title">
              {cardScoped ? `Expense for ${card.name}` : 'Pool expense'}
            </div>
            <div className="op-modal-sub">
              {cardScoped
                ? `${card.displayId || card.id} · grading, shipping, sleeves, etc.`
                : `${collection?.name || 'Unscoped'} · sleeves, grading fees, shipping, etc.`}
            </div>
          </div>
        </div>

        <div className="op-form">
          <div className="op-form-row">
            <Field label="Description">
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. PSA bulk grading submission" autoFocus />
            </Field>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Total (USD)">
            <input type="number" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>

          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">Who paid</div>
                <div className="op-form-section-sub">Split between members. Leave empty if one person fronted everything.</div>
              </div>
              <button className="op-btn-ghost" onClick={addRow}>
                <Plus size={14} /> Add split
              </button>
            </div>
            {contributions.map((c, i) => (
              <ContribRow
                key={i}
                value={c}
                members={members}
                onChange={(patch) => updateRow(i, patch)}
                onRemove={() => removeRow(i)}
              />
            ))}
            {contributions.length > 0 && (
              <div className={`op-contrib-check ${splitMismatch ? 'is-warn' : 'is-ok'}`}>
                Splits total: <strong>${splitTotal.toFixed(2)}</strong> of <strong>${amt.toFixed(2)}</strong>
                {splitMismatch && <span> · doesn't match expense total</span>}
              </div>
            )}
          </div>

          <Field label="Notes (optional)">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="op-form-actions">
            <button className="op-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="op-btn-primary" onClick={handleSave} disabled={saving || !valid}>
              {saving ? 'Saving…' : 'Record expense'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PayoutModal: pool-level cash distribution to one or more members. Stores
// recipient amounts as POSITIVE in contributions[] (intuitive UX: "Alice gets
// $50"), and the equity calc treats `type: 'payout'` like `sell` — negating
// the amounts so each recipient's net contribution drops accordingly.
function PayoutModal({ members = [], collection, onClose, onSave }) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [contributions, setContributions] = useState([{ name: members[0] || '', amount: '' }]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const addRow = () => setContributions([...contributions, { name: '', amount: '' }]);
  const updateRow = (i, patch) => setContributions(contributions.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const removeRow = (i) => setContributions(contributions.filter((_, idx) => idx !== i));

  const amt = Number(amount) || 0;
  const splitTotal = contributions.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const splitMismatch = contributions.length > 0 && Math.abs(splitTotal - amt) > 0.01;
  const anyRecipient = contributions.some(c => c.name.trim() && Number(c.amount) > 0);
  const valid = amt > 0 && anyRecipient && !splitMismatch;

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      collection_id: collection?.id || null,
      card_id: null,
      card_display_name: description.trim() || 'Payout',
      type: 'payout',
      amount: amt,
      contributions: contributions
        .filter(c => c.name.trim() && Number(c.amount) > 0)
        .map(c => ({ name: c.name.trim(), amount: Number(c.amount) })),
      occurred_at: date || null,
      notes: notes.trim(),
    });
    setSaving(false);
  };

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="op-modal-header">
          <div>
            <div className="op-eyebrow">Logging payout</div>
            <div className="op-modal-title">Pool payout</div>
            <div className="op-modal-sub">{collection?.name || 'Unscoped'} · cash distributed out of the pool to members</div>
          </div>
        </div>

        <div className="op-form">
          <div className="op-form-row">
            <Field label="Description (optional)">
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Q4 profit distribution" autoFocus />
            </Field>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Total (USD)">
            <input type="number" step="0.01" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>

          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">Who received</div>
                <div className="op-form-section-sub">Split the total among recipients. Each amount reduces that member's equity.</div>
              </div>
              <button className="op-btn-ghost" onClick={addRow}>
                <Plus size={14} /> Add recipient
              </button>
            </div>
            {contributions.map((c, i) => (
              <ContribRow
                key={i}
                value={c}
                members={members}
                onChange={(patch) => updateRow(i, patch)}
                onRemove={() => removeRow(i)}
              />
            ))}
            {contributions.length > 0 && (
              <div className={`op-contrib-check ${splitMismatch ? 'is-warn' : 'is-ok'}`}>
                Splits total: <strong>${splitTotal.toFixed(2)}</strong> of <strong>${amt.toFixed(2)}</strong>
                {splitMismatch && <span> · doesn't match payout total</span>}
              </div>
            )}
          </div>

          <Field label="Notes (optional)">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="op-form-actions">
            <button className="op-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="op-btn-primary" onClick={handleSave} disabled={saving || !valid}>
              {saving ? 'Saving…' : 'Record payout'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// BulkGradingModal: select N entries, give each a grading cost, and split the
// total among payers. Saves one expense tx per card, with payer shares scaled
// proportionally so per-card contribs sum to the per-card cost.
function BulkGradingModal({ entries, catalogIndex, members = [], collectionId, onClose, onSave }) {
  const [selected, setSelected] = useState({}); // entry_id -> cost (string)
  const [payers, setPayers] = useState([{ name: '', amount: '' }]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [defaultCost, setDefaultCost] = useState('15');
  const [saving, setSaving] = useState(false);

  // Only entries with a known card and within scope are gradable.
  const scoped = useMemo(() => {
    const list = (!collectionId || collectionId === 'all')
      ? entries
      : entries.filter(e => e.collection_id === collectionId);
    return list.filter(e => catalogIndex.get(e.card_id));
  }, [entries, catalogIndex, collectionId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter(e => {
      const c = catalogIndex.get(e.card_id);
      const hay = [c?.name, c?.fullName, c?.id, c?.displayId, c?.setName].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [scoped, catalogIndex, search]);

  const toggle = (entryId) => setSelected(prev => {
    const next = { ...prev };
    if (entryId in next) delete next[entryId];
    else next[entryId] = defaultCost;
    return next;
  });
  const setCost = (entryId, cost) => setSelected(prev => ({ ...prev, [entryId]: cost }));

  const addPayer = () => setPayers([...payers, { name: '', amount: '' }]);
  const updatePayer = (i, patch) => setPayers(payers.map((p, idx) => idx === i ? { ...p, ...patch } : p));
  const removePayer = (i) => setPayers(payers.filter((_, idx) => idx !== i));

  const totalCost = Object.values(selected).reduce((s, v) => s + (Number(v) || 0), 0);
  const totalPaid = payers.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const mismatch = Math.abs(totalCost - totalPaid) > 0.01;
  const numCards = Object.keys(selected).length;
  const validPayers = payers.filter(p => p.name.trim() && Number(p.amount) > 0);
  const valid = numCards > 0 && totalCost > 0 && !mismatch && validPayers.length > 0;

  const splitEvenly = () => {
    const names = payers.filter(p => p.name.trim()).map(p => p.name.trim());
    if (names.length === 0) return;
    const share = totalCost / names.length;
    setPayers(names.map(n => ({ name: n, amount: share.toFixed(2) })));
  };

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    for (const [entryId, costStr] of Object.entries(selected)) {
      const entry = scoped.find(e => e.id === entryId);
      const card = catalogIndex.get(entry?.card_id);
      if (!entry || !card) continue;
      const cardCost = Number(costStr) || 0;
      if (cardCost === 0) continue;
      // Scale each payer's share to this card by the cost ratio.
      const cardContribs = validPayers.map(p => ({
        name: p.name.trim(),
        amount: cardCost * ((Number(p.amount) || 0) / totalPaid),
      }));
      await onSave({
        type: 'expense',
        card_id: card.canonicalId || card.id,
        entry_id: entry.id,
        collection_id: entry.collection_id,
        card_display_name: `Grading · ${card.displayId || card.id} ${card.name}`,
        amount: cardCost,
        contributions: cardContribs,
        occurred_at: date || null,
        notes: notes.trim(),
      });
    }
    setSaving(false);
    onClose();
  };

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal op-modal-wide" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="op-modal-header">
          <div>
            <div className="op-eyebrow">Bulk submission</div>
            <div className="op-modal-title">Bulk grading</div>
            <div className="op-modal-sub">
              Pick the cards going to grading, set each card's fee, and split the bill across payers.
              One expense tx per card, scaled proportionally.
            </div>
          </div>
        </div>

        <div className="op-form">
          <div className="op-form-row">
            <Field label="Default cost per card">
              <input
                type="number" step="0.01" placeholder="15.00"
                value={defaultCost}
                onChange={(e) => setDefaultCost(e.target.value)}
              />
            </Field>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>

          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">Cards in this submission ({numCards})</div>
                <div className="op-form-section-sub">Click a card to add it. Edit per-card cost in the table.</div>
              </div>
            </div>

            <div className="op-search-bar op-search-bar-inline">
              <Search size={16} className="op-search-icon" />
              <input
                className="op-search-input"
                placeholder="Filter cards by name, ID, set…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button className="op-search-clear" onClick={() => setSearch('')}>
                  <X size={15} />
                </button>
              )}
            </div>

            {scoped.length === 0 ? (
              <div className="op-empty-mini">No entries in the current scope to grade.</div>
            ) : (
              <div className="op-bulk-list">
                {filtered.map(entry => {
                  const card = catalogIndex.get(entry.card_id);
                  const isSelected = entry.id in selected;
                  const cost = selected[entry.id] ?? '';
                  return (
                    <div key={entry.id} className={`op-bulk-row ${isSelected ? 'is-selected' : ''}`}>
                      <label className="op-bulk-row-main">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(entry.id)}
                        />
                        <div className="op-bulk-row-info">
                          <div className="op-bulk-row-name">
                            {card.name}
                            <VariantPill variant={card.variant} />
                          </div>
                          <div className="op-bulk-row-meta">
                            {card.displayId || card.id} · {entry.condition || 'raw'}
                            {entry.grading_company && ` · already ${entry.grading_company} ${entry.grade}`}
                          </div>
                        </div>
                      </label>
                      {isSelected && (
                        <div className="op-bulk-row-cost">
                          <DollarSign size={13} />
                          <input
                            type="number" step="0.01" placeholder="0.00"
                            value={cost}
                            onChange={(e) => setCost(entry.id, e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
                {filtered.length === 0 && (
                  <div className="op-empty-mini">No cards match your filter.</div>
                )}
              </div>
            )}

            <div className="op-bulk-total">
              Submission total: <strong>${totalCost.toFixed(2)}</strong>
              {numCards > 0 && <> · {numCards} {numCards === 1 ? 'card' : 'cards'}</>}
            </div>
          </div>

          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">Who's paying</div>
                <div className="op-form-section-sub">Splits get scaled per card so each card's contribs match its cost.</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="op-btn-ghost" onClick={splitEvenly} disabled={totalCost === 0}>Split evenly</button>
                <button className="op-btn-ghost" onClick={addPayer}><Plus size={14} /> Add payer</button>
              </div>
            </div>
            {payers.map((p, i) => (
              <ContribRow
                key={i}
                value={p}
                members={members}
                onChange={(patch) => updatePayer(i, patch)}
                onRemove={() => removePayer(i)}
              />
            ))}
            <div className={`op-contrib-check ${mismatch ? 'is-warn' : 'is-ok'}`}>
              Payer total: <strong>${totalPaid.toFixed(2)}</strong> of <strong>${totalCost.toFixed(2)}</strong>
              {mismatch && totalCost > 0 && <span> · doesn't match submission total</span>}
            </div>
          </div>

          <Field label="Notes (optional)">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Submission #, service level, etc." />
          </Field>

          <div className="op-form-actions">
            <button className="op-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="op-btn-primary" onClick={handleSave} disabled={saving || !valid}>
              {saving ? 'Saving…' : `Log ${numCards || ''} ${numCards === 1 ? 'expense' : 'expenses'}`.trim()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
function TransactionsView({ transactions, collections, entries = [], catalogIndex = new Map(), variantRev = 0, activeCollectionId, onLogTransaction = () => {}, onRemoveTransaction = () => {} }) {
  const [typeFilter, setTypeFilter] = useState('all'); // 'all' | 'buy' | 'sell' | 'transfer' | 'expense'
  // Default the transactions view to the active collection — most users want
  // their current pool, not a global feed. The dropdown still has "All
  // collections" if you want to override. Re-mounting the view (navigating
  // away and back) resets to the active collection again.
  const [collectionFilter, setCollectionFilter] = useState(() => activeCollectionId || 'all');
  // Follow active-collection changes from the header picker.
  useEffect(() => {
    if (activeCollectionId) setCollectionFilter(activeCollectionId);
  }, [activeCollectionId]);
  const [modal, setModal] = useState(null); // 'transfer' | 'expense' | 'payout' | 'bulkgrade' | null

  const collectionsById = useMemo(() => {
    const m = new Map();
    for (const c of collections) m.set(c.id, c);
    return m;
  }, [collections]);

  const activeCollection = collectionsById.get(activeCollectionId) || collections[0];
  const equityEntries = useMemo(
    () => (!collectionFilter || collectionFilter === 'all')
      ? entries
      : entries.filter(e => e.collection_id === collectionFilter),
    [entries, collectionFilter]
  );

  // Effective NAV across the entries the equity panel uses.
  const equityNav = useMemo(() => {
    let nav = 0;
    for (const e of equityEntries) {
      if (e.grading_company) {
        // Graded entry: only count if the user has entered a graded_price.
        // Raw fallback would distort NAV (a PSA 10 isn't worth raw price).
        nav += Number(e.graded_price) || 0;
      } else {
        const c = catalogIndex.get(e.card_id);
        if (c) nav += effectiveRawPrice(c);
      }
    }
    return nav;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equityEntries, catalogIndex, variantRev]);

  const filtered = useMemo(() => {
    return transactions
      .filter(t => typeFilter === 'all' || t.type === typeFilter)
      .filter(t => collectionFilter === 'all' || t.collection_id === collectionFilter)
      .sort((a, b) => {
        const da = a.occurred_at || a.created_at || '';
        const db = b.occurred_at || b.created_at || '';
        return db.localeCompare(da); // newest first
      });
  }, [transactions, typeFilter, collectionFilter]);

  const totals = useMemo(() => {
    let bought = 0, sold = 0, expenses = 0, payouts = 0;
    for (const t of filtered) {
      if (t.type === 'buy') bought += Number(t.amount) || 0;
      if (t.type === 'sell') sold += Number(t.amount) || 0;
      if (t.type === 'expense') expenses += Number(t.amount) || 0;
      if (t.type === 'payout') payouts += Number(t.amount) || 0;
    }
    return { bought, sold, expenses, payouts, net: sold - bought - expenses - payouts };
  }, [filtered]);

  // For 'All collections' filter we synthesize a collection so the equity
  // panel still has somewhere to live; it gets a special id ('all') that the
  // EquityPanel reads as "don't filter transactions".
  const aggregateMembers = useMemo(() => {
    const s = new Set();
    for (const c of collections) for (const m of (c.members || [])) s.add(m);
    return [...s];
  }, [collections]);
  const equityCollection = collectionFilter === 'all'
    ? { id: 'all', name: 'All Collections', members: aggregateMembers, synthetic: true }
    : (collectionsById.get(collectionFilter) || activeCollection);
  const equityMembers = Array.isArray(equityCollection?.members) ? equityCollection.members : [];

  return (
    <div className="op-view">
      <div className="op-page-head">
        <div>
          <div className="op-eyebrow">Activity</div>
          <h1 className="op-page-title">Transactions</h1>
          <div className="op-page-sub">{filtered.length.toLocaleString()} {filtered.length === 1 ? 'transaction' : 'transactions'}</div>
        </div>
      </div>

      <div className="op-stats">
        <Stat label="Bought" value={`$${totals.bought.toFixed(2)}`} />
        <Stat label="Sold" value={`$${totals.sold.toFixed(2)}`} accent />
        <Stat label="Expenses" value={`$${totals.expenses.toFixed(2)}`} />
        <Stat label="Payouts" value={`$${totals.payouts.toFixed(2)}`} />
        <Stat
          label="Net cash flow"
          value={`${totals.net >= 0 ? '+' : ''}$${totals.net.toFixed(2)}`}
          tone={totals.net >= 0 ? 'pos' : 'neg'}
        />
      </div>

      {equityCollection && (
        <EquityPanel
          entries={equityEntries}
          transactions={transactions}
          collectionId={equityCollection.id}
          catalogIndex={catalogIndex}
          totalMarket={equityNav}
        />
      )}

      <div className="op-filters">
        <FilterGroup label="Type" value={typeFilter} onChange={setTypeFilter} options={[
          { v: 'all', l: 'All' },
          { v: 'buy', l: 'Buys' },
          { v: 'sell', l: 'Sells' },
          { v: 'transfer', l: 'Transfers' },
          { v: 'expense', l: 'Expenses' },
          { v: 'payout', l: 'Payouts' },
        ]} />
        <FilterGroup label="Collection" value={collectionFilter} onChange={setCollectionFilter} mode="select" options={[
          { v: 'all', l: 'All collections' },
          ...collections.map(c => ({ v: c.id, l: c.name })),
        ]} />

        <div className="op-filter-group">
          <div className="op-filter-label">Log</div>
          <div className="op-filter-pills">
            <button className="op-filter-pill" onClick={() => setModal('transfer')}>+ Transfer</button>
            <button className="op-filter-pill" onClick={() => setModal('expense')}>+ Expense</button>
            <button className="op-filter-pill" onClick={() => setModal('payout')}>+ Payout</button>
            <button className="op-filter-pill" onClick={() => setModal('bulkgrade')}>+ Bulk grade</button>
          </div>
        </div>
      </div>

      {modal === 'transfer' && (
        <TransferModal
          members={equityMembers}
          collection={equityCollection}
          onClose={() => setModal(null)}
          onSave={async (payload) => {
            // Synthetic 'all' isn't a real collection — store null so Supabase
            // doesn't reject the row on its uuid column.
            const normalized = { ...payload, collection_id: payload.collection_id === 'all' ? null : payload.collection_id };
            await onLogTransaction(normalized);
            setModal(null);
          }}
        />
      )}
      {modal === 'expense' && (
        <ExpenseModal
          members={equityMembers}
          collection={equityCollection}
          onClose={() => setModal(null)}
          onSave={async (payload) => {
            const normalized = { ...payload, collection_id: payload.collection_id === 'all' ? null : payload.collection_id };
            await onLogTransaction(normalized);
            setModal(null);
          }}
        />
      )}
      {modal === 'payout' && (
        <PayoutModal
          members={equityMembers}
          collection={equityCollection}
          onClose={() => setModal(null)}
          onSave={async (payload) => {
            const normalized = { ...payload, collection_id: payload.collection_id === 'all' ? null : payload.collection_id };
            await onLogTransaction(normalized);
            setModal(null);
          }}
        />
      )}
      {modal === 'bulkgrade' && (
        <BulkGradingModal
          entries={entries}
          catalogIndex={catalogIndex}
          members={equityMembers}
          collectionId={collectionFilter}
          onClose={() => setModal(null)}
          onSave={async (payload) => {
            const normalized = { ...payload, collection_id: payload.collection_id === 'all' ? null : payload.collection_id };
            await onLogTransaction(normalized);
          }}
        />
      )}

      {filtered.length === 0 ? (
        <div className="op-empty">
          <BarChart3 size={36} strokeWidth={1.2} />
          <div className="op-empty-title">No transactions match these filters</div>
          <div className="op-empty-sub">Add or sell a card from the Collection tab to record one.</div>
        </div>
      ) : (
        <div className="op-tx-list">
          {filtered.map(t => (
            <TransactionRow
              key={t.id}
              tx={t}
              collection={collectionsById.get(t.collection_id)}
              onDelete={() => {
                const label = t.type === 'transfer' ? 'transfer'
                  : t.type === 'expense' ? 'expense'
                  : t.type === 'payout' ? 'payout'
                  : t.type === 'buy' ? 'buy log (the card stays in your collection)'
                  : t.type === 'sell' ? 'sell log' : 'transaction';
                if (confirm(`Delete this ${label}? Equity recalculates immediately.`)) {
                  onRemoveTransaction(t.id);
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TransactionRow({ tx, collection, onDelete }) {
  const amount = Number(tx.amount) || 0;
  // Visual style + sign per type
  const meta = {
    buy:      { label: 'BUY',      cls: 'is-buy',      tone: 'is-neg', sign: '−' },
    sell:     { label: 'SELL',     cls: 'is-sell',     tone: 'is-pos', sign: '+' },
    transfer: { label: 'TRANSFER', cls: 'is-transfer', tone: '',       sign: '' },
    expense:  { label: 'EXPENSE',  cls: 'is-expense',  tone: 'is-neg', sign: '−' },
    payout:   { label: 'PAYOUT',   cls: 'is-expense',  tone: 'is-neg', sign: '−' },
  }[tx.type] || { label: (tx.type || '').toUpperCase(), cls: '', tone: '', sign: '' };

  return (
    <div className={`op-tx-row ${meta.cls}`}>
      <div className="op-tx-type">{meta.label}</div>
      <div className="op-tx-main">
        <div className="op-tx-card">{tx.card_display_name || tx.card_id || '(no description)'}</div>
        <div className="op-tx-meta">
          {collection?.name || '—'}
          {tx.occurred_at && <> · {tx.occurred_at}</>}
          {tx.contributions && tx.contributions.length > 0 && (
            <> · {tx.contributions.map(c => `${c.name} ${Number(c.amount) >= 0 ? '+' : '−'}$${Math.abs(Number(c.amount)).toFixed(2)}`).join(', ')}</>
          )}
        </div>
        {tx.notes && <div className="op-tx-notes">{tx.notes}</div>}
      </div>
      <div className={`op-tx-amount ${meta.tone}`}>
        {meta.sign}${amount.toFixed(2)}
      </div>
      {onDelete && (
        <button className="op-tx-delete" onClick={onDelete} title="Delete this transaction">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

// ============================================================================
// VariantsModal: edit the printing-attribute registry from the UI. Builtins
// (parallel, manga) show locked; user-added variants can be removed. Adding
// a variant immediately re-derives matching/diagnostics; the cached catalog
// re-detects attributes on the next page load (the cache key includes a
// fingerprint of the ruleset).
function VariantsModal({ onClose }) {
  const [defs, setDefs] = useState(() => getPrintingAttributes());
  const [label, setLabel] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [mode, setMode] = useState('text');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const refresh = () => setDefs(getPrintingAttributes());

  const handleAdd = () => {
    setError('');
    const result = addUserVariant({
      key: (keyInput || label).trim(),
      label: label.trim(),
      mode,
      value: value.trim(),
    });
    if (!result.ok) { setError(result.error); return; }
    setLabel(''); setKeyInput(''); setValue('');
    refresh();
  };

  const handleRemove = (key) => {
    if (!confirm(`Remove the "${key}" variant?`)) return;
    removeUserVariant(key);
    refresh();
  };

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="op-modal-header">
          <div>
            <div className="op-eyebrow">Printing variants</div>
            <div className="op-modal-title">Manage variants</div>
            <div className="op-modal-sub">
              Each variant is detected from card names. Refresh the page after
              changes to re-derive the catalog with the new rules.
            </div>
          </div>
        </div>

        <div className="op-form">
          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">Current variants</div>
                <div className="op-form-section-sub">{defs.length.toLocaleString()} active</div>
              </div>
            </div>
            <div className="op-tx-list">
              {defs.map(d => (
                <div key={d.key} className="op-tx-row">
                  <div className="op-tx-type">{d.label.toUpperCase()}</div>
                  <div className="op-tx-main">
                    <div className="op-tx-card">
                      <code style={{ fontSize: 12 }}>{d.mode === 'regex' ? '/' : '"'}{d.value}{d.mode === 'regex' ? '/i' : '"'}</code>
                    </div>
                    <div className="op-tx-meta">
                      key: <code>{d.key}</code> · mode: {d.mode}
                      {d.builtin ? ' · built-in' : ''}
                    </div>
                  </div>
                  {!d.builtin && (
                    <button className="op-tx-delete" onClick={() => handleRemove(d.key)} title="Remove this variant">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">Add variant</div>
                <div className="op-form-section-sub">
                  Detection runs on TCGPlayer product names and OPTCGAPI card names.
                </div>
              </div>
            </div>
            <div className="op-form-row">
              <Field label="Label">
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Event Stamp"
                />
              </Field>
              <Field label="Key (auto from label)">
                <input
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'event-stamp'}
                />
              </Field>
            </div>
            <div className="op-form-row">
              <Field label="Pattern mode">
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="text">Plain text (literal match)</option>
                  <option value="regex">Regex</option>
                </select>
              </Field>
              <Field label="Pattern">
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={mode === 'text' ? 'e.g. Event Stamp' : 'e.g. \\(Event Stamp\\)|\\(Stamped\\)'}
                />
              </Field>
            </div>
            {error && <div className="op-graded-error">{error}</div>}
            <div className="op-form-actions">
              <button className="op-btn-ghost" onClick={onClose}>Close</button>
              <button
                className="op-btn-primary"
                onClick={handleAdd}
                disabled={!label.trim() || !value.trim()}
              >
                Add variant
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
function ResolveView({ catalog, entries, onAddCard, onCardClick }) {
  const [filterMode, setFilterMode] = useState('unresolved'); // 'unresolved' | 'in-collection' | 'issues' | 'reported' | 'all'
  const [search, setSearch] = useState('');
  const [showVariants, setShowVariants] = useState(false);
  // In these queues, resolving a card makes it no longer qualify, so it
  // drops out and the next card slides into the current index. We must NOT
  // advance the index after a save in these modes, or we'd skip a card.
  // ('all' / 'in-collection' keep resolved cards, so we do advance there.)
  const [index, setIndex] = useState(0);

  // Bulk prefetch state
  const [prefetching, setPrefetching] = useState(false);
  const [prefetchDone, setPrefetchDone] = useState(0);
  const [prefetchTotal, setPrefetchTotal] = useState(0);
  const [prefetchFailed, setPrefetchFailed] = useState(0);
  const abortRef = useRef(false);
  // Bump on a resolution save so the "unresolved" queue + currentCard state
  // re-derive after the user picks something.
  const [resolveRev, setResolveRev] = useState(0);

  // The counts/queue memos read the in-memory resolution Map, but in shared
  // mode that Map is hydrated from Supabase asynchronously AFTER first paint.
  // Hydration doesn't bump resolveRev, so without this the page would show the
  // (overflowed, partial) localStorage warm-start counts and never refresh to
  // the real Supabase-backed totals — looking like a "reset" on every load.
  // Bump once the load lands so everything re-derives from the full Map.
  useEffect(() => {
    let cancelled = false;
    whenResolutionsReady().then(() => { if (!cancelled) setResolveRev(r => r + 1); });
    return () => { cancelled = true; };
  }, []);

  // Re-derive counts/queue when a report is written or cleared from anywhere
  // (e.g., the detail drawer overlaid on this view). Without this the Reported
  // queue stays stale until the user touches a local control.
  useEffect(() => onMatchReportChanged(() => setResolveRev(r => r + 1)), []);

  // Same idea for printing-attribute edits — adding/removing a variant
  // changes diagnose results, so the Issues queue and per-card display
  // should refresh immediately even though the cached card.attributes
  // won't fully re-derive until the next page reload.
  useEffect(() => onPrintingAttributesChanged(() => setResolveRev(r => r + 1)), []);

  const cidOf = (c) => c.canonicalId || c.id;
  const isResolved = (c) => Boolean(getResolution(cidOf(c)));
  const hasIssues = (c) => {
    const r = getResolution(cidOf(c));
    if (!r) return false;
    // A human-confirmed pick is never an "issue" — the set/parallel check is
    // just a heuristic, and saving in the resolver is the user overruling it.
    if (r.confirmed) return false;
    const diag = diagnoseResolution(c, r);
    return diag.issues.length > 0;
  };
  const isReported = (c) => Boolean(getMatchReport(cidOf(c)));

  // Roll-up counts surfaced in the troubleshooting header.
  const counts = useMemo(() => {
    let resolved = 0, unresolved = 0, issues = 0, reported = 0;
    for (const c of catalog) {
      if (isReported(c)) reported++;
      if (isResolved(c)) {
        resolved++;
        if (hasIssues(c)) issues++;
      } else {
        unresolved++;
      }
    }
    return { resolved, unresolved, issues, reported, total: catalog.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, resolveRev]);

  const queue = useMemo(() => {
    let base;
    if (filterMode === 'in-collection') {
      // entries.card_id is canonical post-migration; match against canonicalId.
      const ids = new Set(entries.map(e => e.card_id));
      base = catalog.filter(c => ids.has(cidOf(c)));
    } else if (filterMode === 'unresolved') {
      base = catalog.filter(c => !isResolved(c));
    } else if (filterMode === 'issues') {
      base = catalog.filter(c => hasIssues(c));
    } else if (filterMode === 'reported') {
      base = catalog.filter(c => isReported(c));
    } else {
      base = catalog;
    }
    const q = search.trim().toLowerCase();
    if (!q) return base;
    // Searches OPTCG identity (name, display id, set name) AND the saved
    // TCGPlayer pick name — so you can find a card by either side.
    return base.filter(c => {
      if ((c.name || '').toLowerCase().includes(q)) return true;
      if ((c.displayId || '').toLowerCase().includes(q)) return true;
      if ((c.id || '').toLowerCase().includes(q)) return true;
      if ((c.setName || '').toLowerCase().includes(q)) return true;
      const r = getResolution(cidOf(c));
      if (r && (r.name || '').toLowerCase().includes(q)) return true;
      return false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, entries, filterMode, resolveRev, search]);

  const runPrefetch = async () => {
    if (prefetching) return;
    const targets = catalog.filter(c => !isResolved(c));
    if (targets.length === 0) { alert('Everything is already resolved.'); return; }
    if (!confirm(`Auto-resolve ${targets.length.toLocaleString()} unresolved card${targets.length === 1 ? '' : 's'} via TCGCSV? Picks the TCGPlayer printing whose set matches the card's source set AND whose printing variants (parallel, manga, custom) line up. You can override any choice manually afterwards.`)) return;
    abortRef.current = false;
    setPrefetching(true);
    setPrefetchTotal(targets.length);
    setPrefetchDone(0);
    setPrefetchFailed(0);

    // Concurrency-2 — TCGCSV's maintainer asks for polite traffic; cards
    // share a group's price endpoint so duplicates of the same group
    // benefit from the proxy's per-group cache.
    const concurrency = 2;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        if (abortRef.current) return;
        const card = targets[idx++];
        try {
          const number = cardNumberFromCanonical(cidOf(card)) || card.displayId;
          const products = await searchTcgProducts(number);
          // Score-based: prefers products whose group_abbreviation matches
          // the card's source set AND whose parallel flag matches. Falls
          // through to non-parallel/has-a-price tiebreakers.
          const pick = pickBestMatchForCard(card, products);
          if (pick) saveResolution(cidOf(card), pick);
          else setPrefetchFailed(f => f + 1);
        } catch {
          setPrefetchFailed(f => f + 1);
        }
        setPrefetchDone(d => d + 1);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    setPrefetching(false);
    setResolveRev(r => r + 1);
  };
  const cancelPrefetch = () => { abortRef.current = true; };

  const currentCard = queue[index];
  const currentCid = currentCard ? cidOf(currentCard) : '';

  const [candidates, setCandidates] = useState([]);
  const [selectedPickId, setSelectedPickId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setIndex(0);
  }, [filterMode, search]);

  useEffect(() => {
    setCandidates([]);
    setSelectedPickId('');
    setError('');
    if (!currentCard) return;
    const number = cardNumberFromCanonical(currentCid) || currentCard.displayId;
    if (!number) { setError(`Couldn't extract a card number from ${currentCid || currentCard.id}.`); return; }
    let cancelled = false;
    setLoading(true);
    searchTcgProducts(number).then(matches => {
      if (cancelled) return;
      setCandidates(matches);
      if (matches.length === 0) {
        setError(`No TCGPlayer match for ${number}.`);
        return;
      }
      const saved = getResolution(currentCid);
      // Auto-resolve when the match is UNAMBIGUOUS — exactly one candidate
      // matches this card's set + parallel flag (TCGCSV returns every
      // printing of a number, so "one product" is rare; "one printing that's
      // actually this card" is the useful test). Skip auto if we've already
      // resolved to a different product (respect the manual pick).
      const confident = confidentMatchForCard(currentCard, matches);
      // Only auto-save when the user is clearly working a resolve queue. In
      // "All cards" or "In my collection" they're browsing/searching, and a
      // silent auto-resolve there is surprising — load candidates and wait
      // for an explicit Save. "Reported" is also hands-off: the user flagged
      // those for personal review.
      const autoResolveAllowed = filterMode === 'unresolved' || filterMode === 'issues';
      if (autoResolveAllowed && confident && (!saved || saved.tcg_id === confident.tcg_id)) {
        saveResolution(currentCid, confident);
        if (currentReport) clearMatchReport(currentCid);
        setResolveRev(r => r + 1);
        // In removal queues the card drops out and the next one shifts into
        // this index — don't advance.
        return;
      }
      const chosen = (saved && matches.find(v => v.tcg_id === saved.tcg_id))
        || pickBestMatchForCard(currentCard, matches)
        || matches[0];
      setSelectedPickId(String(chosen.tcg_id));
    }).catch(e => {
      if (!cancelled) setError(e.message || 'Failed to load TCGCSV matches.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCard, currentCid]);

  const selected = candidates.find(v => String(v.tcg_id) === selectedPickId);
  const currentResolution = currentCid ? getResolution(currentCid) : null;
  const currentDiagnostic = currentCard ? diagnoseResolution(currentCard, currentResolution) : null;
  const currentReport = currentCid ? getMatchReport(currentCid) : null;
  const [reportNote, setReportNote] = useState('');
  // Reset note input when the user moves to a different card.
  useEffect(() => { setReportNote(''); }, [currentCid]);

  // Queues where a resolved card disappears from the list.
  const isRemovalQueue = filterMode === 'unresolved' || filterMode === 'issues' || filterMode === 'reported';

  const handleSave = () => {
    if (selected && currentCard) {
      // Manual save = the user confirming this printing. Marks it confirmed so
      // it leaves the Issues queue even if the heuristic still flags a mismatch.
      saveResolution(currentCid, selected, { confirmed: true });
      // Saving a new pick implicitly resolves the report — clear it.
      if (currentReport) clearMatchReport(currentCid);
      setResolveRev(r => r + 1);
      // In removal queues the saved card usually drops out and the next one
      // slides into this index, so we hold the index. But a save doesn't
      // always remove the card: in the Issues queue the only available
      // printing may still mismatch the set/parallel flag or have no price,
      // so the card keeps qualifying. Re-check the queue predicate against
      // the just-saved state (Map + report store are updated synchronously);
      // if the card is still in this queue, advance so the user isn't stuck.
      const stillQualifies =
        filterMode === 'unresolved' ? !isResolved(currentCard)
        : filterMode === 'issues' ? hasIssues(currentCard)
        : filterMode === 'reported' ? isReported(currentCard)
        : false;
      if (!isRemovalQueue || stillQualifies) setIndex(i => i + 1);
    } else {
      setIndex(i => i + 1);
    }
  };
  const handleSkip = () => setIndex(i => i + 1);
  const handleBack = () => setIndex(i => Math.max(0, i - 1));
  const handleReport = () => {
    if (!currentCard) return;
    reportBadMatch(currentCid, reportNote);
    setReportNote('');
    setResolveRev(r => r + 1);
  };
  const handleClearReport = () => {
    if (!currentCard) return;
    clearMatchReport(currentCid);
    setResolveRev(r => r + 1);
  };

  return (
    <div className="op-view">
      <div className="op-page-head">
        <div>
          <div className="op-eyebrow">Catalog cleanup</div>
          <h1 className="op-page-title">Resolve cards</h1>
          <div className="op-page-sub">Pick the correct TCGPlayer printing for each card. Saves wire up the raw market price (TCGCSV) and TCGPlayer art.</div>
          {getHydratedResolutionCount() >= 0 && (
            <div className="op-page-sub" style={{ marginTop: 4 }}>
              ☁ {getHydratedResolutionCount().toLocaleString()} resolutions loaded from cloud
            </div>
          )}
        </div>
      </div>

      <div className="op-stats">
        <Stat label="Resolved" value={counts.resolved.toLocaleString()} accent />
        <Stat label="Unresolved" value={counts.unresolved.toLocaleString()} />
        <Stat label="Issues" value={counts.issues.toLocaleString()} sub="set or parallel mismatch" tone={counts.issues > 0 ? 'neg' : null} />
        <Stat label="Reported" value={counts.reported.toLocaleString()} sub="flagged by you for review" tone={counts.reported > 0 ? 'neg' : null} />
      </div>

      <div className="op-filters">
        <FilterGroup label="Queue" value={filterMode} onChange={setFilterMode} mode="select" options={[
          { v: 'unresolved', l: `Unresolved (${counts.unresolved.toLocaleString()})` },
          { v: 'in-collection', l: 'Cards in my collections' },
          { v: 'issues', l: `Issues — set/parallel mismatch (${counts.issues.toLocaleString()})` },
          { v: 'reported', l: `Reported by me (${counts.reported.toLocaleString()})` },
          { v: 'all', l: `All cards (${counts.total.toLocaleString()})` },
        ]} />

        <div className="op-filter-group" style={{ flex: 1, minWidth: 200 }}>
          <div className="op-filter-label">Search</div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, card number, set, or TCGPlayer pick…"
            style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--line-strong)', background: 'var(--paper)' }}
          />
        </div>

        <div className="op-filter-group">
          <div className="op-filter-label">Bulk</div>
          {!prefetching ? (
            <button className="op-btn-ghost" onClick={runPrefetch} title="Auto-resolve every unresolved card via TCGCSV (set + parallel aware)">
              <RefreshCw size={14} /> Auto-resolve all
            </button>
          ) : (
            <button className="op-btn-ghost" onClick={cancelPrefetch}>
              <X size={14} /> Cancel
            </button>
          )}
        </div>

        <div className="op-filter-group">
          <div className="op-filter-label">Variants</div>
          <button className="op-btn-ghost" onClick={() => setShowVariants(true)} title="Add or edit printing variants (parallel, manga, custom...)">
            Manage variants
          </button>
        </div>
      </div>

      {showVariants && <VariantsModal onClose={() => setShowVariants(false)} />}

      {prefetching && (
        <div className="op-prefetch">
          <div className="op-prefetch-bar">
            <div
              className="op-prefetch-bar-fill"
              style={{ width: `${prefetchTotal > 0 ? Math.min(100, (prefetchDone / prefetchTotal) * 100) : 0}%` }}
            />
          </div>
          <div className="op-prefetch-meta">
            Resolving <strong>{prefetchDone.toLocaleString()}</strong> / {prefetchTotal.toLocaleString()}
            {prefetchFailed > 0 && <> · {prefetchFailed.toLocaleString()} no-match</>}
          </div>
        </div>
      )}
      {!prefetching && prefetchTotal > 0 && prefetchDone > 0 && prefetchDone >= prefetchTotal && (
        <div className="op-prefetch-done">
          Auto-resolve complete · {(prefetchTotal - prefetchFailed).toLocaleString()} resolved, {prefetchFailed.toLocaleString()} unmatched.
        </div>
      )}

      {queue.length === 0 ? (
        <div className="op-empty">
          <Package size={36} strokeWidth={1.2} />
          <div className="op-empty-title">Nothing to resolve here</div>
          <div className="op-empty-sub">
            {filterMode === 'unresolved' ? 'Every card has a TCGPlayer printing picked.' :
             filterMode === 'in-collection' ? 'No cards in your collections yet.' :
             'Catalog is empty.'}
          </div>
        </div>
      ) : index >= queue.length ? (
        <div className="op-empty">
          <Package size={36} strokeWidth={1.2} />
          <div className="op-empty-title">Queue cleared</div>
          <div className="op-empty-sub">You've gone through all {queue.length.toLocaleString()} cards in this queue.</div>
          <button className="op-btn-primary" onClick={() => setIndex(0)}>Start over</button>
        </div>
      ) : currentCard && (
        <div className="op-resolve">
          <div className="op-resolve-progress">
            Card <strong>{(index + 1).toLocaleString()}</strong> of <strong>{queue.length.toLocaleString()}</strong>
          </div>

          <div className="op-resolve-card">
            <div className="op-resolve-side">
              <div className="op-eyebrow">OPTCG catalog</div>
              <div className="op-resolve-art" onClick={() => onCardClick(currentCard)} role="button">
                <CardArt card={currentCard} needsVariant />
              </div>
              <div className="op-resolve-side-meta">
                <div className="op-resolve-side-id">{currentCard.displayId || currentCard.id}</div>
                <div className="op-resolve-side-name">
                  {currentCard.name}
                  <VariantPill variant={currentCard.variant} />
                </div>
                <div className="op-resolve-side-sub">
                  {currentCard.setName}{currentCard.originalSetId && currentCard.originalSetId !== currentCard.setId ? ` (orig ${currentCard.originalSetId})` : ''}
                </div>
                <div className="op-resolve-side-sub">
                  {RARITY_LABELS[currentCard.rarity] || currentCard.rarity}
                  {attrsOf(currentCard).map(k => ` · ${attrLabel(k)}`).join('')}
                </div>
                <div className="op-resolve-side-sub">
                  Raw: ${effectiveRawPrice(currentCard).toFixed(2)}
                </div>
              </div>
            </div>

            <div className="op-resolve-side">
              <div className="op-eyebrow">TCGPlayer pick</div>
              <div className="op-resolve-art">
                {selected?.image_url
                  ? <img src={selected.image_url} alt={selected.name} className="op-card-art-img" />
                  : <div className="op-card-art-fallback"><ImageOff size={28} opacity={0.4} /></div>}
              </div>
              <div className="op-resolve-side-meta">
                {selected ? (
                  <>
                    <div className="op-resolve-side-name">
                      {selected.name}
                      {attrsOf(selected).map(k => (
                        <span key={k} className="op-variant-pill">{attrLabel(k)}</span>
                      ))}
                    </div>
                    <div className="op-resolve-side-sub">
                      {selected.group_abbreviation || '?'}{selected.group_name ? ` · ${selected.group_name}` : ''}
                    </div>
                    <div className="op-resolve-side-sub">
                      {selected.rarity || '?'} · {selected.sub_type_name || '?'}
                    </div>
                    <div className="op-resolve-side-sub">
                      Market: {selected.market_price != null ? `$${Number(selected.market_price).toFixed(2)}` : '—'}
                      {selected.low_price != null && (
                        <> · L/M/H ${Number(selected.low_price).toFixed(2)}/${Number(selected.mid_price).toFixed(2)}/${Number(selected.high_price).toFixed(2)}</>
                      )}
                    </div>
                    {selected.tcgplayer_url && (
                      <a className="op-resolve-side-link" href={selected.tcgplayer_url} target="_blank" rel="noreferrer">
                        Open on TCGPlayer ↗
                      </a>
                    )}
                  </>
                ) : (
                  <div className="op-resolve-side-sub">Pick a candidate below.</div>
                )}
              </div>
            </div>
          </div>

          <Field label={`TCGPlayer printing (${candidates.length} candidate${candidates.length === 1 ? '' : 's'})`}>
            {loading ? (
              <div className="op-resolve-side-sub">Loading matches…</div>
            ) : candidates.length === 0 ? (
              <div className="op-resolve-side-sub">No TCGCSV matches — check the card number or use the manual search elsewhere.</div>
            ) : (
              <div className="op-resolve-candidates">
                {candidates.map(v => {
                  const isPicked = String(v.tcg_id) === selectedPickId;
                  const setMatch = v.group_abbreviation &&
                    v.group_abbreviation.replace(/-/g, '').toUpperCase() === (currentCard.setId || '').replace(/-/g, '').toUpperCase();
                  const cardAttrs = new Set(attrsOf(currentCard));
                  const prodAttrs = new Set(attrsOf(v));
                  // Render one tag per attribute key present on EITHER side,
                  // color-coded by whether catalog and product agree.
                  const relevantKeys = [...new Set([...cardAttrs, ...prodAttrs])];
                  return (
                    <button
                      key={v.tcg_id}
                      type="button"
                      className={`op-resolve-candidate ${isPicked ? 'is-active' : ''}`}
                      onClick={() => setSelectedPickId(String(v.tcg_id))}
                    >
                      <div className="op-resolve-candidate-name">{v.name}</div>
                      <div className="op-resolve-candidate-meta">
                        <span className={`op-resolve-candidate-tag ${setMatch ? 'is-ok' : 'is-warn'}`}>
                          {v.group_abbreviation || '?'}{v.group_name ? ` — ${v.group_name}` : ''}
                        </span>
                        {relevantKeys.length === 0 ? (
                          <span className="op-resolve-candidate-tag is-ok">Base</span>
                        ) : relevantKeys.map(k => {
                          const ok = cardAttrs.has(k) === prodAttrs.has(k);
                          const label = prodAttrs.has(k) ? attrLabel(k) : `Not ${attrLabel(k).toLowerCase()}`;
                          return (
                            <span key={k} className={`op-resolve-candidate-tag ${ok ? 'is-ok' : 'is-warn'}`}>
                              {label}
                            </span>
                          );
                        })}
                        <span className="op-resolve-candidate-tag">
                          {v.rarity || '?'}
                          {v.sub_type_name && v.sub_type_name !== 'Normal' ? ` · ${v.sub_type_name}` : ''}
                        </span>
                        <span className="op-resolve-candidate-price">
                          {v.market_price != null ? `$${Number(v.market_price).toFixed(2)}` : 'no price'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Field>

              {/* Diagnostics: surfaces why this card is in the queue / what's
                  off about its current resolution. Only shown when there IS
                  an existing resolution to evaluate. */}
              {currentDiagnostic?.resolved && (
                <div className={`op-resolve-diag ${currentDiagnostic.issues.length > 0 && !currentResolution?.confirmed ? 'has-issues' : 'is-ok'}`}>
                  <div className="op-resolve-diag-head">Current resolution</div>
                  {currentResolution?.confirmed && (
                    <div className="op-resolve-diag-row">
                      <span>Status</span>
                      <strong>✓ confirmed by you</strong>
                    </div>
                  )}
                  <div className="op-resolve-diag-row">
                    <span>TCGPlayer pick</span>
                    <strong>{currentResolution?.name || '(unnamed)'}</strong>
                  </div>
                  <div className="op-resolve-diag-row">
                    <span>Set match</span>
                    <strong className={currentDiagnostic.setMatch === false ? 'is-warn' : ''}>
                      {currentDiagnostic.setMatch === true ? '✓ same set'
                       : currentDiagnostic.setMatch === false ? `✗ ${currentResolution?.group_abbreviation || '?'} ≠ ${(currentCard.setId || '').replace(/-/g, '')}`
                       : '—'}
                    </strong>
                  </div>
                  {(currentDiagnostic.attributeMatches || []).map(m => {
                    const cardHas = attrsOf(currentCard).includes(m.key);
                    const pickHas = attrsOf(currentResolution).includes(m.key);
                    return (
                      <div key={m.key} className="op-resolve-diag-row">
                        <span>{m.label} match</span>
                        <strong className={!m.ok ? 'is-warn' : ''}>
                          {m.ok
                            ? (cardHas ? `✓ both ${m.label.toLowerCase()}` : `✓ neither ${m.label.toLowerCase()}`)
                            : `✗ catalog ${cardHas ? 'is' : 'is not'} ${m.label.toLowerCase()} · pick ${pickHas ? 'is' : 'is not'}`}
                        </strong>
                      </div>
                    );
                  })}
                  <div className="op-resolve-diag-row">
                    <span>Market price</span>
                    <strong className={!currentDiagnostic.hasPrice ? 'is-warn' : ''}>
                      {currentDiagnostic.hasPrice ? '✓ cached' : '✗ none yet'}
                    </strong>
                  </div>
                  {currentReport && (
                    <div className="op-resolve-diag-report">
                      <strong>⚑ You reported this</strong> on {new Date(currentReport.reported_at).toLocaleDateString()}
                      {currentReport.note && <> — "{currentReport.note}"</>}
                      {currentReport.pick_at_report && currentReport.pick_at_report.tcg_id !== currentResolution?.tcg_id && (
                        <> · was pointing at <em>{currentReport.pick_at_report.name}</em></>
                      )}
                      <button className="op-btn-ghost" style={{ marginLeft: 8, padding: '2px 8px' }} onClick={handleClearReport}>
                        Clear flag
                      </button>
                    </div>
                  )}
                </div>
              )}

              {!currentReport && (
                <details className="op-resolve-report">
                  <summary>Report this match as wrong</summary>
                  <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="text"
                      placeholder="(optional) what's wrong — e.g. 'this is the alt art, not the base'"
                      value={reportNote}
                      onChange={(e) => setReportNote(e.target.value)}
                      style={{ flex: 1, padding: '6px 10px', border: '1px solid var(--line-strong)', background: 'var(--paper)' }}
                    />
                    <button className="op-btn-ghost" onClick={handleReport}>Flag</button>
                  </div>
                </details>
              )}

          {error && <div className="op-graded-error">{error}</div>}

          <div className="op-resolve-actions">
            <button className="op-btn-ghost" onClick={handleBack} disabled={index === 0}>← Back</button>
            <button className="op-btn-ghost" onClick={handleSkip}>Skip</button>
            <button className="op-btn-primary" onClick={handleSave} disabled={!selected || loading}>
              Save &amp; Next →
            </button>
            <button className="op-btn-ghost" onClick={() => onAddCard(currentCard)}>Add to collection</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SetGroup({ group, onAddCard, onCardClick, onToggleWatch, watchedIds = new Set() }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="op-set-group">
      <button className="op-set-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="op-set-header-id">{group.setId}</div>
        <div className="op-set-header-name">{group.setName}</div>
        <div className="op-set-header-count">{group.cards.length}</div>
        <ChevronRight size={16} className={`op-chev ${!collapsed ? 'is-open' : ''}`} />
      </button>
      {!collapsed && (
        <div className="op-card-grid">
          {group.cards.map(card => (
            <CardTile
              key={card.id}
              card={card}
              onAddCard={onAddCard}
              onCardClick={onCardClick}
              onToggleWatch={onToggleWatch}
              isWatched={watchedIds.has(card.canonicalId || card.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CardTile({ card, onAddCard, onCardClick, onToggleWatch = () => {}, isWatched = false }) {
  return (
    <div className="op-card-tile">
      <button className="op-card-tile-main" onClick={() => onCardClick(card)}>
        <div className="op-card-tile-art">
          <CardArt card={card} />
          <div className="op-card-tile-rarity">{card.rarity}</div>
          {attrsOf(card).map(k => (
            <div key={k} className="op-card-tile-parallel">{attrLabel(k).toUpperCase()}</div>
          ))}
        </div>
        <div className="op-card-tile-body">
          <div className="op-card-tile-id">{card.displayId || card.id}</div>
          <div className="op-card-tile-name">
            {card.name}
            <VariantPill variant={card.variant} />
          </div>
          <div className="op-card-tile-price">
            <span className="op-card-tile-price-label">Raw</span>
            <span className="op-card-tile-price-val">${effectiveRawPrice(card).toFixed(2)}</span>
          </div>
        </div>
      </button>
      <div className="op-card-tile-actions">
        <button className="op-card-tile-add" onClick={() => onAddCard(card)}>
          <Plus size={14} /> Collection
        </button>
        <button
          className={`op-card-tile-watch ${isWatched ? 'is-active' : ''}`}
          onClick={() => onToggleWatch(card)}
          title={isWatched ? 'Remove from watch list' : 'Add to watch list'}
        >
          {isWatched ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}

function CardArt({ card, needsVariant }) {
  const [errored, setErrored] = useState(false);
  const [ref, imageUrl] = useEnhancedImage(card, { needsVariant });
  if (!imageUrl || errored) {
    return (
      <div ref={ref} className="op-card-art-fallback" style={{ background: `linear-gradient(135deg, ${fallbackColor(card.color)} 0%, ${fallbackColor(card.color)}aa 100%)` }}>
        <div className="op-card-art-fallback-name">{card.name}</div>
        <div className="op-card-art-fallback-id">{card.displayId || card.id}</div>
      </div>
    );
  }
  return (
    <img
      ref={ref}
      src={imageUrl}
      alt={card.name}
      className="op-card-art-img"
      loading="lazy"
      onError={() => setErrored(true)}
    />
  );
}

function FilterGroup({ label, value, onChange, options, mode, compact }) {
  if (mode === 'select') {
    return (
      <div className="op-filter-group">
        <div className="op-filter-label">{label}</div>
        <select className="op-filter-select" value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
      </div>
    );
  }
  return (
    <div className={`op-filter-group ${compact ? 'is-compact' : ''}`}>
      <div className="op-filter-label">{label}</div>
      <div className="op-filter-pills">
        {options.map(o => (
          <button
            key={o.v}
            className={`op-filter-pill ${compact ? 'is-compact' : ''} ${value === o.v ? 'is-active' : ''}`}
            onClick={() => onChange(o.v)}
          >
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
function AddCardModal({ card, entry, collections, activeCollectionId, onClose, onSave }) {
  const editing = Boolean(entry);
  // Synthetic 'all' isn't a real collection — fall back to the first real one
  // when the user adds a card while viewing All Collections.
  const defaultCollectionId = entry?.collection_id
    || (activeCollectionId && activeCollectionId !== 'all' ? activeCollectionId : (collections[0]?.id || null));
  const [collectionId, setCollectionId] = useState(defaultCollectionId);
  const members = useMemo(() => {
    const col = collections.find(c => c.id === collectionId);
    return Array.isArray(col?.members) ? col.members : [];
  }, [collections, collectionId]);
  const [condition, setCondition] = useState(entry?.condition || 'Near Mint');
  const [purchasePrice, setPurchasePrice] = useState(entry ? String(entry.purchase_price ?? '') : '');
  const [contributions, setContributions] = useState(
    entry?.contributions ? entry.contributions.map(c => ({ name: c.name, amount: String(c.amount) })) : []
  );
  const [notes, setNotes] = useState(entry?.notes || '');
  const [saving, setSaving] = useState(false);

  const [acquiredAt, setAcquiredAt] = useState(entry?.acquired_at || new Date().toISOString().slice(0, 10));

  const [isGraded, setIsGraded] = useState(Boolean(entry?.grading_company));
  const [gradingCompany, setGradingCompany] = useState(entry?.grading_company || 'PSA');
  const [grade, setGrade] = useState(entry?.grade ?? 10);
  const [bgsBlack, setBgsBlack] = useState(Boolean(entry?.bgs_black));
  const [certNumber, setCertNumber] = useState(entry?.cert_number || '');
  const [gradedPrice, setGradedPrice] = useState(entry?.graded_price ? String(entry.graded_price) : '');

  const addContribRow = () => setContributions([...contributions, { name: '', amount: '' }]);
  const updateContrib = (i, patch) => setContributions(contributions.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const removeContrib = (i) => setContributions(contributions.filter((_, idx) => idx !== i));

  const contribTotal = contributions.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const priceNum = Number(purchasePrice) || 0;
  const contribMismatch = contributions.length > 0 && Math.abs(contribTotal - priceNum) > 0.01;

  const handleSave = async () => {
    setSaving(true);
    const cid = card.canonicalId || card.id;
    const payload = {
      card_id: cid,
      collection_id: collectionId,
      condition,
      purchase_price: priceNum,
      contributions: contributions.filter(c => c.name.trim() && Number(c.amount) > 0).map(c => ({ name: c.name.trim(), amount: Number(c.amount) })),
      notes: notes.trim(),
      acquired_at: acquiredAt || null,
      grading_company: isGraded ? gradingCompany : null,
      grade: isGraded ? Number(grade) : null,
      bgs_black: Boolean(isGraded && gradingCompany === 'BGS' && Number(grade) === 10 && bgsBlack),
      cert_number: isGraded ? certNumber.trim() : '',
      graded_price: isGraded ? (Number(gradedPrice) || 0) : 0,
      // PriceCharting-specific columns retained on the entry (pc_product_id,
      // pc_product_name, price_source, price_fetched_at) are no longer
      // written from this modal — Stage 4 parks the auto-refresh flow.
      // Existing values on `entry` are preserved untouched by leaving them
      // out of the patch (shared Supabase keeps the prior value; solo
      // localStorage merges patch into the existing row).
    };
    if (editing) payload.id = entry.id;
    await onSave(payload);
    setSaving(false);
  };

  return (
    <div className="op-modal-backdrop" onClick={onClose}>
      <div className="op-modal" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="op-modal-header">
          <div className="op-modal-art-wrap">
            <CardArt card={card} />
          </div>
          <div>
            <div className="op-eyebrow">{editing ? 'Editing entry' : 'Logging acquisition'}</div>
            <div className="op-modal-title">
              {card.name}
              <VariantPill variant={card.variant} />
            </div>
            <div className="op-modal-sub">{card.displayId || card.id} · {card.setName} · {RARITY_LABELS[card.rarity] || card.rarity}</div>
            <div className="op-modal-market">
              Raw: <strong>${effectiveRawPrice(card).toFixed(2)}</strong>
            </div>
          </div>
        </div>

        <div className="op-form">
          <div className="op-form-row">
            <Field label="Collection">
              <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                {collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Condition">
              <select value={isGraded ? 'graded' : 'raw'} onChange={(e) => setIsGraded(e.target.value === 'graded')}>
                <option value="raw">Raw</option>
                <option value="graded">Graded</option>
              </select>
            </Field>
            {!isGraded && (
              <Field label="Raw grade">
                <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                  {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
            )}
          </div>

          <div className="op-form-row">
            <Field label="Total paid (USD)">
              <input
                type="number" step="0.01" placeholder="0.00"
                value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)}
              />
            </Field>
            <Field label="Date acquired">
              <input
                type="date"
                value={acquiredAt}
                onChange={(e) => setAcquiredAt(e.target.value)}
              />
            </Field>
          </div>

          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">Who paid what</div>
                <div className="op-form-section-sub">Split cost between people. Leave empty if one person paid in full.</div>
              </div>
              <button className="op-btn-ghost" onClick={addContribRow}>
                <Plus size={14} /> Add split
              </button>
            </div>

            {contributions.map((c, i) => (
              <ContribRow
                key={i}
                value={c}
                members={members}
                onChange={(patch) => updateContrib(i, patch)}
                onRemove={() => removeContrib(i)}
              />
            ))}

            {contributions.length > 0 && (
              <div className={`op-contrib-check ${contribMismatch ? 'is-warn' : 'is-ok'}`}>
                Splits total: <strong>${contribTotal.toFixed(2)}</strong> of <strong>${priceNum.toFixed(2)}</strong>
                {contribMismatch && <span> · doesn't match total paid</span>}
              </div>
            )}
          </div>

          {isGraded && (
          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">
                  <Award size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                  Grading
                </div>
                <div className="op-form-section-sub">Record PSA / BGS / CGC / SGC grade and cert number. Enter the graded price manually.</div>
              </div>
            </div>

                <div className="op-form-row">
                  <Field label="Grading company">
                    <select value={gradingCompany} onChange={(e) => setGradingCompany(e.target.value)}>
                      {GRADING_COMPANIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  <Field label="Grade">
                    <select value={grade} onChange={(e) => setGrade(Number(e.target.value))}>
                      {(GRADES_BY_COMPANY[gradingCompany] || []).map(g => (
                        <option key={g} value={g}>{g}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Cert # (optional)">
                    <input type="text" placeholder="e.g. 12345678" value={certNumber} onChange={(e) => setCertNumber(e.target.value)} />
                  </Field>
                </div>

                {gradingCompany === 'BGS' && Number(grade) === 10 && (
                  <label className="op-graded-toggle" style={{ marginBottom: 8 }}>
                    <input type="checkbox" checked={bgsBlack} onChange={(e) => setBgsBlack(e.target.checked)} />
                    <span>Black Label (Perfect 10 · all four subgrades = 10)</span>
                  </label>
                )}

                <Field label="Graded market price (USD)">
                  <input
                    type="number" step="0.01" placeholder="0.00"
                    value={gradedPrice} onChange={(e) => setGradedPrice(e.target.value)}
                  />
                </Field>
                <div className="op-graded-meta">
                  Auto-refresh paused — type the graded price manually. A graded
                  pricing source (eBay sold data + fair-value model) is on the
                  roadmap; until then graded value flows from this field.
                </div>
          </div>
          )}

          <Field label="Notes (optional)">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where bought, condition notes, etc." />
          </Field>

          <div className="op-form-actions">
            <button className="op-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="op-btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : (editing ? 'Save changes' : 'Save to Collection')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="op-field">
      <span className="op-field-label">{label}</span>
      {children}
    </label>
  );
}

// ============================================================================
function CardDetailDrawer({ card, entries, collections, watchEntry, onClose, onAddToCollection, onRemoveEntry, onToggleErrata, onToggleWatch }) {
  const erratMarked = hasPreErrata(card.id.replace(/__pre-errata$/, ''));
  const isWatched = Boolean(watchEntry);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  // Force re-read of resolution / report state when the user takes an action
  // (report / clear / re-resolve). Local state since the global variantRev
  // doesn't bump on report changes.
  const [, bumpResolutionTick] = useReducer(x => x + 1, 0);

  const cid = card.canonicalId || card.id;
  const resolution = getResolution(cid);
  const diagnostic = diagnoseResolution(card, resolution);
  const report = getMatchReport(cid);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    loadPriceHistory(card.id).then(h => {
      if (!cancelled) {
        setHistory(h);
        setHistoryLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [card.id]);

  const trend = useMemo(() => {
    if (history.length < 2) return 0;
    const first = history[0].price, last = history[history.length - 1].price;
    return first > 0 ? ((last - first) / first) * 100 : 0;
  }, [history]);

  const handleReportMatch = () => {
    const note = prompt(
      'Report bad TCGPlayer match — optional note ("alt art, not the base", etc.):',
      report?.note || ''
    );
    if (note === null) return; // user cancelled
    reportBadMatch(cid, note);
    bumpResolutionTick();
  };
  const handleClearReport = () => {
    clearMatchReport(cid);
    bumpResolutionTick();
  };
  const handleReResolve = async () => {
    if (!confirm('Forget the current TCGPlayer match for this card? The next viewport pass will auto-resolve it again from TCGCSV, or you can pick manually in the Resolve view.')) return;
    clearResolution(cid);
    clearMatchReport(cid);
    bumpResolutionTick();
    // Kick off a fresh auto-resolve so the price comes back without
    // requiring a viewport hit.
    await autoResolveCard(card);
    bumpResolutionTick();
  };

  return (
    <div className="op-drawer-backdrop" onClick={onClose}>
      <div className="op-drawer" onClick={(e) => e.stopPropagation()}>
        <button className="op-modal-close" onClick={onClose}><X size={18} /></button>

        <div className="op-drawer-hero">
          <div className="op-drawer-hero-img">
            <CardArt card={card} />
          </div>
          <div className="op-drawer-hero-meta">
            <div className="op-drawer-hero-id">{card.displayId || card.id}</div>
            <div className="op-drawer-hero-rarity">{RARITY_LABELS[card.rarity] || card.rarity}</div>
            <div className="op-drawer-hero-name">
              {card.name}
              <VariantPill variant={card.variant} />
            </div>
            <div className="op-drawer-hero-set">{card.setName}</div>
            {card.text && <div className="op-drawer-hero-text">{card.text}</div>}
          </div>
        </div>

        <div className="op-drawer-body">
          <div className="op-price-grid">
            <PriceCell label="Raw" value={`$${effectiveRawPrice(card).toFixed(2)}`} accent />
            <PriceCell
              label="14d trend"
              value={historyLoading ? '…' : `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`}
              tone={trend >= 0 ? 'pos' : 'neg'}
            />
          </div>

          <div className="op-section-title">
            <RefreshCw size={15} /> TCGPlayer match
          </div>
          {resolution ? (
            <div className={`op-resolve-diag ${diagnostic.issues.length > 0 ? 'has-issues' : 'is-ok'}`}>
              <div className="op-resolve-diag-row">
                <span>Pick</span>
                <strong>{resolution.name || '(unnamed)'}</strong>
              </div>
              <div className="op-resolve-diag-row">
                <span>Set · variant</span>
                <strong className={diagnostic.issues.length > 0 ? 'is-warn' : ''}>
                  {resolution.group_abbreviation || '?'}
                  {resolution.group_name ? ` · ${resolution.group_name}` : ''}
                  {attrsOf(resolution).length > 0
                    ? attrsOf(resolution).map(k => ` · ${attrLabel(k)}`).join('')
                    : ' · Base'}
                </strong>
              </div>
              {resolution.tcgplayer_url && (
                <div className="op-resolve-diag-row">
                  <span>TCGPlayer</span>
                  <a className="op-resolve-side-link" href={resolution.tcgplayer_url} target="_blank" rel="noreferrer">
                    Open product ↗
                  </a>
                </div>
              )}
              {report && (
                <div className="op-resolve-diag-report">
                  <strong>⚑ You reported this</strong> on {new Date(report.reported_at).toLocaleDateString()}
                  {report.note && <> — "{report.note}"</>}
                </div>
              )}
              <div className="op-drawer-actions" style={{ marginTop: 8, gap: 6 }}>
                {!report && (
                  <button className="op-btn-ghost" onClick={handleReportMatch} title="Flag this match as wrong — it'll show up in the Resolve view's Reported queue">
                    ⚑ Report bad match
                  </button>
                )}
                {report && (
                  <button className="op-btn-ghost" onClick={handleClearReport} title="Clear the report flag">
                    Clear flag
                  </button>
                )}
                <button className="op-btn-ghost" onClick={handleReResolve} title="Forget the current pick and auto-resolve again">
                  <RefreshCw size={14} /> Re-resolve
                </button>
              </div>
            </div>
          ) : (
            <div className="op-empty-mini">
              No TCGPlayer pick saved yet. Visit the Resolve view, or just open the card from search — auto-resolve fires on viewport entry.
            </div>
          )}

          <div className="op-section-title"><BarChart3 size={15} /> 14-day price history</div>
          {historyLoading ? (
            <div className="op-empty-mini">Loading price history…</div>
          ) : history.length < 2 ? (
            <div className="op-empty-mini">Not enough history available for this card yet.</div>
          ) : (
            <PriceChart data={history} color={fallbackColor(card.color)} />
          )}

          <div className="op-section-title"><Folder size={15} /> Copies in your collections ({entries.length})</div>
          {entries.length === 0 ? (
            <div className="op-empty-mini">No copies of this card logged yet.</div>
          ) : (
            <div className="op-detail-entries">
              {entries.map(entry => {
                const col = collections.find(c => c.id === entry.collection_id);
                const isGraded = Boolean(entry.grading_company);
                return (
                  <div key={entry.id} className="op-detail-entry">
                    <div className="op-detail-entry-head">
                      <div>
                        <div className="op-detail-entry-collection">
                          {col?.name || 'Unknown collection'}
                          {isGraded && <GradingBadge company={entry.grading_company} grade={entry.grade} bgsBlack={entry.bgs_black} gradeDescription={entry.grade_description} />}
                        </div>
                        <div className="op-detail-entry-meta">
                          {isGraded ? `${entry.grading_company} ${entry.grade}${entry.bgs_black ? ' Black Label' : ''}` : entry.condition} · Paid ${Number(entry.purchase_price || 0).toFixed(2)}
                          {entry.acquired_at && <> · Acquired {entry.acquired_at}</>}
                        </div>
                        {isGraded && (
                          <div className="op-detail-entry-meta">
                            Graded market: <strong>${Number(entry.graded_price || 0).toFixed(2)}</strong>
                            {entry.cert_number && <> · Cert # {entry.cert_number}</>}
                            {entry.price_fetched_at && <> · updated {new Date(entry.price_fetched_at).toLocaleDateString()}</>}
                          </div>
                        )}
                      </div>
                      <button className="op-detail-entry-remove" onClick={() => onRemoveEntry(entry.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {entry.contributions && entry.contributions.length > 0 && (
                      <div className="op-detail-entry-splits">
                        {entry.contributions.map((c, i) => (
                          <span key={i} className="op-split-chip">{c.name}: ${Number(c.amount).toFixed(2)}</span>
                        ))}
                      </div>
                    )}
                    {entry.notes && <div className="op-detail-entry-notes">{entry.notes}</div>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="op-drawer-actions">
            <button
              className="op-btn-ghost"
              onClick={onToggleWatch}
              title={isWatched ? 'Remove from watch list' : 'Add to watch list — scrapers will look for new listings'}
            >
              {isWatched ? <><EyeOff size={15} /> Unwatch</> : <><Eye size={15} /> Watch</>}
            </button>
            <button
              className="op-btn-ghost"
              onClick={onToggleErrata}
              title={erratMarked ? 'Remove the pre-errata variant from the catalog' : 'Add a pre-errata twin of this card to the catalog'}
            >
              {erratMarked ? 'Unmark pre-errata' : 'This card has pre-errata'}
            </button>
            <button className="op-btn-primary" onClick={onAddToCollection}>
              <Plus size={15} /> Log a copy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PriceCell({ label, value, tone, accent }) {
  return (
    <div className={`op-price-cell ${accent ? 'is-accent' : ''} ${tone ? `is-${tone}` : ''}`}>
      <div className="op-price-cell-label">{label}</div>
      <div className="op-price-cell-val">{value}</div>
    </div>
  );
}

function PriceChart({ data, color }) {
  const W = 600, H = 160, P = 22;
  const prices = data.map(d => d.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const pts = data.map((d, i) => {
    const x = P + (i / Math.max(1, data.length - 1)) * (W - P * 2);
    const y = H - P - ((d.price - min) / range) * (H - P * 2);
    return { x, y, price: d.price, date: d.date };
  });
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const area = `${path} L ${pts[pts.length - 1].x} ${H - P} L ${pts[0].x} ${H - P} Z`;

  return (
    <div className="op-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="op-chart-svg">
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#chartFill)" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3" fill={color} />
        ))}
      </svg>
      <div className="op-chart-axis">
        <span>{data[0].date}</span>
        <span>${min.toFixed(2)} – ${max.toFixed(2)}</span>
        <span>{data[data.length - 1].date}</span>
      </div>
    </div>
  );
}
