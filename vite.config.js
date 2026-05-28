import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Pull env into the dev middleware (Vite doesn't expose import.meta.env there).
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      react(),
      // Local-dev mirror of the Vercel /api/psa serverless function so PSA
      // lookups work the same in `npm run dev` as in production.
      {
        name: 'psa-dev-proxy',
        configureServer(server) {
          server.middlewares.use('/api/psa', async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const cert = (url.searchParams.get('cert') || '').trim();
            res.setHeader('Content-Type', 'application/json');
            if (!cert) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'cert query param is required' }));
              return;
            }
            const token = env.VITE_PSA_TOKEN || env.PSA_TOKEN;
            if (!token) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'PSA token not configured' }));
              return;
            }
            try {
              const upstream = `https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`;
              const r = await fetch(upstream, { headers: { Authorization: `Bearer ${token}` } });
              const text = await r.text();
              res.statusCode = r.status;
              res.end(text || 'null');
            } catch (e) {
              res.statusCode = 502;
              res.end(JSON.stringify({ error: `PSA upstream fetch failed: ${e.message || e}` }));
            }
          });
        },
      },
      // Local-dev mirror of /api/optcg-history. OPTCGAPI's twoweeks endpoint
      // returns 500 without CORS headers for cards it has no history for —
      // proxying through here means the browser only sees our 200 + empty
      // points array.
      {
        name: 'optcg-history-dev-proxy',
        configureServer(server) {
          const API = 'https://optcgapi.com/api';
          const normalizePoints = (data) => {
            if (!Array.isArray(data)) return [];
            return data
              .map(d => ({
                date: d.date_scraped || d.date || d.scrape_date,
                price: Number(d.market_price ?? d.inventory_price) || 0,
              }))
              .filter(p => p.date && p.price > 0)
              .sort((a, b) => a.date.localeCompare(b.date));
          };
          const fetchJSON = async (url) => {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`${url} returned ${r.status}`);
            return r.json();
          };
          server.middlewares.use('/api/optcg-history', async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            res.setHeader('Content-Type', 'application/json');
            const id = (url.searchParams.get('id') || '').trim();
            if (!id) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'id query param required' }));
              return;
            }
            let queryId = id.split('__')[0].replace(/_p\d+$/i, '');
            const canonical = queryId.match(/^[A-Z]+\d+-\d+/i);
            queryId = canonical ? canonical[0] : queryId;

            for (const path of [
              `${API}/sets/card/twoweeks/${queryId}/`,
              `${API}/decks/card/twoweeks/${queryId}/`,
              `${API}/promos/card/twoweeks/${queryId}/`,
            ]) {
              try {
                const data = await fetchJSON(path);
                if (Array.isArray(data) && data.length > 0) {
                  res.statusCode = 200;
                  res.end(JSON.stringify({ id: queryId, points: normalizePoints(data) }));
                  return;
                }
              } catch {}
            }
            res.statusCode = 200;
            res.end(JSON.stringify({ id: queryId, points: [] }));
          });
        },
      },
      // Local-dev mirror of /api/tcgcsv. Same caching semantics as the
      // Vercel function — module-level Maps live for the dev server's
      // lifetime, which is usually more forgiving than serverless cold
      // starts so the index gets reused across requests freely.
      {
        name: 'tcgcsv-dev-proxy',
        configureServer(server) {
          const TCGCSV_BASE = 'https://tcgcsv.com/tcgplayer';
          const CATEGORY_ID = 68;
          const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
          const PRICES_TTL_MS = 6 * 60 * 60 * 1000;
          // TCGCSV requires apps to identify themselves via User-Agent; the
          // default Node UA gets a 401. Keep this string in sync with
          // api/tcgcsv.js.
          const TCGCSV_USER_AGENT = 'optcg-ledger/1.0 (collection tracker, github.com/tjscr17/optcg-ledger)';
          let productIndex = null;
          let productsByNumber = null;
          let groupAbbrIndex = null;
          let groupNameIndex = null;
          let indexFetchedAt = 0;
          let indexPromise = null;
          const groupPricesCache = new Map();

          const fetchJSON = async (url) => {
            const r = await fetch(url, { headers: { 'User-Agent': TCGCSV_USER_AGENT } });
            if (!r.ok) throw new Error(`${url} returned ${r.status}`);
            const body = await r.json();
            if (body && body.success === false) {
              throw new Error(`TCGCSV reported failure: ${JSON.stringify(body.errors || [])}`);
            }
            return body;
          };

          const extField = (extendedData, name) => {
            if (!Array.isArray(extendedData)) return '';
            const hit = extendedData.find(d => d.name === name);
            return hit?.value || '';
          };
          const detectIsParallel = (name) => {
            if (!name) return false;
            return /\(alternate art\)|\(parallel\)|\(alt[- ]art\)|\(special\)|\(sp\)/i.test(name);
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
          });

          const ensureIndex = async () => {
            const fresh = productIndex && (Date.now() - indexFetchedAt < INDEX_TTL_MS);
            if (fresh) return productIndex;
            if (indexPromise) return indexPromise;
            indexPromise = (async () => {
              const groups = await fetchJSON(`${TCGCSV_BASE}/${CATEGORY_ID}/groups`);
              const byId = new Map();
              const byNumber = new Map();
              const abbrIdx = new Map();
              const nameIdx = new Map();
              for (const g of groups.results || []) {
                if (g.abbreviation) abbrIdx.set(g.groupId, g.abbreviation);
                if (g.name) nameIdx.set(g.groupId, g.name);
                try {
                  const products = await fetchJSON(`${TCGCSV_BASE}/${CATEGORY_ID}/${g.groupId}/products`);
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
                  // eslint-disable-next-line no-console
                  console.warn(`[tcgcsv-dev] group ${g.groupId} products failed`, e);
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
            const data = await fetchJSON(`${TCGCSV_BASE}/${CATEGORY_ID}/${groupId}/prices`);
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
            return pickPriceRecord(prices, tcgId);
          };

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
              market_price: record?.marketPrice ?? null,
              low_price: record?.lowPrice ?? null,
              mid_price: record?.midPrice ?? null,
              high_price: record?.highPrice ?? null,
              sub_type_name: record?.subTypeName ?? null,
            };
          };

          server.middlewares.use('/api/tcgcsv', async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            res.setHeader('Content-Type', 'application/json');
            const tcgIdRaw = url.searchParams.get('tcgId');
            const numberRaw = url.searchParams.get('number');

            if (tcgIdRaw) {
              const tcgId = Number(tcgIdRaw);
              if (!Number.isFinite(tcgId) || tcgId <= 0) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'tcgId must be a positive integer' }));
                return;
              }
              try {
                await ensureIndex();
                const info = productIndex.get(tcgId);
                if (!info) {
                  res.statusCode = 200;
                  res.end(JSON.stringify({
                    tcg_id: tcgId,
                    not_found: true,
                    reason: `productId ${tcgId} is not in the One Piece TCG catalog (likely a stale resolution)`,
                    fetched_at: new Date().toISOString(),
                  }));
                  return;
                }
                const record = await priceSnapshotFor(tcgId);
                if (!record) {
                  res.statusCode = 200;
                  res.end(JSON.stringify({
                    tcg_id: tcgId,
                    group_id: info.groupId,
                    not_found: true,
                    reason: `no price record for productId ${tcgId}`,
                    fetched_at: new Date().toISOString(),
                  }));
                  return;
                }
                res.statusCode = 200;
                res.end(JSON.stringify({
                  tcg_id: tcgId,
                  group_id: info.groupId,
                  market_price: record.marketPrice,
                  low_price: record.lowPrice,
                  mid_price: record.midPrice,
                  high_price: record.highPrice,
                  direct_low_price: record.directLowPrice,
                  sub_type_name: record.subTypeName,
                  fetched_at: new Date().toISOString(),
                }));
              } catch (e) {
                res.statusCode = 502;
                res.end(JSON.stringify({ error: `TCGCSV upstream failure: ${e.message || e}` }));
              }
              return;
            }

            if (numberRaw) {
              const number = String(numberRaw).trim().toUpperCase();
              if (!number) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'number must be non-empty' }));
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
                filtered.sort((a, b) => (a.is_parallel ? 1 : 0) - (b.is_parallel ? 1 : 0));
                res.statusCode = 200;
                res.end(JSON.stringify({
                  number,
                  products: filtered,
                  fetched_at: new Date().toISOString(),
                }));
              } catch (e) {
                res.statusCode = 502;
                res.end(JSON.stringify({ error: `TCGCSV upstream failure: ${e.message || e}` }));
              }
              return;
            }

            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'one of ?tcgId=N or ?number=X is required' }));
          });
        },
      },
    ],
    build: { outDir: 'dist' },
  };
});
