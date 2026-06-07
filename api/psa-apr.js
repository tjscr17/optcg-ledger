// Vercel serverless function: PSA Auction Prices Realized.
//
// Returns recent graded-sale prices for a PSA spec id, optionally filtered to
// a specific grade. The client (AddByCertModal etc.) calls this right after a
// cert lookup to suggest a Graded market price.
//
// Same auth as /api/psa — `VITE_PSA_TOKEN` (Vercel exposes all env vars to
// serverless functions regardless of the VITE_ prefix). PSA blocks browser
// CORS, so the call has to go through this proxy.
//
// Query params:
//   spec=12345        PSA SpecID (from cert.SpecID on the cert-lookup response)
//   grade=10          Optional. Filters sales to this numeric grade.
//   days=180          Optional. How far back to count sales (default 180).
//
// Response (200):
//   {
//     spec_id: "12345",
//     grade: 10 | null,
//     window_days: 180,
//     suggested_price: 324.50 | null,    // median of in-window sales
//     suggested_method: "median",
//     sample_count: 12,
//     low: 280.00,
//     high: 420.00,
//     most_recent_sale_at: "2026-05-30",
//     sales: [ { date, price, grade, auction, lot, url } ]   // newest first, capped at 20
//     fetched_at: "...",
//     source: "psa-apr"
//   }
// On no data (still 200 so the client doesn't have to special-case):
//   { spec_id, grade, window_days, suggested_price: null, sample_count: 0,
//     sales: [], fetched_at, source: "psa-apr", reason: "..." }

const PSA_APR_URL = (specId) =>
  `https://api.psacard.com/publicapi/auctionprices/${encodeURIComponent(specId)}`;

const parseGradeFromString = (s) => {
  if (s == null) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
};

// Pull a sale's price out of whichever field PSA happens to use; their schema
// has drifted over time (`SalePrice`, `Price`, `EndPrice`, etc).
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

export default async function handler(req, res) {
  const specRaw = (req.query?.spec || '').toString().trim();
  if (!specRaw) {
    res.status(400).json({ error: 'spec query param is required' });
    return;
  }
  const gradeWanted = req.query?.grade != null && req.query.grade !== ''
    ? parseGradeFromString(req.query.grade)
    : null;
  // 365d default — OP TCG sales on PSA are sparse; a 180d window often
  // returns nothing even when PSA does have sales for the card.
  const days = Math.max(1, Math.min(3650, Number(req.query?.days) || 365));

  const token = process.env.VITE_PSA_TOKEN || process.env.PSA_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'PSA token not configured on the server' });
    return;
  }

  let upstreamJson;
  let upstreamStatus = 0;
  let upstreamRawSample = '';
  const upstreamUrl = PSA_APR_URL(specRaw);
  try {
    const r = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    upstreamStatus = r.status;
    const bodyText = await r.text();
    upstreamRawSample = bodyText.slice(0, 500);
    if (!r.ok) {
      // Surface upstream status verbatim so the client can distinguish
      // "endpoint missing" (404 = wrong URL) from "no data" (200 + empty)
      // from "auth wrong" (401/403) from upstream outage (5xx). The previous
      // 404→synthetic-success path was misleading us.
      res.status(200).json({
        spec_id: specRaw, grade: gradeWanted, window_days: days,
        suggested_price: null, sample_count: 0, sales: [],
        upstream_total: 0, in_window_total: 0, grade_breakdown: {},
        fetched_at: new Date().toISOString(), source: 'psa-apr',
        upstream_status: upstreamStatus,
        upstream_url: upstreamUrl,
        upstream_body_sample: upstreamRawSample,
        reason: `PSA APR upstream returned ${upstreamStatus} for ${upstreamUrl}`,
      });
      return;
    }
    try {
      upstreamJson = JSON.parse(bodyText);
    } catch {
      res.status(200).json({
        spec_id: specRaw, grade: gradeWanted, window_days: days,
        suggested_price: null, sample_count: 0, sales: [],
        upstream_total: 0, in_window_total: 0, grade_breakdown: {},
        fetched_at: new Date().toISOString(), source: 'psa-apr',
        upstream_status: upstreamStatus,
        upstream_url: upstreamUrl,
        upstream_body_sample: upstreamRawSample,
        reason: 'PSA APR returned non-JSON body',
      });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: `PSA APR fetch failed: ${e.message || e}`, upstream_url: upstreamUrl });
    return;
  }

  // PSA returns either `{ AuctionPrices: [...] }` or an array directly,
  // depending on the endpoint version. Handle both.
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

  // Breakdown by grade across the in-window pool so the UI can offer a
  // helpful fallback ("no PSA 10 in window but 4 PSA 9 sales available").
  const gradeBreakdown = {};
  for (const s of inWindow) {
    const g = s.grade != null ? String(s.grade) : 'unknown';
    gradeBreakdown[g] = (gradeBreakdown[g] || 0) + 1;
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).json({
    spec_id: specRaw,
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
    upstream_status: upstreamStatus,
    upstream_url: upstreamUrl,
    upstream_body_sample: upstreamRawSample,
    fetched_at: new Date().toISOString(),
    source: 'psa-apr',
  });
}
