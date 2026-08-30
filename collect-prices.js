/**
 * Compgro price collector.
 *
 * Runs on a schedule (GitHub Actions cron, or crontab on any box), writes a
 * single static prices.json, then exits. The website just reads that file.
 * No database, nothing running between jobs, effectively zero hosting cost.
 *
 *   node collect-prices.js        # writes ./public/prices.json
 *
 * BEFORE POINTING THIS AT A REAL RETAILER
 *   - Read their robots.txt and terms of service.
 *   - Prefer an affiliate or partner feed. It is structured, legitimate,
 *     and it pays you instead of costing you.
 *   - If you crawl: identify the bot honestly, one request at a time, wide
 *     delays, cache hard. Never hammer.
 *   - Republishing another company's prices to sell ads against carries more
 *     risk than reading them privately. Worth an hour of a lawyer's time
 *     before launch rather than after.
 */

const fs = require('fs');
const path = require('path');

const OUT  = path.join(__dirname, 'public', 'prices.json');
const HIST = path.join(__dirname, 'public', 'history.json');
const HISTORY_DAYS = 90;                     // rolling window we keep
const DELAY_MS = 2500;                       // between requests to one retailer
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------
   CATALOGUE
   One canonical product, one canonical pack size, many retailer SKUs.
   This is what makes the comparison honest — without it you compare
   5kg against 4.5kg and call the difference a saving.
   ------------------------------------------------------------------ */
