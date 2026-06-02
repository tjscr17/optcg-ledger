// Vercel serverless function: TCGCSV proxy + product search.
//
// TCGCSV serves daily TCGPlayer dumps as JSON/CSV at https://tcgcsv.com.
// Browser can hit it directly (no CORS issues observed), but we go through
// this proxy for three reasons:
//   1. server-side caching dodges the daily-snapshot 30MB-ish payload on
//      every page load
//   2. matches the architecture we'll need anyway once a nightly Supabase
//      sync replaces this
//   3. mirrors the existing /api/psa pattern
//
// Endpoints (dispatch by query param):
//   ?tcgId=N    → single product price snapshot
//   ?number=X   → list of TCGPlayer products whose extendedData.Number = X
//                 (used by the variant resolver to show candidates per OPTCG
//                 card identity, e.g. all printings sharing "OP11-118").
//
// Module-level cache (per function instance):
//   - productIndex: Map<productId, {groupId, name, cleanName, imageUrl,
//       number, rarity, subTypes}>. Built by crawling every group's
//       /products endpoint once. 24h TTL.
//   - productsByNumber: Map<displayId, productId[]>. Built alongside.
//   - groupPricesCache: per-group prices, 6h TTL. Fetched lazily.

const TCGCSV_BASE = 'https://tcgcsv.com/tcgplayer';
const OP_TCG_CATEGORY_ID = 68;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const PRICES_TTL_MS = 6 * 60 * 60 * 1000;
// TCGCSV requires a non-default User-Agent so the maintainer can identify
// callers — default Node UA gets a 401 with a polite "set your UA" message.
// See https://tcgcsv.com/docs#usage-guidelines.
const TCGCSV_USER_AGENT = 'optcg-ledger/1.0 (collection tracker, github.com/tjscr17/optcg-ledger)';

let productIndex = null;        // Map<productId, productInfo>
let productsByNumber = null;    // Map<displayId, productId[]>
let groupAbbrIndex = null;      // Map<groupId, abbreviation>
let groupNameIndex = null;      // Map<groupId, name>
let indexFetchedAt = 0;
let indexPromise = null;
const groupPricesCache = new Map();

const fetchJSON = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': TCGCSV_USER_AGENT } });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  const body = await r.json();
  if (body && body.success === false) {
    throw new Error(`TCGCSV reported failure for ${url}: ${JSON.stringify(body.errors || [])}`);
  }
  return body;
};

// Pull a named field out of TCGCSV's extendedData array (each entry is
// `{name, displayName, value}`). Returns "" when absent.
const extField = (extendedData, name) => {
  if (!Array.isArray(extendedData)) return '';
  const hit = extendedData.find(d => d.name === name);
  return hit?.value || '';
};

// Detect parallel / alt-art prints from product name suffixes. TCGPlayer
// names them with parenthetical markers that follow the card name.
const detectIsParallel = (name) => {
  if (!name) return false;
  const lower = name.toLowerCase();
  return /\(alternate art\)|\(parallel\)|\(alt[- ]art\)|\(special\)|\(sp\)/i.test(lower);
};

// Manga rares are a sub-distinction within alt printings. TCGPlayer labels
// them with `(Manga Rare)` or `(Manga)` in the product name.
const detectIsManga = (name) => {
  if (!name) return false;
  return /\(manga rare\)|\(manga\)/i.test(name);
};

const summarizeProduct = (p, groupId) => ({
  groupId,
  name: p.name || '',
  cleanName: p.cleanName || '',
  imageUrl: p.imageUrl || '',
  url: p.url || '',
  number: extField(p.extendedData, 'Number'),
  rarity: extField(p.extendedData, 'Rarity'),
  isParallel: detectIsParallel(p.name),
  isManga: detectIsManga(p.name),
});

const ensureIndex = async () => {
  const fresh = productIndex && (Date.now() - indexFetchedAt < INDEX_TTL_MS);
  if (fresh) return productIndex;
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    const groups = await fetchJSON(`${TCGCSV_BASE}/${OP_TCG_CATEGORY_ID}/groups`);
    const byId = new Map();
    const byNumber = new Map();
    const abbrIdx = new Map();
    const nameIdx = new Map();
    // Sequential — TCGCSV is one-person-run; parallel hammering is rude.
    for (const g of groups.results || []) {
      if (g.abbreviation) abbrIdx.set(g.groupId, g.abbreviation);
      if (g.name) nameIdx.set(g.groupId, g.name);
      try {
        const products = await fetchJSON(`${TCGCSV_BASE}/${OP_TCG_CATEGORY_ID}/${g.groupId}/products`);
        for (const p of products.results || []) {
          const info = summarizeProduct(p, g.groupId);
          byId.set(p.productId, info);
          if (info.number) {
            const upper = info.number.toUpperCase();
            const list = byNumber.get(upper) || [];
            list.push(p.productId);
            byNumber.set(upper, list);
          }
        }
      } catch (e) {
        console.warn(`[tcgcsv] failed to load products for group ${g.groupId}`, e);
      }
    }
    productIndex = byId;
    productsByNumber = byNumber;
    groupAbbrIndex = abbrIdx;
    groupNameIndex = nameIdx;
    indexFetchedAt = Date.now();
    return byId;
  })().finally(() => { indexPromise = null; });
  return indexPromise;
};

