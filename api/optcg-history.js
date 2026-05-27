// Vercel serverless function: OPTCGAPI 14-day history proxy.
//
// OPTCGAPI returns 500 for any card it has no recent history for, and the
// 500 response carries no CORS headers — which surfaces in the browser as
// a scary "blocked by CORS policy" error even when our client-side code
// catches the network failure cleanly. Going through this proxy means the
// browser only sees our 200 response with an empty `points` array.
//
// We try the three OPTCGAPI history endpoints (sets / decks / promos)
// server-side; first non-empty win short-circuits. Always responds 200.

const API = 'https://optcgapi.com/api';

const fetchJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.json();
};

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

export default async function handler(req, res) {
  const idRaw = req.query?.id;
  const id = (idRaw || '').toString().trim();
  if (!id) {
    res.status(400).json({ error: 'id query param required' });
    return;
  }

  // Mirror the client-side normalization (strip parallel/variant suffixes)
  // so callers don't have to pre-process.
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
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
        res.status(200).json({ id: queryId, points: normalizePoints(data) });
        return;
      }
    } catch {}
  }

  // No history found — return an empty success rather than mirroring the
  // upstream's 500 (which is what was leaking the CORS-flavored noise into
  // the browser console).
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
  res.status(200).json({ id: queryId, points: [] });
}
