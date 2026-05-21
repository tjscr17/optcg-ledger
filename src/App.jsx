import React, { useState, useEffect, useMemo, useRef, useCallback, useReducer } from 'react';
import { Search, Plus, X, TrendingUp, TrendingDown, Folder, Trash2, DollarSign, Anchor, ChevronRight, Package, BarChart3, RefreshCw, Cloud, HardDrive, ImageOff, Award, Loader2 } from 'lucide-react';
import { store, MODE, VAULT_LABEL } from './storage.js';
import { loadCatalog, loadPriceHistory, groupBySet, compareSets } from './catalog.js';
import {
  GRADING_COMPANIES, GRADES_BY_COMPANY,
  fetchGradedPrice, isAggregateAcrossCompanies, hasToken,
  searchVariants, getSavedPick, savePick, priceFromProduct,
  getCachedImage, resolveEnhancedImage,
  PRICE_TIERS, getCachedTierPrice, isVariantSnapshotFresh, resolveVariantSnapshot,
  onVariantResolved, hydrateFromShared, subscribeResolutions,
} from './grading.js';

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
  const needsVariant = Boolean(opts.needsVariant);
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
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState('collection');
  const [activeCollectionId, setActiveCollectionId] = useState(null);
  const [detailCard, setDetailCard] = useState(null);
  const [addingCard, setAddingCard] = useState(null);

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
    const [cols, ents] = await Promise.all([store.list('collections'), store.list('entries')]);
    let cs = cols;
    if (cs.length === 0) {
      const seed = await store.insert('collections', { id: uid(), name: 'Main Collection', created_at: new Date().toISOString() });
      cs = [seed].filter(Boolean);
    }
    setCollections(cs);
    setEntries(ents);
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
    return () => { unsubC(); unsubE(); };
  }, [refreshData]);

  // Quick catalog lookup
  const catalogIndex = useMemo(() => {
    const m = new Map();
    for (const c of catalog) m.set(c.id, c);
    return m;
  }, [catalog]);

  const addCollection = async (name) => {
    const created = await store.insert('collections', { id: uid(), name, created_at: new Date().toISOString() });
    if (created) setCollections([...collections, created]);
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

  const addEntry = async (entry) => {
    const created = await store.insert('entries', {
      ...entry,
      id: uid(),
      added_at: new Date().toISOString(),
    });
    if (created) setEntries([...entries, created]);
  };

  const updateEntry = async (id, patch) => {
    const updated = await store.update('entries', id, patch);
    if (updated) setEntries(entries.map(e => e.id === id ? updated : e));
  };

  const removeEntry = async (id) => {
    await store.remove('entries', id);
    setEntries(entries.filter(e => e.id !== id));
  };

  const activeCollection = collections.find(c => c.id === activeCollectionId);
  const activeEntries = entries.filter(e => e.collection_id === activeCollectionId);

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
        addCollection={addCollection} deleteCollection={deleteCollection}
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
            onSearchClick={() => setView('search')}
            onCardClick={(card) => setDetailCard(card)}
            onRemoveEntry={removeEntry}
            onEditEntry={updateEntry}
          />
        )}
        {view === 'search' && (
          <SearchView
            catalog={catalog}
            onAddCard={setAddingCard}
            onCardClick={setDetailCard}
          />
        )}
        {view === 'resolve' && (
          <ResolveView
            catalog={catalog}
            entries={entries}
            onAddCard={setAddingCard}
            onCardClick={setDetailCard}
          />
        )}
      </main>

      {addingCard && (
        <AddCardModal
          card={addingCard}
          collections={collections}
          activeCollectionId={activeCollectionId}
          onClose={() => setAddingCard(null)}
          onSave={async (entry) => { await addEntry(entry); setAddingCard(null); }}
        />
      )}

      {detailCard && (
        <CardDetailDrawer
          card={detailCard}
          entries={entries.filter(e => e.card_id === detailCard.id)}
          collections={collections}
          onClose={() => setDetailCard(null)}
          onAddToCollection={() => { setAddingCard(detailCard); setDetailCard(null); }}
          onRemoveEntry={removeEntry}
        />
      )}

      <ModeIndicator />
    </div>
  );
}