const getGroupPrices = async (groupId) => {
  const cached = groupPricesCache.get(groupId);
  if (cached && Date.now() - cached.fetchedAt < PRICES_TTL_MS) return cached.prices;
  const data = await fetchJSON(`${TCGCSV_BASE}/${OP_TCG_CATEGORY_ID}/${groupId}/prices`);
  const prices = data.results || [];
  groupPricesCache.set(groupId, { prices, fetchedAt: Date.now() });
  return prices;
};

const pickPriceRecord = (records, productId) => {
  const forProduct = records.filter(r => r.productId === productId);
  if (forProduct.length === 0) return null;
  const normal = forProduct.find(r => r.subTypeName === 'Normal');
  return normal || forProduct.find(r => r.marketPrice != null) || forProduct[0];
};

const priceSnapshotFor = async (tcgId) => {
  const info = productIndex.get(tcgId);
  if (!info) return null;
  const prices = await getGroupPrices(info.groupId);
  const record = pickPriceRecord(prices, tcgId);
  return record;
};

// Build the per-product summary returned to clients (search response).
// Includes the most recent cached price snapshot for quick UI display.
const productPayload = async (tcgId, info) => {
  const record = await priceSnapshotFor(tcgId);
  return {
    tcg_id: tcgId,
    group_id: info.groupId,
    group_abbreviation: groupAbbrIndex?.get(info.groupId) || '',
    group_name: groupNameIndex?.get(info.groupId) || '',
    name: info.name,
    clean_name: info.cleanName,
    image_url: info.imageUrl,
    tcgplayer_url: info.url,
    number: info.number,
    rarity: info.rarity,
    is_parallel: info.isParallel,
    is_manga: info.isManga,
    market_price: record?.marketPrice ?? null,
    low_price: record?.lowPrice ?? null,
    mid_price: record?.midPrice ?? null,
    high_price: record?.highPrice ?? null,
    sub_type_name: record?.subTypeName ?? null,
  };
};