const CATALOGUE = [
  { id:'toor-dal-1kg', name:'Toor Dal 1kg', variant:'Loose', icon:'🫘',
    category:'pulses', size:{ value:1, unit:'kg' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'aashirvaad-atta-5kg', name:'Aashirvaad Atta 5kg', variant:'Whole wheat', icon:'🌾',
    category:'staples', size:{ value:5, unit:'kg' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'india-gate-1kg', name:'India Gate Basmati Rice 1kg', variant:'Basmati', icon:'🍚',
    category:'staples', size:{ value:1, unit:'kg' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'tata-salt-1kg', name:'Tata Salt 1kg', variant:'Iodised', icon:'🧂',
    category:'staples', size:{ value:1, unit:'kg' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'amul-taaza-1l', name:'Amul Taaza Milk 1L', variant:'Toned milk', icon:'🥛',
    category:'dairy', size:{ value:1, unit:'l' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'amul-butter-500g', name:'Amul Butter 500g', variant:'Salted', icon:'🧈',
    category:'dairy', size:{ value:500, unit:'g' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'fortune-oil-1l', name:'Fortune Sunflower Oil 1L', variant:'Cooking oil', icon:'🛢️',
    category:'oils', size:{ value:1, unit:'l' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'saffola-gold-1l', name:'Saffola Gold Oil 1L', variant:'Blended oil', icon:'🫒',
    category:'oils', size:{ value:1, unit:'l' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'colgate-200g', name:'Colgate Strong Teeth 200g', variant:'Toothpaste', icon:'🪥',
    category:'personal', size:{ value:200, unit:'g' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'surf-excel-1kg', name:'Surf Excel Easy Wash 1kg', variant:'Detergent powder', icon:'🧼',
    category:'household', size:{ value:1, unit:'kg' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'maggi-560g', name:'Maggi Noodles 560g', variant:'12-pack', icon:'🍜',
    category:'snacks', size:{ value:560, unit:'g' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } },
  { id:'tata-tea-1kg', name:'Tata Tea Premium 1kg', variant:'Leaf tea', icon:'🍵',
    category:'snacks', size:{ value:1, unit:'kg' },
    urls:{ dmart:'', reliance:'', bigbazaar:'', more:'', vishal:'' } }
];

const STORES = [
  { id:'dmart',     name:'D Mart' },
  { id:'reliance',  name:'Reliance Mart' },
  { id:'bigbazaar', name:'Big Bazaar' },
  { id:'more',      name:'More Supermarket' },
  { id:'vishal',    name:'Vishal Mega Mart' }
];

/* ------------------------------------------------------------------
   SOURCE
   Replace the body of readPrice() one retailer at a time.
   Return { price, mrp, stock } — or null if the SKU isn't carried.
   ------------------------------------------------------------------ */
const { politeFetch, loadCache, saveCache, extractJsonLd, extractByPattern } = require('./crawler');

/* Per-store fallback patterns, used only when a page has no JSON-LD.
   Fill these in one retailer at a time, after looking at a real page.
   Leave a store out entirely and it simply gets skipped. */
const PATTERNS = {
  // dmart: {
  //   price:      /"sellingPrice"\s*:\s*"?([\d.]+)/,
  //   mrp:        /"mrp"\s*:\s*"?([\d.]+)/,
  //   outOfStock: /out\s*of\s*stock/i
  // }
};

const crawlCache = loadCache();
const crawlNotes = [];

async function readPrice(storeId, product) {
  const url = product.urls[storeId];

  if (url) {
    try {
      const res = await politeFetch(url, crawlCache);

      // 304: nothing changed since last run. Keeping the previous price is
      // both correct and the whole point of asking conditionally.
      if (res.notModified) return { unchanged: true };
      if (!res.html) return null;                    // 404/410 — not carried

      const reading = extractJsonLd(res.html) || extractByPattern(res.html, PATTERNS[storeId]);
      if (!reading) {
        crawlNotes.push(`${product.id}|${storeId}: page fetched but no price found`);
        return null;
      }
      return reading;

    } catch (err) {
      if (err.robotsBlocked)   crawlNotes.push(`${product.id}|${storeId}: blocked by robots.txt — not fetched`);
      else if (err.rateLimited) crawlNotes.push(`${product.id}|${storeId}: rate limited, backing off`);
      else crawlNotes.push(`${product.id}|${storeId}: ${err.message}`);
      return null;
    }
  }

  // Placeholder until a source is wired. Deterministic, so the pipeline is
  // testable end to end, and flagged as 'sample' downstream so the site says so.
  const seed = [...(product.id + storeId)].reduce((a, c) => a + c.charCodeAt(0), 0);
  if (seed % 19 === 0) return { price: null, mrp: null, stock: 'out' };
  const base = 40 + (seed % 230);
  return { price: base, mrp: Math.round(base * 1.12), stock: 'in' };
}

/* ------------------------------------------------------------------
   SANITY CHECKS
   A broken parser is worse than no data — it quietly publishes ₹5 atta
   and burns the trust the whole product runs on. Every reading is checked
   against the last good one; anything implausible falls back to the
   previous price and is marked stale.
   ------------------------------------------------------------------ */
function loadPrevious() {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const map = {};
    prev.products.forEach(p => p.offers.forEach(o => {
      if (o.price != null) map[`${p.id}|${o.store}`] = { price: o.price, at: o.fetchedAt };
    }));
    return map;
  } catch { return {}; }
}

function plausible(reading, prev, warnings, label) {
  if (!reading || reading.price == null) return true;
  const { price, mrp } = reading;

  if (!(price > 0) || price > 100000) {
    warnings.push(`${label}: price ${price} out of range`);
    return false;
  }
  if (mrp && price > mrp * 1.05) {
    warnings.push(`${label}: price ${price} exceeds MRP ${mrp}`);
    return false;
  }
  if (prev) {
    const ratio = price / prev.price;
    if (ratio > 2 || ratio < 0.5) {
      warnings.push(`${label}: ${prev.price} → ${price} (${Math.round((ratio - 1) * 100)}% jump)`);
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------
   PRICE HISTORY
   One point per product per day: the best price available that day and
   which store had it. Still a static file, still no database. Anything
   older than HISTORY_DAYS is dropped, so the file stays small forever
   (12 products x 90 days is a few tens of kilobytes).

   The job runs hourly but we only keep one point per calendar day —
   later runs overwrite that day's point. Storing every hour would make
   the file 24x bigger and tell you nothing extra.
   ------------------------------------------------------------------ */
function updateHistory(products, startedAt, isSample) {
  let hist = { updatedAt: null, days: HISTORY_DAYS, series: {} };
  try {
    const j = JSON.parse(fs.readFileSync(HIST, 'utf8'));
    if (j && j.series) hist = j;
  } catch { /* first run */ }

  const day    = startedAt.slice(0, 10);
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);

  for (const p of products) {
    // prefer fresh readings; fall back to last-known so a bad fetch hour
    // doesn't punch a hole in the chart
    const fresh = p.offers.filter(o => o.price != null && !o.stale);
    const pool  = fresh.length ? fresh : p.offers.filter(o => o.price != null);
    if (!pool.length) continue;

    const best = pool.reduce((a, b) => (b.price < a.price ? b : a));
    let arr = (hist.series[p.id] || []).filter(pt => pt.d >= cutoff);

    // Sample mode only: backfill a plausible-looking curve so the chart is
    // visible before real data accumulates. Deleted the moment real points
    // start arriving, and never written when a live source is connected.
    if (!arr.length && isSample) arr = backfill(p.id, best, day);

    const point = { d: day, p: best.price, s: best.store };
    if (arr.length && arr[arr.length - 1].d === day) arr[arr.length - 1] = point;
    else arr.push(point);

    hist.series[p.id] = arr;
  }

  hist.updatedAt = startedAt;
  hist.days = HISTORY_DAYS;
  hist.sample = !!isSample;
  fs.mkdirSync(path.dirname(HIST), { recursive: true });
  fs.writeFileSync(HIST, JSON.stringify(hist));
  return hist;
}

function backfill(productId, best, today) {
  const seed = [...productId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const out = [];
  for (let i = 45; i > 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    if (d >= today) continue;
    const wobble = Math.sin((seed + i) / 6) * 0.06 + Math.sin(i / 17) * 0.04;
    out.push({ d, p: Math.round(best.price * (1 + wobble)), s: best.store, synthetic: true });
  }
  return out;
}

/* ------------------------------------------------------------------ */
async function main() {
  const startedAt = new Date().toISOString();
  const previous  = loadPrevious();
  const warnings  = [];
  let live = false;

  const products = [];

  for (const product of CATALOGUE) {
    const offers = [];

    for (const store of STORES) {
      const label = `${product.id}|${store.id}`;
      let reading = null;

      try {
        reading = await readPrice(store.id, product);
        if (product.urls[store.id]) live = true;   // crawler handles its own pacing
      } catch (err) {
        warnings.push(`${label}: fetch failed — ${err.message}`);
      }

      // 304 Not Modified — carry the previous price forward as fresh,
      // because the retailer just told us it hasn't changed.
      if (reading && reading.unchanged) {
        const prev304 = previous[label];
        reading = prev304 ? { price: prev304.price, mrp: null, stock: 'in' } : null;
      }

      const ok   = plausible(reading, previous[label], warnings, label);
      const prev = previous[label];

      if (ok && reading) {
        offers.push({
          store: store.id,
          price: reading.stock === 'out' ? null : reading.price,
          mrp: reading.mrp,
          stock: reading.stock,
          stale: false,
          fetchedAt: startedAt
        });
      } else {
        // keep the last known good price rather than showing nothing
        offers.push({
          store: store.id,
          price: prev ? prev.price : null,
          mrp: null,
          stock: prev ? 'unknown' : 'out',
          stale: true,
          fetchedAt: prev ? prev.at : startedAt
        });
      }
    }

    products.push({
      id: product.id, name: product.name, variant: product.variant,
      icon: product.icon, category: product.category, size: product.size,
      offers
    });
  }

  warnings.push(...crawlNotes);
  saveCache(crawlCache);

  const payload = {
    source: live ? 'live' : 'sample',
    generatedAt: startedAt,
    stores: STORES,
    products,
    warnings
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  const hist = updateHistory(products, startedAt, payload.source === 'sample');

  console.log(`Wrote ${products.length} products to ${OUT} (source: ${payload.source})`);
  console.log(`History: ${Object.keys(hist.series).length} series in ${HIST}`);
  if (warnings.length) console.warn(`${warnings.length} warning(s):\n  ` + warnings.join('\n  '));
}

/* ------------------------------------------------------------------
   PROBE MODE
     node collect-prices.js --probe "https://store.example/product/atta"

   Fetches one page, reports whether robots.txt allows it, whether the
   page carries structured data, and what price it would have read.
   Use this before adding any URL to the catalogue — it tells you in ten
   seconds whether a retailer is crawlable at all.
   ------------------------------------------------------------------ */
async function probe(url) {
  console.log(`Probing ${url}\n`);
  try {
    const res = await politeFetch(url, {});
    console.log(`  robots.txt   : allowed`);
    console.log(`  HTTP status  : ${res.status}`);

    if (!res.html) { console.log('  result       : no page body (not carried, or gone)'); return; }
    console.log(`  page size    : ${(res.html.length / 1024).toFixed(1)} kb`);

    const ld = extractJsonLd(res.html);
    console.log(`  JSON-LD      : ${ld ? 'found' : 'none — you will need a pattern for this store'}`);
    if (ld) console.log(`  reading      : price ${ld.price}, mrp ${ld.mrp ?? 'n/a'}, stock ${ld.stock}`);

    if (!ld) {
      // A price rendered by JavaScript won't be in the HTML at all. Worth
      // knowing, because it means this retailer can't be crawled this way.
      const looksJs = /__NEXT_DATA__|window\.__INITIAL_STATE__|ng-version/.test(res.html);
      console.log(`  note         : ${looksJs
        ? 'page looks JavaScript-rendered — the price may not exist in the HTML'
        : 'static page; try a pattern against the raw HTML'}`);
    }
  } catch (err) {
    if (err.robotsBlocked) console.log('  robots.txt   : DISALLOWED — do not crawl this path');
    else console.log(`  failed       : ${err.message}`);
  }
}

const probeUrl = process.argv.includes('--probe') && process.argv[process.argv.indexOf('--probe') + 1];
if (probeUrl) probe(probeUrl).catch(e => { console.error(e); process.exit(1); });
else main().catch(err => { console.error(err); process.exit(1); });
