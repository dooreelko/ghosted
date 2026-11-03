// Post-deploy smoke suite against a running Phase 3 edge (test distribution or the live domain).
// Plain node:test, no dependencies. Run through run-smoke.sh (which also runs the CloudWatch gate), or:
//   SMOKE_BASE=https://<edge host> GHOST_ADMIN_API_KEY=<id:secret> node --test phase3/scripts/smoke/
//
// Environment:
//   SMOKE_BASE            required, origin of the edge to test (no path)
//   SMOKE_PATH            base path of the site, default /blog
//   GHOST_ADMIN_API_KEY   an integration's admin key (id:secret); admin tests are skipped without it
//   SMOKE_CONTENT_KEY     a content API key; the keyed content API test is skipped without it
//   SMOKE_SCHEDULED=1     also run the scheduled-publish test (about 3 minutes)
//
// Never sends a newsletter and never prints a key. Writes only draft posts it deletes again.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const BASE = (process.env.SMOKE_BASE ?? '').replace(/\/$/, '');
const P = (process.env.SMOKE_PATH ?? '/blog').replace(/\/$/, '');
const ADMIN_KEY = process.env.GHOST_ADMIN_API_KEY;
const CONTENT_KEY = process.env.SMOKE_CONTENT_KEY;
if (!BASE) throw new Error('set SMOKE_BASE to the edge origin, e.g. https://abc.cloudfront.net');

const T = { timeout: 120_000 }; // a cold function boots for up to ~25 s
const get = (path, init = {}) => fetch(BASE + path, { redirect: 'manual', ...init });