export default async function handler(req, res) {
  const tcgIdRaw = req.query?.tcgId;
  const numberRaw = req.query?.number;
  const groupAbbrRaw = req.query?.groupAbbr;
  const allRaw = req.query?.all;
  const groupsRaw = req.query?.groups;

  // Dispatch on the params present.
  if (tcgIdRaw) {
    const tcgId = Number(tcgIdRaw);
    if (!Number.isFinite(tcgId) || tcgId <= 0) {
      res.status(400).json({ error: 'tcgId must be a positive integer' });
      return;
    }
    try {
      await ensureIndex();
      const info = productIndex.get(tcgId);
      if (!info) {
        // 200 with `not_found: true` keeps the browser console quiet — the
        // client treats this identically to a 404 (negative-cache for 6h),
        // but a 404 here usually means a stale resolution from the old
        // PriceCharting bridge (TCGPlayer retired/merged the product). It's
        // not really an error from the proxy's perspective.
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json({
          tcg_id: tcgId,
          not_found: true,
          reason: `productId ${tcgId} is not in the One Piece TCG catalog (may be a stale resolution — re-resolve via the Resolve view)`,
          fetched_at: new Date().toISOString(),
        });
        return;
      }
      const record = await priceSnapshotFor(tcgId);
      if (!record) {
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json({
          tcg_id: tcgId,
          group_id: info.groupId,
          not_found: true,
          reason: `no price record for productId ${tcgId} (product exists but TCGCSV has no recent prices)`,
          fetched_at: new Date().toISOString(),
        });
        return;
      }
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
      res.status(200).json({
        tcg_id: tcgId,
        group_id: info.groupId,
        market_price: record.marketPrice,
        low_price: record.lowPrice,
        mid_price: record.midPrice,
        high_price: record.highPrice,
        direct_low_price: record.directLowPrice,
        sub_type_name: record.subTypeName,
        fetched_at: new Date().toISOString(),
      });
    } catch (e) {
      res.status(502).json({ error: `TCGCSV upstream failure: ${e.message || e}` });
    }
    return;
  }

  if (numberRaw) {
    const number = String(numberRaw).trim().toUpperCase();
    if (!number) {
      res.status(400).json({ error: 'number must be non-empty' });
      return;
    }
    try {
      await ensureIndex();
      const ids = productsByNumber.get(number) || [];
      const products = await Promise.all(ids.map(async (id) => {
        const info = productIndex.get(id);
        if (!info) return null;
        return productPayload(id, info);
      }));
      const filtered = products.filter(Boolean);
      // Non-parallel first, then parallel (UX preference; the matcher tends
      // to want "base print" at the top of the candidate list).
      filtered.sort((a, b) => (a.is_parallel ? 1 : 0) - (b.is_parallel ? 1 : 0));
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
      res.status(200).json({
        number,
        products: filtered,
        fetched_at: new Date().toISOString(),
      });
    } catch (e) {
      res.status(502).json({ error: `TCGCSV upstream failure: ${e.message || e}` });
    }
    return;
  }

  if (groupAbbrRaw) {
    // Returns every product belonging to a TCGPlayer group, identified by its
    // abbreviation (case-insensitive, spaces tolerated — "OP14 RE", "OP14RE",
    // "op14 re" all match). Used by the "Import from TCGPlayer" feature to
    // pull entire release-event / tournament sets that OPTCGAPI doesn't ship.
    const wanted = String(groupAbbrRaw).trim().toUpperCase().replace(/\s+/g, '');
    if (!wanted) {
      res.status(400).json({ error: 'groupAbbr must be non-empty' });
      return;
    }
    try {
      await ensureIndex();
      let matchedGroupId = null;
      let matchedAbbr = '';
      let matchedName = '';
      for (const [gid, abbr] of groupAbbrIndex.entries()) {
        if ((abbr || '').toUpperCase().replace(/\s+/g, '') === wanted) {
          matchedGroupId = gid;
          matchedAbbr = abbr;
          matchedName = groupNameIndex.get(gid) || '';
          break;
        }
      }
      if (!matchedGroupId) {
        res.status(404).json({ error: `no TCGPlayer group with abbreviation "${groupAbbrRaw}"` });
        return;
      }
      const productIds = [];
      for (const [pid, info] of productIndex.entries()) {
        if (info.groupId === matchedGroupId) productIds.push(pid);
      }
      const products = await Promise.all(productIds.map(async (id) => {
        const info = productIndex.get(id);
        if (!info) return null;
        return productPayload(id, info);
      }));
      const filtered = products.filter(Boolean);
      filtered.sort((a, b) => (a.number || '').localeCompare(b.number || ''));
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
      res.status(200).json({
        group_id: matchedGroupId,
        group_abbreviation: matchedAbbr,
        group_name: matchedName,
        products: filtered,
        fetched_at: new Date().toISOString(),
      });
    } catch (e) {
      res.status(502).json({ error: `TCGCSV upstream failure: ${e.message || e}` });
    }
    return;
  }

  if (groupsRaw) {
    try {
      await ensureIndex();
      const groups = [];
      for (const [gid, abbr] of groupAbbrIndex.entries()) {
        groups.push({
          group_id: gid,
          abbreviation: abbr,
          name: groupNameIndex.get(gid) || '',
        });
      }
      groups.sort((a, b) => (a.abbreviation || '').localeCompare(b.abbreviation || ''));
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
      res.status(200).json({ groups, fetched_at: new Date().toISOString() });
    } catch (e) {
      res.status(502).json({ error: `TCGCSV upstream failure: ${e.message || e}` });
    }
    return;
  }

  if (allRaw) {
    // Whole-catalog dump used by the TCGPlayer-as-source catalog loader.
    // Returns every TCGPlayer product as a lean record with price snapshot.
    // ~3000–5000 products = ~1–2 MB JSON; well under serverless limits.
    try {
      await ensureIndex();
      const ids = [...productIndex.keys()];
      const products = await Promise.all(ids.map(async (id) => {
        const info = productIndex.get(id);
        if (!info) return null;
        return productPayload(id, info);
      }));
      const filtered = products.filter(Boolean);
      filtered.sort((a, b) => {
        const ga = a.group_abbreviation || '', gb = b.group_abbreviation || '';
        if (ga !== gb) return ga.localeCompare(gb);
        return (a.number || '').localeCompare(b.number || '');
      });
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
      res.status(200).json({
        count: filtered.length,
        products: filtered,
        fetched_at: new Date().toISOString(),
      });
    } catch (e) {
      res.status(502).json({ error: `TCGCSV upstream failure: ${e.message || e}` });
    }
    return;
  }

  res.status(400).json({ error: 'one of ?tcgId=N, ?number=X, ?groupAbbr=X, ?all=1, or ?groups=1 is required' });
}