// ============================================================================
function Header({ view, setView, collections, activeCollectionId, setActiveCollectionId, addCollection, deleteCollection }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [newColName, setNewColName] = useState('');
  const menuRef = useRef(null);

  useEffect(() => {
    const onClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const active = collections.find(c => c.id === activeCollectionId);

  return (
    <header className="op-header">
      <div className="op-brand">
        <div className="op-brand-mark"><Anchor size={22} strokeWidth={2.5} /></div>
        <div>
          <div className="op-brand-name">THE LEDGER (LOCAL)</div>
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
            {collections.map(c => (
              <div key={c.id} className={`op-collection-item ${c.id === activeCollectionId ? 'is-active' : ''}`}>
                <button className="op-collection-item-btn" onClick={() => { setActiveCollectionId(c.id); setMenuOpen(false); }}>
                  {c.name}
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
function CollectionView({ collection, entries, catalogIndex, onSearchClick, onCardClick, onRemoveEntry, onEditEntry }) {
  const stats = useMemo(() => {
    let totalPaid = 0, totalMarket = 0, gradedCount = 0;
    for (const e of entries) {
      totalPaid += Number(e.purchase_price) || 0;
      if (e.grading_company && Number(e.graded_price) > 0) {
        totalMarket += Number(e.graded_price);
        gradedCount += 1;
      } else {
        const card = catalogIndex.get(e.card_id);
        if (card) totalMarket += card.marketPrice || 0;
      }
    }
    return { totalPaid, totalMarket, count: entries.length, gradedCount };
  }, [entries, catalogIndex]);

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
          <div className="op-entries">
            {entries.map(entry => {
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
                : (card.marketPrice || 0);
              const delta = marketValue - (Number(entry.purchase_price) || 0);
              return (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  card={card}
                  marketValue={marketValue}
                  delta={delta}
                  onClick={() => onCardClick(card)}
                  onRemove={() => onRemoveEntry(entry.id)}
                />
              );
            })}
          </div>

          <EquityPanel entries={entries} catalogIndex={catalogIndex} totalMarket={stats.totalMarket} />
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
function EquityPanel({ entries, catalogIndex, totalMarket }) {
  const [mode, setMode] = useState('capital');

  const equity = useMemo(() => {
    const expandContribs = (entry) => {
      if (entry.contributions && entry.contributions.length > 0) return entry.contributions;
      const amount = Number(entry.purchase_price) || 0;
      if (amount <= 0) return [];
      return [{ name: 'Unattributed', amount }];
    };

    if (mode === 'capital') {
      const totals = new Map();
      let totalPaid = 0;
      for (const entry of entries) {
        for (const c of expandContribs(entry)) {
          const amt = Number(c.amount) || 0;
          if (!c.name || amt <= 0) continue;
          totals.set(c.name, (totals.get(c.name) || 0) + amt);
          totalPaid += amt;
        }
      }
      return {
        rows: Array.from(totals.entries()).map(([name, paid]) => ({
          name,
          paid,
          units: null,
          pct: totalPaid > 0 ? paid / totalPaid : 0,
          value: totalPaid > 0 ? totalMarket * (paid / totalPaid) : 0,
        })).sort((a, b) => b.paid - a.paid),
        totalPaid,
        totalUnits: null,
      };
    }

    // Time-weighted: walk entries in date order, issue units against NAV.
    // Prefer the user-supplied acquired_at; fall back to the row's added_at.
    const dateOf = (e) => e.acquired_at || (e.added_at || '').slice(0, 10);
    const sorted = [...entries].sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    const units = new Map();
    const paidMap = new Map();
    let totalUnits = 0;
    let nav = 0;
    for (const entry of sorted) {
      const unitPrice = totalUnits > 0 && nav > 0 ? nav / totalUnits : 1;
      const card = catalogIndex.get(entry.card_id);
      const cardMarketAtCurrent = card?.marketPrice || 0;
      let entryCash = 0;
      for (const c of expandContribs(entry)) {
        const amt = Number(c.amount) || 0;
        if (!c.name || amt <= 0) continue;
        const issued = amt / unitPrice;
        units.set(c.name, (units.get(c.name) || 0) + issued);
        paidMap.set(c.name, (paidMap.get(c.name) || 0) + amt);
        totalUnits += issued;
        entryCash += amt;
      }
      // NAV advances by the cash put in (we approximate by replacing the cash
      // with the card's current market value — if we got a deal, this gives
      // existing unitholders some immediate upside).
      nav += entryCash;
      nav += Math.max(0, cardMarketAtCurrent - entryCash);
    }
    return {
      rows: Array.from(units.entries()).map(([name, u]) => ({
        name,
        paid: paidMap.get(name) || 0,
        units: u,
        pct: totalUnits > 0 ? u / totalUnits : 0,
        value: totalUnits > 0 ? totalMarket * (u / totalUnits) : 0,
      })).sort((a, b) => b.units - a.units),
      totalPaid: Array.from(paidMap.values()).reduce((s, v) => s + v, 0),
      totalUnits,
    };
  }, [entries, catalogIndex, totalMarket, mode]);

  if (equity.rows.length === 0) return null;

  return (
    <div className="op-equity">
      <div className="op-equity-head">
        <div>
          <div className="op-eyebrow">Equity</div>
          <h2 className="op-equity-title">Capital &amp; ownership</h2>
          <div className="op-equity-sub">
            {mode === 'capital'
              ? 'Equity allocated by capital contributed. Ignores market and timing.'
              : 'Equity allocated by fund-accounting units. Earlier contributions to an appreciating collection get a bigger slice.'}
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
          <div className="op-equity-num">Contributed</div>
          {mode === 'time-weighted' && <div className="op-equity-num">Units</div>}
          <div className="op-equity-num">Equity %</div>
          <div className="op-equity-num">Stake value</div>
          <div className="op-equity-num">Gain</div>
        </div>
        {equity.rows.map(r => {
          const gain = r.value - r.paid;
          return (
            <div key={r.name} className="op-equity-row">
              <div className="op-equity-name">{r.name}</div>
              <div className="op-equity-num">${r.paid.toFixed(2)}</div>
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

function Stat({ label, value, sub, tone, accent }) {
  return (
    <div className={`op-stat ${accent ? 'is-accent' : ''} ${tone ? `is-${tone}` : ''}`}>
      <div className="op-stat-label">{label}</div>
      <div className="op-stat-value">{value}</div>
      {sub && <div className="op-stat-sub">{sub}</div>}
    </div>
  );
}

function EntryRow({ entry, card, marketValue, delta, onClick, onRemove }) {
  const isGraded = Boolean(entry.grading_company);
  return (
    <div className="op-entry">
      <button className="op-entry-main" onClick={onClick}>
        <CardThumb card={card} size={48} />
        <div className="op-entry-info">
          <div className="op-entry-cardname">
            {card.name}
            <VariantPill variant={card.variant} />
            {isGraded && <GradingBadge company={entry.grading_company} grade={entry.grade} />}
          </div>
          <div className="op-entry-cardset">
            <span className="op-entry-id">{card.displayId || card.id}</span> · {card.setName} · {RARITY_LABELS[card.rarity] || card.rarity}
          </div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">{isGraded ? 'Grade' : 'Condition'}</div>
          <div className="op-entry-cell-val">{isGraded ? `${entry.grading_company} ${entry.grade}` : (entry.condition || '—')}</div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">Paid</div>
          <div className="op-entry-cell-val">${Number(entry.purchase_price || 0).toFixed(2)}</div>
        </div>
        <div className="op-entry-cell">
          <div className="op-entry-cell-label">{isGraded ? 'Graded' : 'Market'}</div>
          <div className="op-entry-cell-val">${(marketValue || 0).toFixed(2)}</div>
        </div>
        <div className={`op-entry-delta ${delta >= 0 ? 'is-pos' : 'is-neg'}`}>
          {delta >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {delta >= 0 ? '+' : ''}${delta.toFixed(2)}
        </div>
      </button>
      <button className="op-entry-remove" onClick={onRemove} title="Remove from collection">
        <X size={15} />
      </button>
    </div>
  );
}

function GradingBadge({ company, grade }) {
  return (
    <span className={`op-grade-badge is-${(company || '').toLowerCase()}`} title={`${company} ${grade}`}>
      <Award size={11} />
      {company} {grade}
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
function SearchView({ catalog, onAddCard, onCardClick }) {
  const [q, setQ] = useState('');
  const [setFilter, setSetFilter] = useState('all');
  const [filterDim, setFilterDim] = useState('none'); // 'none' | 'rarity' | 'color'
  const [filterValue, setFilterValue] = useState('all');
  const [sortBy, setSortBy] = useState('set'); // 'set' | 'name' | 'price-desc' | 'price-asc'
  const [priceTier, setPriceTier] = useState('raw');

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
  }, [catalog, q, setFilter, filterDim, filterValue]);

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
    else if (sortBy === 'price-desc') arr.sort((a, b) => (b.marketPrice || 0) - (a.marketPrice || 0));
    else if (sortBy === 'price-asc') arr.sort((a, b) => (a.marketPrice || 0) - (b.marketPrice || 0));
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
      </div>

      <div className="op-results-count">
        {sorted.length.toLocaleString()} {sorted.length === 1 ? 'result' : 'results'}
        {(q || setFilter !== 'all' || (filterDim !== 'none' && filterValue !== 'all')) && (
          <button className="op-clear-filters" onClick={() => {
            setQ(''); setSetFilter('all'); setFilterDim('none'); setFilterValue('all');
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
              priceTier={priceTier}
            />
          ))}
        </div>
      ) : (
        <div className="op-card-grid">
          {sorted.map(card => (
            <CardTile key={card.id} card={card} onAddCard={onAddCard} onCardClick={onCardClick} priceTier={priceTier} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
function ResolveView({ catalog, entries, onAddCard, onCardClick }) {
  const [filterMode, setFilterMode] = useState('unresolved'); // 'unresolved' | 'in-collection' | 'all'
  const [index, setIndex] = useState(0);

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
      </div>

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
                {RARITY_LABELS[currentCard.rarity] || currentCard.rarity} · OPTCGAPI raw: ${(currentCard.marketPrice || 0).toFixed(2)}
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

function SetGroup({ group, onAddCard, onCardClick, priceTier }) {
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
            <CardTile key={card.id} card={card} onAddCard={onAddCard} onCardClick={onCardClick} priceTier={priceTier} />
          ))}
        </div>
      )}
    </div>
  );
}

function CardTile({ card, onAddCard, onCardClick, priceTier = 'raw' }) {
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
            <span className="op-card-tile-price-val">${(card.marketPrice || 0).toFixed(2)}</span>
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
      <button className="op-card-tile-add" onClick={() => onAddCard(card)}>
        <Plus size={14} /> Add to Collection
      </button>
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
function AddCardModal({ card, collections, activeCollectionId, onClose, onSave }) {
  const [collectionId, setCollectionId] = useState(activeCollectionId);
  const [condition, setCondition] = useState('Near Mint');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [contributions, setContributions] = useState([]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const [acquiredAt, setAcquiredAt] = useState(new Date().toISOString().slice(0, 10));

  const [isGraded, setIsGraded] = useState(false);
  const [gradingCompany, setGradingCompany] = useState('PSA');
  const [grade, setGrade] = useState(10);
  const [certNumber, setCertNumber] = useState('');
  const [gradedPrice, setGradedPrice] = useState('');
  const [pcProductId, setPcProductId] = useState('');
  const [pcProductName, setPcProductName] = useState('');
  const [priceFetchedAt, setPriceFetchedAt] = useState('');
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

  // Refetch price whenever the chosen variant or grade changes
  useEffect(() => {
    if (!isGraded || !pcProductId) return;
    refreshGradedPrice();
  }, [isGraded, pcProductId, gradingCompany, grade, refreshGradedPrice]);

  const selectedVariant = variants.find(v => String(v.id) === pcProductId);

  const handleSave = async () => {
    setSaving(true);
    if (isGraded && selectedVariant) savePick(card.id, selectedVariant);
    const entry = {
      card_id: card.id,
      collection_id: collectionId,
      condition,
      purchase_price: priceNum,
      contributions: contributions.filter(c => c.name.trim() && Number(c.amount) > 0).map(c => ({ name: c.name.trim(), amount: Number(c.amount) })),
      notes: notes.trim(),
      acquired_at: acquiredAt || null,
      grading_company: isGraded ? gradingCompany : null,
      grade: isGraded ? Number(grade) : null,
      cert_number: isGraded ? certNumber.trim() : '',
      graded_price: isGraded ? (Number(gradedPrice) || 0) : 0,
      pc_product_id: isGraded ? pcProductId : '',
      pc_product_name: isGraded ? pcProductName : '',
      price_source: isGraded && pcProductId ? 'pricecharting' : '',
      price_fetched_at: isGraded ? priceFetchedAt : '',
    };
    await onSave(entry);
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
            <div className="op-eyebrow">Logging acquisition</div>
            <div className="op-modal-title">
              {card.name}
              <VariantPill variant={card.variant} />
            </div>
            <div className="op-modal-sub">{card.displayId || card.id} · {card.setName} · {RARITY_LABELS[card.rarity] || card.rarity}</div>
            <div className="op-modal-market">
              Market: <strong>${(card.marketPrice || 0).toFixed(2)}</strong>
              {card.inventoryPrice > 0 && <> · Inventory: <strong>${card.inventoryPrice.toFixed(2)}</strong></>}
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
              <div key={i} className="op-contrib-row">
                <input
                  type="text" placeholder="Name"
                  value={c.name} onChange={(e) => updateContrib(i, { name: e.target.value })}
                />
                <div className="op-contrib-amount">
                  <DollarSign size={13} />
                  <input
                    type="number" step="0.01" placeholder="0.00"
                    value={c.amount} onChange={(e) => updateContrib(i, { amount: e.target.value })}
                  />
                </div>
                <button className="op-contrib-remove" onClick={() => removeContrib(i)}><X size={14} /></button>
              </div>
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
              {saving ? 'Saving…' : 'Save to Collection'}
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
function CardDetailDrawer({ card, entries, collections, onClose, onAddToCollection, onRemoveEntry }) {
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
            <PriceCell label="Market" value={`$${(card.marketPrice || 0).toFixed(2)}`} accent />
            <PriceCell label="Inventory" value={`$${(card.inventoryPrice || 0).toFixed(2)}`} />
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
                          {isGraded && <GradingBadge company={entry.grading_company} grade={entry.grade} />}
                        </div>
                        <div className="op-detail-entry-meta">
                          {isGraded ? `${entry.grading_company} ${entry.grade}` : entry.condition} · Paid ${Number(entry.purchase_price || 0).toFixed(2)}
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
