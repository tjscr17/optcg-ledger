// Ingest the Riftbound (RIFT) catalog from the Riftcodex API into Supabase.
//
//   node tools/ingest/riftbound.mjs
//
// Source: https://api.riftcodex.com (community API, no auth). We snapshot it
// into our own `sets` / `cards` / `rarities` rows so the app doesn't depend on
// it at runtime. Re-runnable: it refuses to run if RIFT data already exists —
// an admin must clear it first (see CLEANUP at the bottom) so we don't rely on
// anon delete rights.
//
// Mapping (deliberately minimal — no variant/attribute classification):
//   set_code   = riftcodex set_id (OGN, SFD, UNL, …)
//   card_code  = <SET>-<collector_number padded to 3>      e.g. UNL-060
//   variant_key= trailing letter in the riftbound_id, else 'base'  (e.g. 'a')
//   rarity     = classification.rarity     category = classification.type
//   image_url  = media.image_url (Riot CDN, hotlinkable)
//   external_id= riftbound_id              source   = 'riftcodex'

import { createClient } from '@supabase/supabase-js';

const SUPA_URL = 'https://ajpxzfhmyzzgarewijnr.supabase.co';
// Public anon key (same one bundled in src/catalog.js — bundle-safe by design).
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqcHh6ZmhteXp6Z2FyZXdpam5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTM3MjQsImV4cCI6MjA5NDcyOTcyNH0.YQ4V0pxw1tpOiVe_d9nxL0UqbHR-eFPTjiybpd2O28o';
const API = 'https://api.riftcodex.com';
const TCG = 'RIFT';
const SOURCE = 'riftcodex';

// Display order for the per-TCG rarity filter. Unknown rarities sort last.
const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Showcase', 'Overnumbered', 'Promo'];

const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const pad3 = (n) => String(n).padStart(3, '0');

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

async function fetchSets() {
  const body = await getJSON(`${API}/sets`);
  return body.items || [];
}

async function fetchAllCards() {
  const out = [];
  let page = 1;
  for (;;) {
    const body = await getJSON(`${API}/cards?page=${page}&size=100`);
    out.push(...(body.items || []));
    const pages = body.pages || 1;
    process.stdout.write(`\r  cards: page ${page}/${pages} (${out.length})   `);
    if (page >= pages) break;
    page++;
  }
  process.stdout.write('\n');
  return out;
}

// riftbound_id looks like "<set>-<num><marker>-<subset>", e.g. "unl-060a-219"
// (alt art 'a'), "unl-230*-219" (foil '*'), "opp-013-024" vs "opp-013-298"
// (same number, different promo wave -> distinguished by <subset>).
function ridParts(rid, setCode) {
  const lower = (rid || '').toLowerCase();
  const prefix = `${String(setCode).toLowerCase()}-`;
  const rest = lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
  const seg = rest.split('-');
  const core = seg[0] || '';
  const subset = seg.slice(1).join('-');
  const marker = core.replace(/^\d+/, ''); // '', 'a', '*', or a non-numeric core like 't03'
  return { core, subset, marker };
}
const markerKey = (marker) => (!marker ? 'base' : marker === '*' ? 'foil' : marker);
function numberOf(card) {
  if (card.collector_number != null) return card.collector_number;
  const m = /^[a-z]+-(\d+)/i.exec(card.riftbound_id || '');
  return m ? parseInt(m[1], 10) : null;
}

