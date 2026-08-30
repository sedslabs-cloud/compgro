/**
 * Compgro — polite crawler.
 *
 * Everything here exists to make the crawl well-behaved rather than fast.
 * A crawler that is slow, honest and cacheable rarely causes anyone a problem.
 * A fast anonymous one gets blocked, and deserves to be.
 *
 * What it does:
 *   - reads and obeys robots.txt for every host, including Crawl-delay
 *   - identifies itself honestly, with a contact URL
 *   - one request at a time per host, with a floor on the gap between them
 *   - conditional requests (ETag / If-Modified-Since) so unchanged pages
 *     cost the retailer almost nothing
 *   - backs off on 429 and 5xx, honours Retry-After, then gives up quietly
 *   - never touches images, logos or descriptions. Prices only.
 *
 * It deliberately has no dependencies, so the Actions workflow needs no
 * npm install and nothing can rot underneath it.
 */

const fs   = require('fs');
const path = require('path');

const UA = 'CompgroBot/1.0 (+https://sedslabs-cloud.github.io/compgro/about-bot)';

const DEFAULTS = {
  minDelayMs: 5000,     // floor between requests to the same host
  timeoutMs: 15000,
  maxRetries: 2,
  cacheFile: path.join(__dirname, '.cache', 'etags.json')
};

/* ------------------------------------------------------------------
   robots.txt
   Parsed once per host per run. We check the most specific matching
   group: our own user-agent first, then the wildcard.
   ------------------------------------------------------------------ */
const robotsCache = new Map();

function parseRobots(txt) {
  const groups = [];
  let current = null;

  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();

    if (field === 'user-agent') {
      if (!current || current.rules.length || current.crawlDelay != null) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current) {
      if (field === 'disallow')      current.rules.push({ allow: false, path: value });
      else if (field === 'allow')    current.rules.push({ allow: true,  path: value });
      else if (field === 'crawl-delay') {
        const n = parseFloat(value);
        if (Number.isFinite(n)) current.crawlDelay = n * 1000;
      }
    }
  }
  return groups;
}

function pickGroup(groups, agent) {
  const me = agent.toLowerCase();
  const mine = groups.find(g => g.agents.some(a => a !== '*' && me.includes(a)));
  return mine || groups.find(g => g.agents.includes('*')) || null;
}

/* robots.txt path matching: longest match wins, * and $ are supported */
function pathAllowed(group, urlPath) {
  if (!group) return true;
  let best = null;

  for (const rule of group.rules) {
    if (rule.path === '') continue;                 // empty Disallow means allow all
    const re = new RegExp('^' + rule.path
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\\$$/, '$'));
    if (re.test(urlPath) && (!best || rule.path.length > best.path.length)) best = rule;
  }
  return best ? best.allow : true;
}

async function robotsFor(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);

  let result = { groups: [], reachable: false };
  try {
    const res = await fetch(origin + '/robots.txt', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(DEFAULTS.timeoutMs)
    });
    // 4xx means no robots.txt, which conventionally means crawling is allowed.
    // A 5xx means the server is unwell — the polite reading is to stay away.
    if (res.ok) result = { groups: parseRobots(await res.text()), reachable: true };
    else if (res.status >= 500) result = { groups: [], reachable: false, serverError: true };
    else result = { groups: [], reachable: true };
  } catch {
    result = { groups: [], reachable: false };
  }

  robotsCache.set(origin, result);
  return result;
}

/* ------------------------------------------------------------------
   conditional-request cache
   We store only ETag and Last-Modified, never page content. Small file,
   and it means an unchanged product page costs the retailer a 304.
   ------------------------------------------------------------------ */