function adminToken() {
  const [id, secret] = ADMIN_KEY.split(':');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT', kid: id });
  const body = b64({ iat: now, exp: now + 300, aud: '/admin/' });
  const sig = createHmac('sha256', Buffer.from(secret, 'hex')).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const admin = (method, path, body) =>
  fetch(`${BASE}${P}/ghost/api/admin${path}`, {
    method,
    redirect: 'manual',
    headers: { authorization: `Ghost ${adminToken()}`, 'content-type': 'application/json', 'x-ghost-version': '6.73' },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('public site (static, from the content bucket)', () => {
  let homeHtml = '';
  test('home page is HTML', T, async () => {
    const r = await get(`${P}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    homeHtml = await r.text();
    assert.ok(homeHtml.length > 1000);
  });
  test('sitemap and RSS', T, async () => {
    for (const [path, type] of [[`${P}/sitemap.xml`, /xml/], [`${P}/rss/`, /xml/]]) {
      const r = await get(path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get('content-type'), type, path);
    }
  });
  test('an extension-less path without the slash redirects to the slash form', T, async () => {
    const r = await get(`${P}/about`);
    assert.equal(r.status, 301);
    assert.match(r.headers.get('location'), /\/about\/$/);
  });
  test('an unknown path is the 404 page', T, async () => {
    const r = await get(`${P}/smoke-no-such-page/`);
    assert.equal(r.status, 404);
  });
  test('the bare root is not a bucket listing', T, async () => {
    const r = await get('/');
    assert.equal(r.status, 404);
  });
  test('an image and its size variant are served', T, async () => {
    const m = homeHtml.match(new RegExp(`${P}/content/images/[^"'\\s)]+?\\.(?:jpe?g|png|webp)`));
    assert.ok(m, 'the home page references an uploaded image');
    const original = await get(m[0]);
    assert.equal(original.status, 200);
    assert.match(original.headers.get('content-type'), /^image\//);
    const variant = await get(m[0].replace('/content/images/', '/content/images/size/w600/'));
    assert.ok([200, 302].includes(variant.status), `variant answered ${variant.status}`); // 302: original narrower than the size
  });
});

describe('members and content API (functions behind the gateway)', () => {
  test('anonymous member and session reads answer 204 at the edge', T, async () => {
    for (const p of ['member', 'session']) assert.equal((await get(`${P}/members/api/${p}/`)).status, 204, p);
  });
  test('a member identified by uuid in the query (unsubscribe links) reaches the function, not the anonymous shortcut', T, async () => {
    const r = await get(`${P}/members/api/member/newsletters/?uuid=00000000-0000-0000-0000-000000000000&key=smoke`);
    assert.notEqual(r.status, 204, 'the edge answered 204 for a request carrying a member uuid');
    assert.ok(r.status >= 400 && r.status < 500, `unknown uuid is refused by Ghost (got ${r.status})`);
  });
  test('content API refuses a wrong key', T, async () => {
    assert.equal((await get(`${P}/ghost/api/content/posts/?key=smoke-wrong`)).status, 401);
  });
  test('content API with the right key', { ...T, skip: !CONTENT_KEY && 'SMOKE_CONTENT_KEY not set' }, async () => {
    const r = await get(`${P}/ghost/api/content/posts/?limit=1&key=${CONTENT_KEY}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((await r.json()).posts));
  });
});

describe('admin client and admin API', () => {
  test('the admin client is served from the bucket', T, async () => {
    const r = await get(`${P}/ghost/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    const asset = html.match(/assets\/index-[^"']+\.js/);
    assert.ok(asset, 'entry page references its script');
    const a = await get(`${P}/ghost/${asset[0]}`);
    assert.equal(a.status, 200);
    assert.match(a.headers.get('cache-control') ?? '', /immutable/);
  });
  test('without credentials: setup and site answer, the rest refuse', T, async () => {
    const api = `${P}/ghost/api/admin`;
    assert.equal((await get(`${api}/authentication/setup/`)).status, 200);
    assert.equal((await get(`${api}/site/`)).status, 200);
    assert.equal((await get(`${api}/users/me/`)).status, 403);
  });

  describe('with an integration key', { skip: !ADMIN_KEY && 'GHOST_ADMIN_API_KEY not set' }, () => {
    test('reads: posts, members, tiers, newsletters, settings, users', T, async () => {
      for (const p of ['/posts/?limit=1', '/members/?limit=1', '/tiers/', '/newsletters/', '/settings/', '/users/']) {
        const r = await admin('GET', p);
        assert.equal(r.status, 200, p);
        await r.arrayBuffer();
      }
    });

    test('a burst of parallel calls (what the admin client does at load) is not throttled', T, async () => {
      const paths = ['/posts/?limit=1', '/members/?limit=1', '/tiers/', '/newsletters/', '/site/', '/settings/', '/users/', '/posts/?limit=1&page=2'];
      const rs = await Promise.all(paths.map((p) => admin('GET', p)));
      const statuses = await Promise.all(rs.map(async (r) => { await r.arrayBuffer(); return r.status; }));
      assert.deepEqual(statuses.filter((s) => s !== 200), [], `statuses: ${statuses}`);
    });

    describe('draft lifecycle', () => {
      let id;
      after(async () => { if (id) await admin('DELETE', `/posts/${id}/`); });
      test('create, edit, read, delete a draft', T, async () => {
        let r = await admin('POST', '/posts/', { posts: [{ title: `smoke ${new Date().toISOString()}`, status: 'draft' }] });
        assert.equal(r.status, 201);
        const post = (await r.json()).posts[0];
        id = post.id;
        r = await admin('PUT', `/posts/${id}/`, { posts: [{ title: `${post.title} edited`, updated_at: post.updated_at }] });
        assert.equal(r.status, 200);
        r = await admin('GET', `/posts/${id}/`);
        assert.match((await r.json()).posts[0].title, /edited$/);
        r = await admin('DELETE', `/posts/${id}/`);
        assert.equal(r.status, 204);
        id = undefined;
        assert.equal((await admin('GET', `/posts/${(post.id)}/`)).status, 404);
      });
    });

    describe('scheduled publish', { skip: process.env.SMOKE_SCHEDULED !== '1' && 'set SMOKE_SCHEDULED=1 (takes about 3 minutes)' }, () => {
      let id;
      after(async () => { if (id) await admin('DELETE', `/posts/${id}/`); });
      test('a post scheduled two minutes ahead publishes itself', { timeout: 420_000 }, async () => {
        let r = await admin('POST', '/posts/', { posts: [{ title: `smoke scheduled ${Date.now()}`, status: 'draft' }] });
        assert.equal(r.status, 201);
        const post = (await r.json()).posts[0];
        id = post.id;
        const at = new Date(Date.now() + 120_000).toISOString();
        r = await admin('PUT', `/posts/${id}/`, { posts: [{ status: 'scheduled', published_at: at, updated_at: post.updated_at }] });
        assert.equal(r.status, 200);
        const deadline = Date.now() + 360_000;
        let status;
        while (Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 15_000));
          status = (await (await admin('GET', `/posts/${id}/?fields=status`)).json()).posts[0].status;
          if (status === 'published') break;
        }
        assert.equal(status, 'published');
      });
    });
  });
});
