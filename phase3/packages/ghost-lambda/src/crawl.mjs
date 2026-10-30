// Crawl a running Ghost site and write its public pages to a content store.
// Idempotent: deterministic keys, overwritten each run. Only keys it created
// (tracked in the store) are ever deleted.
import { URL } from 'node:url';

const SKIP_PREFIXES = ['ghost/', 'members/', 'r/', 'p/', 'email/', 'unsubscribe/', 'gift/', 'webmentions/', 'content/images/'];
const TEXTUAL = /^(text\/|application\/(xml|rss\+xml|atom\+xml|json|javascript|xhtml\+xml))/;
const TRACK_KEY = '_generator/keys.json';

const CACHE_CONTROL = 'public, max-age=86400';

// Path under the blog base ('' for the home page) to a content-store key.
export function keyFor(path) {
  const p = path.replace(/^\/+/, '');
  return p === '' || p.endsWith('/') ? `${p}index.html` : p;
}

function extractLinks(body, contentType) {
  const links = new Set();
  const take = (u) => { if (u) links.add(u.trim()); };
  if (/html/.test(contentType)) {
    for (const m of body.matchAll(/\b(?:href|src|data-src|poster)\s*=\s*["']([^"'#]+)["']/gi)) take(m[1]);
    for (const m of body.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(',')) take(part.trim().split(/\s+/)[0]);
  } else if (/xml/.test(contentType)) {
    for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/g)) take(m[1]);
    for (const m of body.matchAll(/<link[^>]*>([^<]+)</g)) take(m[1]);
  }
  return links;
}

/**
 * @param {object} o
 * @param {string} o.origin       the site's public origin plus base path, e.g. https://example.com/blog
 * @param {(path: string) => Promise<{status: number, headers: Map|Headers, body: Buffer}>} o.fetchLocal
 * @param {object} o.store        content store (put/get/delete)
 * @param {string[]} [o.seeds]    base-relative seed paths
 * @param {(msg: string) => void} [o.log]
 */
export async function crawl({ origin, fetchLocal, store, seeds = ['/', '/sitemap.xml', '/rss/', '/robots.txt'], log = () => {} }) {
  const base = new URL(origin);
  const basePath = base.pathname.replace(/\/+$/, ''); // '/blog'
  const queue = [...seeds];
  const seen = new Set();
  const written = new Set();
  const failures = [];

  // A link found in a page, as a base-relative path or null if not ours / not static.
  const toLocal = (link) => {
    let u;
    try { u = new URL(link, origin + '/'); } catch { return null; }
    if (u.origin !== base.origin) return null;
    if (basePath && !(u.pathname === basePath || u.pathname.startsWith(basePath + '/'))) return null;
    const rel = u.pathname.slice(basePath.length) || '/';
    const noSlash = rel.replace(/^\/+/, '');
    if (SKIP_PREFIXES.some((p) => noSlash.startsWith(p))) return null;
    return rel;
  };

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let res;
    try {
      res = await fetchLocal(`${basePath}${rel}`);
    } catch (err) {
      failures.push([rel, err.message]);
      continue;
    }
    if (res.status !== 200) {
      if (!seeds.includes(rel) || res.status !== 404) failures.push([rel, res.status]);
      continue;
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const key = `${basePath.replace(/^\//, '')}/${keyFor(rel)}`.replace(/^\/+/, '');
    await store.put(key, res.body, { contentType, cacheControl: CACHE_CONTROL });
    written.add(key);
    if (TEXTUAL.test(contentType)) {
      for (const link of extractLinks(res.body.toString('utf8'), contentType)) {
        const l = toLocal(link);
        if (l && !seen.has(l)) queue.push(l);
      }
    }
  }

  // The 404 page: whatever the site renders for a path that does not exist.
  const missing = await fetchLocal(`${basePath}/this-page-does-not-exist-404/`);
  if (missing.status === 404) {
    const key = `${basePath.replace(/^\//, '')}/404.html`;
    await store.put(key, missing.body, { contentType: 'text/html; charset=utf-8', cacheControl: CACHE_CONTROL });
    written.add(key);
  } else {
    failures.push(['404 page', missing.status]);
  }

  // Remove only what an earlier run created and this run did not.
  let deleted = 0;
  const previous = await store.get(TRACK_KEY);
  if (previous) {
    for (const key of JSON.parse(previous.toString('utf8'))) {
      if (!written.has(key)) { await store.delete(key); deleted += 1; }
    }
  }
  await store.put(TRACK_KEY, Buffer.from(JSON.stringify([...written].sort())), { contentType: 'application/json', cacheControl: 'no-store' });
  log(`crawl: ${written.size} written, ${deleted} deleted, ${failures.length} failures`);
  return { written: [...written], deleted, failures };
}