function loadCache() {
  try { return JSON.parse(fs.readFileSync(DEFAULTS.cacheFile, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(DEFAULTS.cacheFile), { recursive: true });
    fs.writeFileSync(DEFAULTS.cacheFile, JSON.stringify(cache));
  } catch { /* cache is a nicety, never fatal */ }
}

/* ------------------------------------------------------------------
   per-host serial queue with a delay floor
   ------------------------------------------------------------------ */
const lastHit = new Map();
const hostQueue = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function queued(host, fn) {
  const prev = hostQueue.get(host) || Promise.resolve();
  const next = prev.then(fn, fn);
  hostQueue.set(host, next.catch(() => {}));
  return next;
}

/* ------------------------------------------------------------------
   the fetch itself
   Returns { status, html, notModified } or throws for a hard failure.
   ------------------------------------------------------------------ */
async function politeFetch(url, cache, opts = {}) {
  const u = new URL(url);
  const origin = u.origin;

  const robots = await robotsFor(origin);
  if (robots.serverError) throw new Error('robots.txt unreachable (server error) — skipping host');

  const group = pickGroup(robots.groups, UA);
  if (!pathAllowed(group, u.pathname)) {
    const e = new Error('disallowed by robots.txt');
    e.robotsBlocked = true;
    throw e;
  }

  const delay = Math.max(opts.minDelayMs ?? DEFAULTS.minDelayMs, group?.crawlDelay ?? 0);

  return queued(u.host, async () => {
    const since = Date.now() - (lastHit.get(u.host) || 0);
    if (since < delay) await sleep(delay - since);

    const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' };
    const entry = cache[url];
    if (entry?.etag) headers['If-None-Match'] = entry.etag;
    if (entry?.lastModified) headers['If-Modified-Since'] = entry.lastModified;

    let attempt = 0;
    for (;;) {
      lastHit.set(u.host, Date.now());
      let res;
      try {
        res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(DEFAULTS.timeoutMs) });
      } catch (err) {
        if (attempt++ >= DEFAULTS.maxRetries) throw err;
        await sleep(delay * (attempt + 1));
        continue;
      }

      if (res.status === 304) return { status: 304, notModified: true, html: null };

      if (res.status === 429 || res.status >= 500) {
        if (attempt++ >= DEFAULTS.maxRetries) {
          const e = new Error(`HTTP ${res.status} after retries`);
          e.rateLimited = res.status === 429;
          throw e;
        }
        const retryAfter = parseFloat(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : delay * Math.pow(3, attempt));
        continue;
      }

      if (res.status === 404 || res.status === 410) return { status: res.status, html: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const html = await res.text();
      const etag = res.headers.get('etag');
      const lm   = res.headers.get('last-modified');
      if (etag || lm) cache[url] = { etag, lastModified: lm };

      return { status: res.status, html };
    }
  });
}

/* ------------------------------------------------------------------
   extraction
   Structured data first. Most retail platforms emit schema.org Product
   JSON-LD, which is a published contract about meaning — far more stable
   than guessing at CSS classes that change with every redesign.
   ------------------------------------------------------------------ */
function extractJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const found = [];

  for (const [, body] of blocks) {
    let parsed;
    try { parsed = JSON.parse(body.trim()); } catch { continue; }
    const stack = Array.isArray(parsed) ? [...parsed] : [parsed];

    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);

      const type = [].concat(node['@type'] || []).map(String);
      if (!type.includes('Product')) continue;

      const offers = [].concat(node.offers || []);
      for (const offer of offers) {
        if (!offer || typeof offer !== 'object') continue;
        const price = Number(offer.price ?? offer.lowPrice);
        if (!Number.isFinite(price)) continue;
        const avail = String(offer.availability || '').toLowerCase();
        found.push({
          price,
          mrp: Number(offer.highPrice) || null,
          stock: avail.includes('outofstock') || avail.includes('soldout') ? 'out' : 'in',
          via: 'json-ld'
        });
      }
    }
  }
  return found[0] || null;
}

/* Fallback: per-store patterns. Used only when JSON-LD is absent.
   Expect these to break periodically — that is the nature of the thing,
   and why the sanity checks downstream matter. */
function extractByPattern(html, patterns) {
  if (!patterns) return null;
  const num = re => {
    const m = html.match(re);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const price = num(patterns.price);
  if (price == null) return null;
  const mrp = patterns.mrp ? num(patterns.mrp) : null;
  const out = patterns.outOfStock ? patterns.outOfStock.test(html) : false;
  return { price, mrp, stock: out ? 'out' : 'in', via: 'pattern' };
}

module.exports = { UA, politeFetch, loadCache, saveCache, extractJsonLd, extractByPattern, DEFAULTS };
