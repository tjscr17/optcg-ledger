import React, { useState, useEffect, useMemo, useRef, useCallback, useReducer } from 'react';
import { Search, Plus, X, TrendingUp, TrendingDown, Folder, Trash2, DollarSign, Anchor, ChevronRight, Package, BarChart3, RefreshCw, Cloud, HardDrive, ImageOff, Award, Loader2, Pencil, Eye, EyeOff } from 'lucide-react';
import { store, MODE, VAULT_LABEL } from './storage.js';
import { loadCatalog, loadPriceHistory, groupBySet, compareSets, augmentWithErrata, hasPreErrata, togglePreErrata } from './catalog.js';
import {
  GRADING_COMPANIES, GRADES_BY_COMPANY,
  fetchGradedPrice, isAggregateAcrossCompanies, hasToken,
  searchVariants, getSavedPick, savePick, priceFromProduct,
  getCachedImage, resolveEnhancedImage,
  PRICE_TIERS, getCachedTierPrice, getCachedLoosePrice, isVariantSnapshotFresh, resolveVariantSnapshot,
  onVariantResolved, hydrateFromShared, subscribeResolutions,
} from './grading.js';

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

// All prices in the app come from PriceCharting. Raw = PC `loose-price`.
// Returns 0 if the card's variant hasn't been resolved yet — viewport-based
// lazy resolution will eventually populate it and components re-render via
// the onVariantResolved emitter.
const effectiveRawPrice = (card) => {
  if (!card) return 0;
  return getCachedLoosePrice(card.id) ?? 0;
};

