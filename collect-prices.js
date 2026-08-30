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

const OUT = path.join(__dirname, 'public', 'prices.json');
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
async function readPrice(storeId, product) {
  const url = product.urls[storeId];

  if (url) {
    // ---- REAL SOURCE GOES HERE ---------------------------------------
    // Affiliate / partner feed (preferred):
    //   const res = await fetch(FEED_URL, { headers:{ Authorization: process.env.FEED_KEY }});
    //   const row = (await res.json()).find(r => r.sku === url);
    //   return row ? { price: row.sellingPrice, mrp: row.mrp,
    //                  stock: row.inStock ? 'in' : 'out' } : null;
    //
    // Or a polite crawl:
    //   const res  = await fetch(url, { headers:{ 'User-Agent':'CompgroBot/1.0 (+https://compgro.in/bot)' }});
    //   const html = await res.text();
    //   const price = Number((html.match(/"sellingPrice":\s*([\d.]+)/) || [])[1]);
    //   const mrp   = Number((html.match(/"mrp":\s*([\d.]+)/) || [])[1]);
    //   return Number.isFinite(price) ? { price, mrp: mrp || null, stock:'in' } : null;
    // ------------------------------------------------------------------
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
        if (product.urls[store.id]) { live = true; await sleep(DELAY_MS); }
      } catch (err) {
        warnings.push(`${label}: fetch failed — ${err.message}`);
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

  const payload = {
    source: live ? 'live' : 'sample',
    generatedAt: startedAt,
    stores: STORES,
    products,
    warnings
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log(`Wrote ${products.length} products to ${OUT} (source: ${payload.source})`);
  if (warnings.length) console.warn(`${warnings.length} warning(s):\n  ` + warnings.join('\n  '));
}

main().catch(err => { console.error(err); process.exit(1); });
