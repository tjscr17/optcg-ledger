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
      // Local-dev mirror of /api/psa-apr — PSA Auction Prices Realized lookup.
      // The Vercel function memoizes responses for 24h; this dev mirror
      // doesn't (you'd notice quickly in `npm run dev` and the prod cache
      // is the important one).
      {
        name: 'psa-apr-dev-proxy',
        configureServer(server) {
          const parseGradeFromString = (s) => {
            if (s == null) return null;
            const m = String(s).match(/(\d+(?:\.\d+)?)/);
            if (!m) return null;
            const n = parseFloat(m[1]);
            return Number.isFinite(n) ? n : null;
          };
          const priceOf = (s) =>
            Number(s?.SalePrice ?? s?.Price ?? s?.EndPrice ?? s?.PriceRealized ?? 0) || 0;
          const dateOf = (s) =>
            s?.SaleDate || s?.EndDate || s?.Date || s?.SaleDateTime || '';
          const median = (nums) => {
            if (!nums.length) return null;
            const sorted = [...nums].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
          };

          server.middlewares.use('/api/psa-apr', async (req, res) => {
            const url = new URL(req.url, 'http://localhost');
            res.setHeader('Content-Type', 'application/json');
            const spec = (url.searchParams.get('spec') || '').trim();
            if (!spec) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'spec query param is required' }));
              return;
            }
            const gradeRaw = url.searchParams.get('grade');
            const gradeWanted = gradeRaw != null && gradeRaw !== ''
              ? parseGradeFromString(gradeRaw) : null;
            const days = Math.max(1, Math.min(3650, Number(url.searchParams.get('days')) || 365));

            const token = env.VITE_PSA_TOKEN || env.PSA_TOKEN;
            if (!token) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'PSA token not configured' }));
              return;
            }
            const upstreamUrl = `https://api.psacard.com/publicapi/auctionprices/${encodeURIComponent(spec)}`;
            try {
              const r = await fetch(upstreamUrl, { headers: { Authorization: `Bearer ${token}` } });
              const bodyText = await r.text();
              const sample = bodyText.slice(0, 500);
              if (!r.ok) {
                res.statusCode = 200;
                res.end(JSON.stringify({
                  spec_id: spec, grade: gradeWanted, window_days: days,
                  suggested_price: null, sample_count: 0, sales: [],
                  upstream_total: 0, in_window_total: 0, grade_breakdown: {},
                  upstream_status: r.status, upstream_url: upstreamUrl, upstream_body_sample: sample,
                  fetched_at: new Date().toISOString(), source: 'psa-apr',
                  reason: `PSA APR upstream returned ${r.status} for ${upstreamUrl}`,
                }));
                return;
              }
              let upstreamJson;
              try { upstreamJson = JSON.parse(bodyText); }
              catch {
                res.statusCode = 200;
                res.end(JSON.stringify({
                  spec_id: spec, grade: gradeWanted, window_days: days,
                  suggested_price: null, sample_count: 0, sales: [],
                  upstream_total: 0, in_window_total: 0, grade_breakdown: {},
                  upstream_status: r.status, upstream_url: upstreamUrl, upstream_body_sample: sample,
                  fetched_at: new Date().toISOString(), source: 'psa-apr',
                  reason: 'PSA APR returned non-JSON body',
                }));
                return;
              }
              const _r = { status: r.status, _sample: sample };
              const rawSales = Array.isArray(upstreamJson)
                ? upstreamJson
                : (upstreamJson?.AuctionPrices || upstreamJson?.SalesHistory || upstreamJson?.Sales || []);

              const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
              const normalizedAll = rawSales
                .map(s => ({
                  date: dateOf(s),
                  price: priceOf(s),
                  grade: parseGradeFromString(s?.Grade ?? s?.GradeDescription),
                  auction: s?.AuctionName || s?.Auction || s?.AuctionHouse || '',
                  lot: s?.LotNumber || s?.Lot || '',
                  url: s?.AuctionItemURL || s?.URL || s?.Url || '',
                }))
                .filter(s => s.date && s.price > 0);

              const inWindow = normalizedAll.filter(s => {
                const t = Date.parse(s.date);
                return Number.isFinite(t) && t >= cutoff;
              });

              const gradeMatching = gradeWanted != null
                ? inWindow.filter(s => s.grade != null && Math.abs(s.grade - gradeWanted) < 0.05)
                : inWindow;

              const prices = gradeMatching.map(s => s.price);
              const suggested = median(prices);
              const low = prices.length ? Math.min(...prices) : null;
              const high = prices.length ? Math.max(...prices) : null;
              const sorted = [...gradeMatching].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
              const mostRecent = sorted[0]?.date || null;

              const gradeBreakdown = {};
              for (const s of inWindow) {
                const g = s.grade != null ? String(s.grade) : 'unknown';
                gradeBreakdown[g] = (gradeBreakdown[g] || 0) + 1;
              }

              res.statusCode = 200;
              res.end(JSON.stringify({
                spec_id: spec,
                grade: gradeWanted,
                window_days: days,
                suggested_price: suggested,
                suggested_method: 'median',
                sample_count: prices.length,
                low,
                high,
                most_recent_sale_at: mostRecent,
                sales: sorted.slice(0, 20),
                upstream_total: normalizedAll.length,
                in_window_total: inWindow.length,
                grade_breakdown: gradeBreakdown,
                upstream_status: _r.status,
                upstream_url: upstreamUrl,
                upstream_body_sample: _r._sample,
                fetched_at: new Date().toISOString(),
                source: 'psa-apr',
              }));
            } catch (e) {
              res.statusCode = 502;
              res.end(JSON.stringify({ error: `PSA APR fetch failed: ${e.message || e}` }));
            }
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
          const groupPricesInFlight = new Map();

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

          const parallelEach = async (items, concurrency, fn) => {
            let next = 0;
            const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
              while (next < items.length) {
                const i = next++;
                try { await fn(items[i], i); } catch (e) { /* per-item caught below */ }
              }
            });
            await Promise.all(workers);
          };

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
              const groupList = groups.results || [];
              for (const g of groupList) {
                if (g.abbreviation) abbrIdx.set(g.groupId, g.abbreviation);
                if (g.name) nameIdx.set(g.groupId, g.name);
              }
              await parallelEach(groupList, 8, async (g) => {
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
              });
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
            const existing = groupPricesInFlight.get(groupId);
            if (existing) return existing;
            const promise = (async () => {
              const data = await fetchJSON(`${TCGCSV_BASE}/${CATEGORY_ID}/${groupId}/prices`);
              const prices = data.results || [];
              groupPricesCache.set(groupId, { prices, fetchedAt: Date.now() });
              return prices;
            })().finally(() => groupPricesInFlight.delete(groupId));
            groupPricesInFlight.set(groupId, promise);
            return promise;
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
              is_manga: info.isManga,
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
            const groupAbbrRaw = url.searchParams.get('groupAbbr');
            const allRaw = url.searchParams.get('all');
            const groupsRaw = url.searchParams.get('groups');

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

            if (groupAbbrRaw) {
              const wanted = String(groupAbbrRaw).trim().toUpperCase().replace(/\s+/g, '');
              if (!wanted) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'groupAbbr must be non-empty' }));
                return;
              }
              try {
                const groupsData = await fetchJSON(`${TCGCSV_BASE}/${CATEGORY_ID}/groups`);
                const matched = (groupsData.results || []).find(g =>
                  (g.abbreviation || '').toUpperCase().replace(/\s+/g, '') === wanted
                );
                if (!matched) {
                  res.statusCode = 404;
                  res.end(JSON.stringify({ error: `no TCGPlayer group with abbreviation "${groupAbbrRaw}"` }));
                  return;
                }
                const [productsData, prices] = await Promise.all([
                  fetchJSON(`${TCGCSV_BASE}/${CATEGORY_ID}/${matched.groupId}/products`),
                  getGroupPrices(matched.groupId),
                ]);
                const products = (productsData.results || []).map(p => {
                  const record = pickPriceRecord(prices, p.productId);
                  return {
                    tcg_id: p.productId,
                    group_id: matched.groupId,
                    group_abbreviation: matched.abbreviation || '',
                    group_name: matched.name || '',
                    name: p.name || '',
                    clean_name: p.cleanName || '',
                    image_url: p.imageUrl || '',
                    tcgplayer_url: p.url || '',
                    number: extField(p.extendedData, 'Number'),
                    rarity: extField(p.extendedData, 'Rarity'),
                    is_parallel: detectIsParallel(p.name),
                    is_manga: detectIsManga(p.name),
                    market_price: record?.marketPrice ?? null,
                    low_price: record?.lowPrice ?? null,
                    mid_price: record?.midPrice ?? null,
                    high_price: record?.highPrice ?? null,
                    sub_type_name: record?.subTypeName ?? null,
                  };
                });
                products.sort((a, b) => (a.number || '').localeCompare(b.number || ''));
                res.statusCode = 200;
                res.end(JSON.stringify({
                  group_id: matched.groupId,
                  group_abbreviation: matched.abbreviation,
                  group_name: matched.name,
                  products,
                  fetched_at: new Date().toISOString(),
                }));
              } catch (e) {
                res.statusCode = 502;
                res.end(JSON.stringify({ error: `TCGCSV upstream failure: ${e.message || e}` }));
              }
              return;
            }

            if (groupsRaw) {
              try {
                const data = await fetchJSON(`${TCGCSV_BASE}/${CATEGORY_ID}/groups`);
                const groups = (data.results || []).map(g => ({
                  group_id: g.groupId,
                  abbreviation: g.abbreviation || '',
                  name: g.name || '',
                }));
                groups.sort((a, b) => (a.abbreviation || '').localeCompare(b.abbreviation || ''));
                res.statusCode = 200;
                res.end(JSON.stringify({ groups, fetched_at: new Date().toISOString() }));
              } catch (e) {
                res.statusCode = 502;
                res.end(JSON.stringify({ error: `TCGCSV upstream failure: ${e.message || e}` }));
              }
              return;
            }

            if (allRaw) {
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
                res.statusCode = 200;
                res.end(JSON.stringify({
                  count: filtered.length,
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
            res.end(JSON.stringify({ error: 'one of ?tcgId=N, ?number=X, ?groupAbbr=X, ?all=1, or ?groups=1 is required' }));
          });
        },
      },
    ],
    build: { outDir: 'dist' },
  };
});
