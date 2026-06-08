// OPTCG Ledger 130point sync — background service worker.
//
// Architecture: the SW orchestrates the sync but DOES NOT fetch 130point
// directly. Cloudflare rejects requests originating from chrome-extension://
// (cross-site) even with cf_clearance attached. So we delegate each fetch
// to the content script running inside a real 130point.com tab — the
// browser then sends those requests with sec-fetch-site=same-origin and
// Cloudflare treats them as normal page navigations.
//
// Flow:
//   popup → SW (RUN_SYNC) → ensure130pointTab() → for each card:
//     chrome.tabs.sendMessage(tab.id, FETCH_AND_PARSE) → content.js
//     → fetch(/api/search/html?q=...) → parseSearchResultsHtml()
//     → JSON sales array back to SW → write to Supabase REST API.

const SEARCH_URL_PATH = (q) =>
  `/api/search/html?q=${encodeURIComponent(q)}&sort=recent&mp=all`;

const QUERY_DELAY_MS = 1200;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || null;
}

function supabaseHeaders(s) {
  return {
    'apikey': s.supabaseKey,
    'Authorization': `Bearer ${s.supabaseKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

async function listEntries(s) {
  const url = `${s.supabaseUrl}/rest/v1/entries?select=card_id&vault_key=eq.${encodeURIComponent(s.vaultKey)}`;
  const r = await fetch(url, { headers: supabaseHeaders(s) });
  if (!r.ok) throw new Error(`Supabase entries fetch failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function insertSale(s, sale) {
  const url = `${s.supabaseUrl}/rest/v1/sales?on_conflict=vault_key,listing_url`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...supabaseHeaders(s), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(sale),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase insert failed: ${r.status} ${body}`);
  }
}

// Extract the base displayId from a canonical card_id. Handles:
//   OP01-016                       → OP01-016
//   OP01-016-parallel              → OP01-016
//   OP01-016-manga-parallel        → OP01-016
//   OP14RE:OP14-118                → OP14-118    (drops source-set prefix)
//   OP14RE:OP14-118-parallel       → OP14-118
//   OP01-016__pre-errata           → OP01-016    (legacy pre-2026-06-01 syntax)
// Positively anchors at the start of the string so variant suffixes never
// influence the match.
function extractDisplayId(canonicalCardId) {
  if (!canonicalCardId) return null;
  let s = String(canonicalCardId).replace(/__pre-errata$/, '');
  const colonIdx = s.indexOf(':');
  if (colonIdx > -1) s = s.slice(colonIdx + 1);
  const m = s.match(/^([A-Z]{2,4}\d{2}-[A-Z]?\d{2,3}[A-Z]?)/i);
  return m ? m[1].toUpperCase() : null;
}

// Find an existing 130point.com tab (so the manifest's content_script has
// already been injected); fall back to creating one if none exists. We wait
// for load and give Cloudflare a moment to drop cf_clearance before the
// first /api/ call.
async function ensure130pointTab() {
  const existing = await chrome.tabs.query({ url: 'https://130point.com/*' });
  if (existing.length > 0) {
    // Verify the content script is loaded — sometimes it isn't (e.g. an
    // older tab opened before the extension was installed). PING with a
    // short timeout; if no reply, reload the tab so the content script
    // injects.
    const tab = existing[0];
    const responded = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'PING' }).then(() => true).catch(() => false),
      sleep(500).then(() => false),
    ]);
    if (responded) return tab;
    await chrome.tabs.reload(tab.id);
    await waitForTabLoad(tab.id);
    await sleep(1500);
    return tab;
  }

  const tab = await chrome.tabs.create({ url: 'https://130point.com/search', active: false });
  await waitForTabLoad(tab.id);
  await sleep(1500);
  return tab;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Ask the content script to fetch a 130point URL and return parsed sales.
async function fetchAndParseInTab(tabId, path) {
  return chrome.tabs.sendMessage(tabId, { type: 'FETCH_AND_PARSE', path });
}

function toSalesRow(s, parsed, queryCardId) {
  // Accept any scrape result with a usable date + USD price. The display-time
  // matcher (webapp's sale-matcher.js) handles classification using current
  // aliases + variant rules, so over-strict rejection here only drops data
  // the user might later want.
  //
  // Skip rules (keep — they prevent real garbage):
  //   - bundles (multiple distinct card-IDs in title)
  //   - non-USD
  //   - missing sale date
  if (parsed.card_ids.length > 1) return null;
  if (parsed.currency !== 'USD') return null;
  if (!parsed.sale_date) return null;

  // Fall back to the queried card_id when the title doesn't carry one — the
  // user searched for it, after all, so it's the best default.
  const card_id = parsed.primary_canonical_id || parsed.primary_card_id || queryCardId;
  if (!card_id) return null;

  return {
    vault_key: s.vaultKey,
    card_id,
    grading_company: parsed.grading_company,
    grade: parsed.grade,
    bgs_black: parsed.bgs_black,
    sale_date: parsed.sale_date,
    sale_price: parsed.sale_price,
    currency: parsed.currency,
    marketplace: parsed.marketplace,
    listing_url: parsed.listing_url,
    listing_title: parsed.listing_title,
    notes: parsed.original_price ? `listed at $${parsed.original_price}; ${parsed.sale_type || ''}`.trim() : (parsed.sale_type || null),
    source: '130point-scrape',
  };
}

async function runSync() {
  const settings = await getSettings();
  if (!settings) throw new Error('Configure Supabase URL + key + vault first.');

  const entries = await listEntries(settings);
  const uniqueDisplayIds = Array.from(new Set(
    entries.map(e => extractDisplayId(e.card_id)).filter(Boolean)
  )).sort();
  if (uniqueDisplayIds.length === 0) {
    throw new Error('No graded card entries found to sync.');
  }

  postProgress({ phase: 'started', total: uniqueDisplayIds.length, done: 0, inserted: 0 });
  const tab = await ensure130pointTab();
  console.info('[sync] using tab', tab.id, '— querying', uniqueDisplayIds.length, 'unique displayIds');

  let inserted = 0;
  const errors = [];
  for (let i = 0; i < uniqueDisplayIds.length; i++) {
    const cardId = uniqueDisplayIds[i];
    const path = SEARCH_URL_PATH(`${cardId} one piece`);
    try {
      const resp = await fetchAndParseInTab(tab.id, path);
      if (!resp) {
        throw new Error('content script returned no response (tab may have unloaded)');
      }
      if (!resp.ok) {
        const why = resp.cloudflare
          ? `Cloudflare challenge — open ${`https://130point.com/search`} in your browser, prove you're human if asked, then retry sync.`
          : `130point fetch ${resp.status}${resp.error ? ' (' + resp.error + ')' : ''}`;
        throw new Error(why);
      }
      for (const ps of resp.sales) {
        const row = toSalesRow(settings, ps, cardId);
        if (!row) continue;
        try {
          await insertSale(settings, row);
          inserted++;
        } catch (insertErr) {
          console.warn('[sync] insert failed', cardId, ps.listing_url, insertErr);
          errors.push({ cardId, message: `insert: ${insertErr.message}` });
        }
      }
    } catch (e) {
      console.warn('[sync] error for', cardId, e);
      errors.push({ cardId, message: e.message || String(e) });
    }
    postProgress({ phase: 'progress', total: uniqueDisplayIds.length, done: i + 1, inserted, current: cardId });
    await sleep(QUERY_DELAY_MS);
  }

  postProgress({ phase: 'done', total: uniqueDisplayIds.length, done: uniqueDisplayIds.length, inserted, errors });
  return { inserted, errors };
}

function postProgress(msg) {
  chrome.runtime.sendMessage({ type: 'SYNC_PROGRESS', payload: msg }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'RUN_SYNC') {
    runSync()
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});