// Dedup in-flight PriceCharting fetches across components in the same tick.
const inFlightLookups = new Map();
// useEnhancedImage: returns [ref, url, variantTick]. Attach ref to the rendered
// element so PriceCharting fetches only fire when the card scrolls into the
// viewport (with a 200px margin so we pre-fetch just before it appears).
// Pass `needsVariant: true` when the caller needs cached price tiers — the
// hook will also fetch the variant snapshot when in view, even if the image
// is already present. variantTick increments when a variant is resolved so
// consumers can re-read from the cache.
const useEnhancedImage = (card, opts = {}) => {
  // Prices in this app come from PriceCharting (loose-price, tier fields),
  // so we always want a variant snapshot for any visible card. Image-only
  // fetches are no longer enough — needsVariant defaults to true.
  const needsVariant = opts.needsVariant !== false;
  const ref = useRef(null);
  const synchronousImage = card?.imageUrl || (card ? getCachedImage(card.id) : null);
  const needsImage = !synchronousImage;
  const needsFetch = needsImage || (needsVariant && card && !isVariantSnapshotFresh(card.id));
  const [url, setUrl] = useState(synchronousImage);
  const [inView, setInView] = useState(!needsFetch);
  const [variantTick, setVariantTick] = useState(0);

  useEffect(() => {
    if (inView || !ref.current || !needsFetch) return;
    const el = ref.current;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setInView(true); obs.disconnect(); }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView, needsFetch]);

  useEffect(() => {
    if (!card) return;
    const freshImage = card.imageUrl || getCachedImage(card.id);
    if (freshImage && freshImage !== url) setUrl(freshImage);
    if (!inView || !needsFetch || !hasToken()) return;
    let cancelled = false;
    const cacheKey = card.id;
    const fetcher = needsImage ? resolveEnhancedImage : resolveVariantSnapshot;
    const existing = inFlightLookups.get(cacheKey);
    const promise = existing || fetcher(card);
    if (!existing) inFlightLookups.set(cacheKey, promise);
    promise.then(resolved => {
      inFlightLookups.delete(cacheKey);
      if (cancelled) return;
      // resolveEnhancedImage returns a URL string; resolveVariantSnapshot returns boolean
      if (needsImage && typeof resolved === 'string' && resolved) setUrl(resolved);
      if (resolved) setVariantTick(t => t + 1);
    });
    return () => { cancelled = true; };
  }, [card, inView, needsFetch, needsImage]);

  return [ref, url, variantTick];
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

  // Pull shared-mode card resolutions into the local cache, then subscribe
  // to real-time updates from teammates. No-ops in solo mode.
  useEffect(() => {
    hydrateFromShared().catch(() => {});
    const unsub = subscribeResolutions();
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
      try { await refreshData(); }
      finally { setLoading(false); }
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

  // variantRev increments whenever ANY card's PriceCharting variant snapshot
  // lands in the cache. We use it as a useMemo dep so derived computations
  // (collection stats, equity, sort orders) re-read fresh PC prices.
  const [variantRev, setVariantRev] = useState(0);
  useEffect(() => onVariantResolved(() => setVariantRev(r => r + 1)), []);
  const augmentedCatalog = useMemo(
    () => augmentWithErrata(catalog),
    // erratTick is read inside augmentWithErrata via readErrataSet()
    [catalog, erratTick] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Quick catalog lookup (uses augmented list so entries can resolve to twins).
  const catalogIndex = useMemo(() => {
    const m = new Map();
    for (const c of augmentedCatalog) m.set(c.id, c);
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
      setEntries([...entries, created]);
      logTransaction({ type: 'buy', entry: created });
    }
  };

  const updateEntry = async (id, patch) => {
    const before = entries.find(e => e.id === id);
    const updated = await store.update('entries', id, patch);
    if (!updated) return;
    setEntries(entries.map(e => e.id === id ? updated : e));

    // If the user moved the entry to a different collection, drag its buy
    // transactions along so the capital allocation follows the card. Match
    // by entry_id (set on tx insert) when available, otherwise fall back to
    // card_id + occurred_at heuristic for legacy buy txs.
    if (before && patch.collection_id && patch.collection_id !== before.collection_id) {
      const oldDate = (before.acquired_at || (before.added_at || '').slice(0, 10) || '').slice(0, 10);
      const linked = transactions.filter(t => {
        if (t.type !== 'buy') return false;
        if (t.entry_id) return t.entry_id === id;
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

  // Silent removal — used for orphan rows (cards not in catalog) where there
  // isn't enough info to record a sell. The Sell flow is the normal path.
  const removeEntry = async (id) => {
    await store.remove('entries', id);
    setEntries(entries.filter(e => e.id !== id));
  };

  const addToWatchlist = async (card, opts = {}) => {
    if (watchlist.some(w => w.card_id === card.id)) return;
    const created = await store.insert('watchlist', {
      id: uid(),
      card_id: card.id,
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
            catalogIndex={catalogIndex}
            variantRev={variantRev}
            onSearchClick={() => setView('search')}
            onCardClick={(card) => setDetailCard(card)}
            onRemoveEntry={removeEntry}
            onSellEntry={(entry) => setSellingEntry(entry)}
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
            onAddCard={setAddingCard}
            onCardClick={setDetailCard}
            onToggleWatch={async (card) => {
              const existing = watchlist.find(w => w.card_id === card.id);
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
            }}
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

      {detailCard && (
        <CardDetailDrawer
          card={detailCard}
          entries={entries.filter(e => e.card_id === detailCard.id)}
          collections={collections}
          watchEntry={watchlist.find(w => w.card_id === detailCard.id) || null}
          onClose={() => setDetailCard(null)}
          onAddToCollection={() => { setAddingCard(detailCard); setDetailCard(null); }}
          onRemoveEntry={removeEntry}
          onToggleWatch={() => {
            const existing = watchlist.find(w => w.card_id === detailCard.id);
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
      )}

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
        <button className={`op-nav-btn ${view === 'search' ? 'is-active' : ''}`} onClick={() => setView('search')}>
          <Search size={15} /> Search
        </button>
        <button className={`op-nav-btn ${view === 'watch' ? 'is-active' : ''}`} onClick={() => setView('watch')}>
          <Eye size={15} /> Watch
        </button>
        <button className={`op-nav-btn ${view === 'transactions' ? 'is-active' : ''}`} onClick={() => setView('transactions')}>
          <BarChart3 size={15} /> Transactions
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
                  ★ All Collections <span className="op-collection-item-sub">aggregate across {collections.length}</span>
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
function CollectionView({ collection, entries, catalogIndex, variantRev = 0, onSearchClick, onCardClick, onRemoveEntry, onSellEntry = () => {}, onEditEntry = () => {}, onUpdateMembers }) {
  const members = Array.isArray(collection?.members) ? collection.members : [];
  const isSynthetic = Boolean(collection?.synthetic);
  const [entrySort, setEntrySort] = useStoredState('optcg:collection:entrySort', 'recent');
  const [colQ, setColQ] = useStoredState('optcg:collection:q', '');

  // Effective market value for an entry — uses the entry's stored graded
  // price when present, otherwise falls back to the cached PriceCharting raw.
  const marketValueOf = useCallback((e) => {
    if (e.grading_company && Number(e.graded_price) > 0) return Number(e.graded_price);
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
    let totalPaid = 0, totalMarket = 0, gradedCount = 0;
    for (const e of entries) {
      totalPaid += Number(e.purchase_price) || 0;
      if (e.grading_company && Number(e.graded_price) > 0) {
        totalMarket += Number(e.graded_price);
        gradedCount += 1;
      } else {
        const card = catalogIndex.get(e.card_id);
        if (card) totalMarket += effectiveRawPrice(card);
      }
    }
    return { totalPaid, totalMarket, count: entries.length, gradedCount };
    // variantRev forces recompute when PC variant snapshots land
  }, [entries, catalogIndex, variantRev]);

  const profit = stats.totalMarket - stats.totalPaid;
  const profitPct = stats.totalPaid > 0 ? (profit / stats.totalPaid) * 100 : 0;

  return (
    <div className="op-view">
      <div className="op-page-head">
        <div>
          <div className="op-eyebrow">Active Collection</div>
          <h1 className="op-page-title">{collection?.name || 'No collection'}</h1>
          <div className="op-page-sub">{stats.count} {stats.count === 1 ? 'card' : 'cards'} logged in this collection</div>
        </div>
        <button className="op-btn-primary" onClick={onSearchClick}>
          <Plus size={16} /> Add Cards
        </button>
      </div>

      {!isSynthetic && onUpdateMembers && (
        <MembersPanel members={members} onUpdate={onUpdateMembers} />
      )}

      <div className="op-stats">
        <Stat label="Paid In" value={`$${stats.totalPaid.toFixed(2)}`} />
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
              const marketValue = entry.grading_company && Number(entry.graded_price) > 0
                ? Number(entry.graded_price)
                : effectiveRawPrice(card);
              const delta = marketValue - (Number(entry.purchase_price) || 0);
              return (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  card={card}
                  marketValue={marketValue}
                  delta={delta}
                  onClick={() => onCardClick(card)}
                  onSell={() => onSellEntry(entry)}
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
    //   sell:          contributors took proceeds out (positive = money out)
    //   transfer:      contributions are already signed (negative = sender, positive = receiver)
    const signedContribsOf = (tx) => {
      const list = Array.isArray(tx.contributions) ? tx.contributions : [];
      return list.flatMap(c => {
        const amt = Number(c.amount) || 0;
        if (!c.name || amt === 0) return [];
        if (tx.type === 'sell') return [{ name: c.name.trim(), amount: -Math.abs(amt) }];
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
      // For buys, give existing unitholders any instant gain from acquiring a
      // card whose market exceeds what we paid.
      if (ev.kind === 'buy') {
        const market = currentNavOfCard(t.card_id);
        const paid = Number(t.amount) || 0;
        const bonus = Math.max(0, market - paid);
        if (bonus > 0) nav += bonus;
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

function EntryRow({ entry, card, marketValue, delta, onClick, onSell, onEdit, onDelete }) {
  const isGraded = Boolean(entry.grading_company);
  return (
    <div className="op-entry">
      <button className="op-entry-main" onClick={onClick}>
        <CardThumb card={card} size={48} />
        <div className="op-entry-info">
          <div className="op-entry-cardname">
            <span className="op-entry-cardname-text">{card.name}</span>
            <VariantPill variant={card.variant} />
            {isGraded
              ? <GradingBadge company={entry.grading_company} grade={entry.grade} bgsBlack={entry.bgs_black} />
              : <RawBadge condition={entry.condition} />}
          </div>
          <div className="op-entry-cardset">
            <span className="op-entry-id">{card.displayId || card.id}</span> · {card.setName} · {RARITY_LABELS[card.rarity] || card.rarity}
          </div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">Paid</div>
          <div className="op-entry-cell-val">${Number(entry.purchase_price || 0).toFixed(2)}</div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">Market</div>
          <div className="op-entry-cell-val">${(marketValue || 0).toFixed(2)}</div>
        </div>
        <div className={`op-entry-delta ${delta >= 0 ? 'is-pos' : 'is-neg'}`}>
          {delta >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {delta >= 0 ? '+' : ''}${delta.toFixed(2)}
        </div>
      </button>
      <button className="op-entry-remove" onClick={onEdit} title="Edit entry">
        <Pencil size={14} />
      </button>
      <button className="op-entry-remove op-entry-sell" onClick={onSell} title="Record a sale">
        <DollarSign size={14} />
      </button>
      <button className="op-entry-remove" onClick={onDelete} title="Delete entry (no transaction logged)">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function GradingBadge({ company, grade, bgsBlack }) {
  const label = bgsBlack ? `${company} ${grade} BL` : `${company} ${grade}`;
  const classKey = bgsBlack ? 'bgs-black' : (company || '').toLowerCase();
  return (
    <span className={`op-grade-badge is-${classKey}`} title={bgsBlack ? `${company} ${grade} Black Label (Perfect 10)` : `${company} ${grade}`}>
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
function SearchView({ catalog, watchlist = [], onAddCard, onCardClick, onToggleWatch = () => {} }) {
  const watchedIds = useMemo(() => new Set(watchlist.map(w => w.card_id)), [watchlist]);
  const [q, setQ] = useStoredState('optcg:search:q', '');
  const [setFilter, setSetFilter] = useStoredState('optcg:search:setFilter', 'all');
  const [filterDim, setFilterDim] = useStoredState('optcg:search:filterDim', 'none'); // 'none' | 'rarity' | 'color'
  const [filterValue, setFilterValue] = useStoredState('optcg:search:filterValue', 'all');
  const [sortBy, setSortBy] = useStoredState('optcg:search:sortBy', 'set'); // 'set' | 'name' | 'price-desc' | 'price-asc'
  const [priceTier, setPriceTier] = useStoredState('optcg:search:priceTier', 'raw');
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
  }, [filtered, sortBy]);

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

        <FilterGroup label="Price as" value={priceTier} onChange={setPriceTier} mode="select" options={
          PRICE_TIERS.map(t => ({ v: t.value, l: t.label }))
        } />

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
              priceTier={priceTier}
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
              isWatched={watchedIds.has(card.id)}
              priceTier={priceTier}
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
      contributions: [
        { name: fromName.trim(), amount: -amt },
        { name: toName.trim(), amount: amt },
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
function ExpenseModal({ members = [], collection, onClose, onSave }) {
  const [description, setDescription] = useState('');
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
    await onSave({
      collection_id: collection?.id || null,
      card_id: null,
      card_display_name: description.trim() || 'Expense',
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
          <div>
            <div className="op-eyebrow">Logging expense</div>
            <div className="op-modal-title">Pool expense</div>
            <div className="op-modal-sub">{collection?.name || 'Unscoped'} · sleeves, grading fees, shipping, etc.</div>
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
function TransactionsView({ transactions, collections, entries = [], catalogIndex = new Map(), variantRev = 0, activeCollectionId, onLogTransaction = () => {} }) {
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
  const [modal, setModal] = useState(null); // 'transfer' | 'expense' | null

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
      if (e.grading_company && Number(e.graded_price) > 0) nav += Number(e.graded_price);
      else {
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
    let bought = 0, sold = 0, expenses = 0;
    for (const t of filtered) {
      if (t.type === 'buy') bought += Number(t.amount) || 0;
      if (t.type === 'sell') sold += Number(t.amount) || 0;
      if (t.type === 'expense') expenses += Number(t.amount) || 0;
    }
    return { bought, sold, expenses, net: sold - bought - expenses };
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
          </div>
        </div>
      </div>

      {modal === 'transfer' && (
        <TransferModal
          members={equityMembers}
          collection={equityCollection}
          onClose={() => setModal(null)}
          onSave={async (payload) => { await onLogTransaction(payload); setModal(null); }}
        />
      )}
      {modal === 'expense' && (
        <ExpenseModal
          members={equityMembers}
          collection={equityCollection}
          onClose={() => setModal(null)}
          onSave={async (payload) => { await onLogTransaction(payload); setModal(null); }}
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
            <TransactionRow key={t.id} tx={t} collection={collectionsById.get(t.collection_id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TransactionRow({ tx, collection }) {
  const amount = Number(tx.amount) || 0;
  // Visual style + sign per type
  const meta = {
    buy:      { label: 'BUY',      cls: 'is-buy',      tone: 'is-neg', sign: '−' },
    sell:     { label: 'SELL',     cls: 'is-sell',     tone: 'is-pos', sign: '+' },
    transfer: { label: 'TRANSFER', cls: 'is-transfer', tone: '',       sign: '' },
    expense:  { label: 'EXPENSE',  cls: 'is-expense',  tone: 'is-neg', sign: '−' },
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
    </div>
  );
}

// ============================================================================
function ResolveView({ catalog, entries, onAddCard, onCardClick }) {
  const [filterMode, setFilterMode] = useState('unresolved'); // 'unresolved' | 'in-collection' | 'all'
  const [index, setIndex] = useState(0);

  // Bulk prefetch state
  const [prefetching, setPrefetching] = useState(false);
  const [prefetchDone, setPrefetchDone] = useState(0);
  const [prefetchTotal, setPrefetchTotal] = useState(0);
  const [prefetchFailed, setPrefetchFailed] = useState(0);
  const abortRef = useRef(false);

  const queue = useMemo(() => {
    if (filterMode === 'in-collection') {
      const ids = new Set(entries.map(e => e.card_id));
      return catalog.filter(c => ids.has(c.id));
    }
    if (filterMode === 'unresolved') {
      return catalog.filter(c => !isVariantSnapshotFresh(c.id));
    }
    return catalog;
  }, [catalog, entries, filterMode]);

  const runPrefetch = async () => {
    if (prefetching) return;
    if (!hasToken()) { alert('PriceCharting token missing — set VITE_PRICECHARTING_TOKEN.'); return; }
    const targets = catalog.filter(c => !isVariantSnapshotFresh(c.id));
    if (targets.length === 0) { alert('Everything is already resolved.'); return; }
    if (!confirm(`Prefetch ${targets.length.toLocaleString()} unresolved card${targets.length === 1 ? '' : 's'} from PriceCharting? This may take several minutes.`)) return;
    abortRef.current = false;
    setPrefetching(true);
    setPrefetchTotal(targets.length);
    setPrefetchDone(0);
    setPrefetchFailed(0);

    const concurrency = 3;
    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        if (abortRef.current) return;
        const card = targets[idx++];
        try {
          const ok = await resolveVariantSnapshot(card);
          if (!ok) setPrefetchFailed(f => f + 1);
        } catch {
          setPrefetchFailed(f => f + 1);
        }
        setPrefetchDone(d => d + 1);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    setPrefetching(false);
  };
  const cancelPrefetch = () => { abortRef.current = true; };

  const currentCard = queue[index];

  const [variants, setVariants] = useState([]);
  const [selectedPickId, setSelectedPickId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setIndex(0);
  }, [filterMode]);

  useEffect(() => {
    setVariants([]);
    setSelectedPickId('');
    setError('');
    if (!currentCard) return;
    if (!hasToken()) { setError('PriceCharting token missing — set VITE_PRICECHARTING_TOKEN in .env.local.'); return; }
    let cancelled = false;
    setLoading(true);
    searchVariants(currentCard).then(matches => {
      if (cancelled) return;
      setVariants(matches);
      if (matches.length === 0) {
        setError(`No PriceCharting match for ${currentCard.displayId || currentCard.id}.`);
      } else {
        const saved = getSavedPick(currentCard.id);
        const chosen = (saved && matches.find(v => String(v.id) === saved.id)) || matches[0];
        setSelectedPickId(String(chosen.id));
      }
    }).catch(e => {
      if (!cancelled) setError(e.message || 'Failed to load PriceCharting matches.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [currentCard]);

  const selected = variants.find(v => String(v.id) === selectedPickId);

  const handleSave = () => {
    if (selected && currentCard) savePick(currentCard.id, selected);
    setIndex(i => i + 1);
  };
  const handleSkip = () => setIndex(i => i + 1);
  const handleBack = () => setIndex(i => Math.max(0, i - 1));

  return (
    <div className="op-view">
      <div className="op-page-head">
        <div>
          <div className="op-eyebrow">Catalog cleanup</div>
          <h1 className="op-page-title">Resolve cards</h1>
          <div className="op-page-sub">Pick the correct PriceCharting variant for each card. Saves auto-populate graded prices and TCGPlayer art.</div>
        </div>
      </div>

      <div className="op-filters">
        <FilterGroup label="Queue" value={filterMode} onChange={setFilterMode} mode="select" options={[
          { v: 'unresolved', l: 'Unresolved cards only' },
          { v: 'in-collection', l: 'Cards in my collections' },
          { v: 'all', l: 'All cards' },
        ]} />

        <div className="op-filter-group">
          <div className="op-filter-label">Bulk</div>
          {!prefetching ? (
            <button className="op-btn-ghost" onClick={runPrefetch} title="Resolve every unresolved card from PriceCharting in the background">
              <RefreshCw size={14} /> Prefetch all unresolved
            </button>
          ) : (
            <button className="op-btn-ghost" onClick={cancelPrefetch}>
              <X size={14} /> Cancel
            </button>
          )}
        </div>
      </div>

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
          Prefetch complete · {(prefetchTotal - prefetchFailed).toLocaleString()} resolved, {prefetchFailed.toLocaleString()} unmatched.
        </div>
      )}

      {queue.length === 0 ? (
        <div className="op-empty">
          <Package size={36} strokeWidth={1.2} />
          <div className="op-empty-title">Nothing to resolve here</div>
          <div className="op-empty-sub">
            {filterMode === 'unresolved' ? 'Every card has a cached PriceCharting variant.' :
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
            <div className="op-resolve-art" onClick={() => onCardClick(currentCard)} role="button">
              <CardArt card={currentCard} needsVariant />
            </div>
            <div className="op-resolve-meta">
              <div className="op-eyebrow">{currentCard.displayId || currentCard.id} · {currentCard.setName}</div>
              <div className="op-resolve-name">
                {currentCard.name}
                <VariantPill variant={currentCard.variant} />
              </div>
              <div className="op-resolve-sub">
                {RARITY_LABELS[currentCard.rarity] || currentCard.rarity} · Raw: ${effectiveRawPrice(currentCard).toFixed(2)}
              </div>

              <Field label="PriceCharting variant">
                <div className="op-variant-row">
                  <select
                    value={selectedPickId}
                    onChange={(e) => setSelectedPickId(e.target.value)}
                    disabled={loading || variants.length === 0}
                  >
                    {loading && <option>Loading matches…</option>}
                    {!loading && variants.length === 0 && <option value="">No matches</option>}
                    {variants.map(v => (
                      <option key={v.id} value={String(v.id)}>
                        {v['product-name']} — {v['console-name']}
                      </option>
                    ))}
                  </select>
                </div>
              </Field>

              {selected && (
                <div className="op-resolve-prices">
                  {PRICE_TIERS.filter(t => t.value !== 'raw').map(t => {
                    const cents = Number(selected[t.field]) || 0;
                    const dollars = cents > 0 ? cents / 100 : null;
                    return (
                      <div key={t.value} className="op-resolve-price-row">
                        <span className="op-resolve-price-label">{t.label}</span>
                        <span className="op-resolve-price-val">{dollars != null ? `$${dollars.toFixed(2)}` : '—'}</span>
                      </div>
                    );
                  })}
                </div>
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
          </div>
        </div>
      )}
    </div>
  );
}

function SetGroup({ group, onAddCard, onCardClick, onToggleWatch, watchedIds = new Set(), priceTier }) {
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
              isWatched={watchedIds.has(card.id)}
              priceTier={priceTier}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CardTile({ card, onAddCard, onCardClick, onToggleWatch = () => {}, isWatched = false, priceTier = 'raw' }) {
  const showTier = priceTier && priceTier !== 'raw';
  const tierMeta = PRICE_TIERS.find(t => t.value === priceTier);
  // Force re-read of the variant cache when this card's snapshot lands.
  const [, bumpTick] = useReducer(x => x + 1, 0);
  useEffect(() => {
    if (!showTier) return;
    return onVariantResolved((id) => { if (id === card.id) bumpTick(); });
  }, [card.id, showTier]);
  const tierPrice = showTier ? getCachedTierPrice(card.id, priceTier) : null;
  return (
    <div className="op-card-tile">
      <button className="op-card-tile-main" onClick={() => onCardClick(card)}>
        <div className="op-card-tile-art">
          <CardArt card={card} needsVariant={showTier} />
          <div className="op-card-tile-rarity">{card.rarity}</div>
          {card.isParallel && <div className="op-card-tile-parallel">PARALLEL</div>}
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
          {showTier && (
            <div className="op-card-tile-price op-card-tile-price-tier">
              <span className="op-card-tile-price-label">{tierMeta?.label || priceTier}</span>
              <span className="op-card-tile-price-val">
                {tierPrice != null ? `$${tierPrice.toFixed(2)}` : '—'}
              </span>
            </div>
          )}
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
  const [pcProductId, setPcProductId] = useState(entry?.pc_product_id || '');
  const [pcProductName, setPcProductName] = useState(entry?.pc_product_name || '');
  const [priceFetchedAt, setPriceFetchedAt] = useState(entry?.price_fetched_at || '');
  const [fetchingPrice, setFetchingPrice] = useState(false);
  const [priceFetchError, setPriceFetchError] = useState('');

  const [variants, setVariants] = useState([]);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [variantsError, setVariantsError] = useState('');

  const addContribRow = () => setContributions([...contributions, { name: '', amount: '' }]);
  const updateContrib = (i, patch) => setContributions(contributions.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const removeContrib = (i) => setContributions(contributions.filter((_, idx) => idx !== i));

  const contribTotal = contributions.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const priceNum = Number(purchasePrice) || 0;
  const contribMismatch = contributions.length > 0 && Math.abs(contribTotal - priceNum) > 0.01;

  const loadVariants = useCallback(async () => {
    setVariantsError('');
    if (!hasToken()) {
      setVariantsError('PriceCharting token missing — set VITE_PRICECHARTING_TOKEN in .env.local and restart the dev server.');
      return;
    }
    setVariantsLoading(true);
    try {
      const list = await searchVariants(card);
      setVariants(list);
      if (list.length === 0) {
        setVariantsError(`No PriceCharting match found for ${card.id}.`);
        setPcProductId('');
        setPcProductName('');
        return;
      }
      const saved = getSavedPick(card.id);
      const chosen = (saved && list.find(v => String(v.id) === saved.id)) || list[0];
      setPcProductId(String(chosen.id));
      setPcProductName(chosen['product-name']);
    } catch (e) {
      setVariantsError(e.message || 'Failed to load PriceCharting variants.');
    } finally {
      setVariantsLoading(false);
    }
  }, [card]);

  const refreshGradedPrice = useCallback(async () => {
    setPriceFetchError('');
    if (!pcProductId) return;
    setFetchingPrice(true);
    try {
      const result = await fetchGradedPrice({ productId: pcProductId, productName: pcProductName, gradingCompany, grade });
      if (!result) {
        setPriceFetchError('Could not fetch price.');
      } else if (result.missing) {
        setPriceFetchError(`PriceCharting has no recorded ${gradingCompany} ${grade} sales for this variant.`);
        setGradedPrice('0.00');
        setPriceFetchedAt(result.fetched_at);
      } else {
        setGradedPrice(result.price.toFixed(2));
        setPriceFetchedAt(result.fetched_at);
      }
    } catch (e) {
      setPriceFetchError(e.message || 'Failed to fetch graded price.');
    } finally {
      setFetchingPrice(false);
    }
  }, [pcProductId, pcProductName, gradingCompany, grade]);

  // Load the variant list when grading is toggled on
  useEffect(() => {
    if (!isGraded) return;
    if (variants.length === 0 && !variantsLoading && !variantsError) {
      loadVariants();
    }
  }, [isGraded, variants.length, variantsLoading, variantsError, loadVariants]);

  // Refetch price whenever the chosen variant or grade changes.
  // BGS Black Label has no PriceCharting API field — skip auto-fetch in that
  // mode so we don't silently populate with the regular BGS 10 price.
  useEffect(() => {
    if (!isGraded || !pcProductId) return;
    if (bgsBlack) return;
    refreshGradedPrice();
  }, [isGraded, pcProductId, gradingCompany, grade, bgsBlack, refreshGradedPrice]);

  const selectedVariant = variants.find(v => String(v.id) === pcProductId);

  const handleSave = async () => {
    setSaving(true);
    if (isGraded && selectedVariant) savePick(card.id, selectedVariant);
    const payload = {
      card_id: card.id,
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
      pc_product_id: isGraded ? pcProductId : '',
      pc_product_name: isGraded ? pcProductName : '',
      price_source: isGraded && pcProductId ? 'pricecharting' : '',
      price_fetched_at: isGraded && priceFetchedAt ? priceFetchedAt : null,
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
              {(() => {
                const p = getCachedTierPrice(card.id, 'psa10');
                return p != null ? <> · PSA 10: <strong>${p.toFixed(2)}</strong></> : null;
              })()}
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
              <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
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

          <div className="op-form-section">
            <div className="op-form-section-head">
              <div>
                <div className="op-form-section-title">
                  <Award size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
                  Grading
                </div>
                <div className="op-form-section-sub">Track PSA, BGS, CGC, or SGC grade and pull live graded market price.</div>
              </div>
              <label className="op-graded-toggle">
                <input type="checkbox" checked={isGraded} onChange={(e) => setIsGraded(e.target.checked)} />
                <span>This copy is graded</span>
              </label>
            </div>

            {isGraded && (
              <>
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
                    <span>Black Label (Perfect 10 · all four subgrades = 10) — manual price only</span>
                  </label>
                )}

                <Field label="PriceCharting variant">
                  <div className="op-variant-row">
                    <select
                      value={pcProductId}
                      onChange={(e) => {
                        const v = variants.find(x => String(x.id) === e.target.value);
                        setPcProductId(e.target.value);
                        setPcProductName(v ? v['product-name'] : '');
                      }}
                      disabled={variantsLoading || variants.length === 0}
                    >
                      {variantsLoading && <option>Loading variants…</option>}
                      {!variantsLoading && variants.length === 0 && <option value="">No matches</option>}
                      {variants.map(v => {
                        const q = priceFromProduct(v, gradingCompany, grade);
                        const tag = q.price > 0 ? `${gradingCompany} ${grade}: $${q.price.toFixed(2)}` : 'no price';
                        return (
                          <option key={v.id} value={String(v.id)}>
                            {v['product-name']} — {v['console-name']} · {tag}
                          </option>
                        );
                      })}
                    </select>
                    <button
                      type="button"
                      className="op-btn-ghost"
                      onClick={loadVariants}
                      disabled={variantsLoading}
                      title="Re-run PriceCharting search"
                    >
                      {variantsLoading ? <Loader2 size={14} className="op-spin" /> : <RefreshCw size={14} />}
                    </button>
                  </div>
                </Field>

                <div className="op-form-row">
                  <Field label="Graded market price (USD)">
                    <div className="op-graded-price-row">
                      <input
                        type="number" step="0.01" placeholder="0.00"
                        value={gradedPrice} onChange={(e) => setGradedPrice(e.target.value)}
                      />
                      <button
                        type="button"
                        className="op-btn-ghost"
                        onClick={refreshGradedPrice}
                        disabled={fetchingPrice || !pcProductId}
                        title="Fetch from PriceCharting"
                      >
                        {fetchingPrice ? <Loader2 size={14} className="op-spin" /> : <RefreshCw size={14} />}
                        {fetchingPrice ? 'Fetching…' : 'Refresh'}
                      </button>
                    </div>
                  </Field>
                </div>

                {pcProductName && priceFetchedAt && (
                  <div className="op-graded-meta">
                    Using <strong>{pcProductName}</strong> · fetched {new Date(priceFetchedAt).toLocaleString()}
                  </div>
                )}
                {isAggregateAcrossCompanies(grade) && (
                  <div className="op-graded-caveat">
                    Heads up: PriceCharting aggregates {gradingCompany} {grade} with all other grading companies at grade {grade}. Only grade 10 prices are company-specific.
                  </div>
                )}
                {variantsError && <div className="op-graded-error">{variantsError}</div>}
                {priceFetchError && <div className="op-graded-error">{priceFetchError}</div>}
              </>
            )}
          </div>

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
              label="PSA 10"
              value={(() => {
                const p = getCachedTierPrice(card.id, 'psa10');
                return p != null ? `$${p.toFixed(2)}` : '—';
              })()}
            />
            <PriceCell
              label="14d trend"
              value={historyLoading ? '…' : `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%`}
              tone={trend >= 0 ? 'pos' : 'neg'}
            />
          </div>

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
                          {isGraded && <GradingBadge company={entry.grading_company} grade={entry.grade} bgsBlack={entry.bgs_black} />}
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