async function main() {
  // Guard: don't double-insert (no anon delete by design).
  const { count, error: cErr } = await supa
    .from('cards').select('id', { count: 'exact', head: true }).eq('source', SOURCE);
  if (cErr) throw new Error(`precheck failed: ${cErr.message}`);
  if (count > 0) {
    console.error(`\n${count} ${SOURCE} cards already exist. Clear them first (admin):`);
    console.error(`  delete from cards where source='${SOURCE}';`);
    console.error(`  delete from sets  where tcg_code='${TCG}';`);
    console.error(`  delete from rarities where tcg_code='${TCG}';`);
    process.exit(1);
  }

  console.log('Fetching Riftcodex sets…');
  const apiSets = await fetchSets();
  const setRows = apiSets.map((s) => ({
    set_code: s.set_id,
    tcg_code: TCG,
    name: s.name,
    language: 'EN',
    release_date: s.published_on ? s.published_on.slice(0, 10) : null,
    source_ref: s.id,
  }));
  const { data: insertedSets, error: sErr } = await supa.from('sets').insert(setRows).select('id,set_code');
  if (sErr) throw new Error(`set insert failed: ${sErr.message}`);
  const setIdByCode = new Map(insertedSets.map((r) => [r.set_code, r.id]));
  console.log(`Inserted ${insertedSets.length} sets.`);

  console.log('Fetching Riftcodex cards…');
  const apiCards = await fetchAllCards();

  // Pass 1: build preliminary rows with a candidate variant key.
  const rarities = new Set();
  const prelim = [];
  let skipped = 0;
  for (const c of apiCards) {
    const setCode = c.set?.set_id;
    const setId = setCode ? setIdByCode.get(setCode) : null;
    const num = numberOf(c);
    if (!setId || num == null) { skipped++; continue; }
    const rid = c.riftbound_id || c.id || '';
    const { subset, marker } = ridParts(rid, setCode);
    const rarity = c.classification?.rarity || null;
    if (rarity) rarities.add(rarity);
    prelim.push({
      setId,
      cardCode: `${setCode}-${pad3(num)}`,
      candidate: markerKey(marker),
      subset,
      rid: rid.toLowerCase(),
      name: c.name || null,
      rarity,
      category: c.classification?.type || null,
      image_url: c.media?.image_url || null,
      external_id: rid || null,
    });
  }

  // Pass 2: resolve variant_key per card_code group deterministically —
  // candidate first, then disambiguate by subset, then a stable index.
  const groups = new Map();
  for (const p of prelim) {
    if (!groups.has(p.cardCode)) groups.set(p.cardCode, []);
    groups.get(p.cardCode).push(p);
  }
  const cardRows = [];
  let disambiguated = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => a.rid.localeCompare(b.rid));
    const taken = new Set();
    for (const p of group) {
      let v = p.candidate;
      if (taken.has(v) && p.subset) v = `${p.candidate}-${p.subset}`;
      if (taken.has(v)) { let i = 2; while (taken.has(`${v}-${i}`)) i++; v = `${v}-${i}`; }
      if (v !== p.candidate) disambiguated++;
      taken.add(v);
      cardRows.push({
        set_id: p.setId,
        card_code: p.cardCode,
        variant_key: v,
        name: p.name,
        rarity: p.rarity,
        category: p.category,
        image_url: p.image_url,
        external_id: p.external_id,
        source: SOURCE,
      });
    }
  }
  console.log(`Variant keys: ${cardRows.length} cards, ${disambiguated} disambiguated beyond base/marker.`);

  console.log(`Inserting ${cardRows.length} cards (${skipped} skipped)…`);
  for (let i = 0; i < cardRows.length; i += 500) {
    const batch = cardRows.slice(i, i + 500);
    const { error } = await supa.from('cards').insert(batch);
    if (error) throw new Error(`card insert failed at ${i}: ${error.message}`);
    process.stdout.write(`\r  inserted ${Math.min(i + 500, cardRows.length)}/${cardRows.length}   `);
  }
  process.stdout.write('\n');

  const rarityRows = [...rarities].map((code) => {
    const idx = RARITY_ORDER.indexOf(code);
    return { tcg_code: TCG, code, label: code, sort_order: idx === -1 ? 999 : idx };
  });
  if (rarityRows.length) {
    const { error } = await supa.from('rarities').insert(rarityRows);
    if (error) throw new Error(`rarity insert failed: ${error.message}`);
  }

  console.log(`\nDone. sets=${insertedSets.length} cards=${cardRows.length} rarities=${rarityRows.length}`);
  console.log(`rarities: ${[...rarities].join(', ')}`);
}

main().catch((e) => { console.error('\nINGEST FAILED:', e.message); process.exit(1); });
