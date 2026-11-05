// Admin API locally: reads, a draft created and published, a tag, a delete, and the
// regeneration request a site-changing write leaves. Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInMemoryObjectStore, createManifestStore, createSegmentStore, seedStoreFromSqliteFile } from '@ghost-phase3/sqlite-s3';
import { createAdminHandler } from '../src/admin-app.mjs';

const ghostRequire = createRequire(path.join(process.env.GHOST_ROOT, 'core', 'x.js'));
const jwt = ghostRequire('jsonwebtoken');
const Database = ghostRequire('better-sqlite3');

// A staff sign-in needs a known password: work on a copy of the database whose owner has one
// (never logged in before, so Ghost skips the new-device email check).
import fs from 'node:fs';
import os from 'node:os';
const SIGNIN_PASSWORD = 'Test-only-p4ssword!';
const seedCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'admin-seed-')), 'g.db');
fs.copyFileSync(process.env.SEED_DB, seedCopy);
const security = ghostRequire('@tryghost/security');
const owner = (() => {
  const db = new Database(seedCopy);
  const u = db.prepare("select id, email from users where status = 'active' order by id limit 1").get();
  db.prepare('update users set last_seen = null where id = ?').run(u.id);
  return { db, ...u };
})();
owner.db.prepare('update users set password = ? where id = ?').run(await security.password.hash(SIGNIN_PASSWORD), owner.id);
owner.db.close();

const objectStore = createInMemoryObjectStore();
await seedStoreFromSqliteFile({ dbPath: seedCopy, manifestStore: createManifestStore(objectStore), segmentStore: createSegmentStore(objectStore) });

// An integration's admin key signs the token; the key lives in the seeded database.
const key = new Database(process.env.SEED_DB, { readonly: true }).prepare("select id, secret from api_keys where type = 'admin' limit 1").get();
const token = () => jwt.sign({}, Buffer.from(key.secret, 'hex'), { keyid: key.id, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/' });

const sent = [];
const handler = await createAdminHandler({ objectStore, queue: { send: async (m) => sent.push(m) } });

const base = new URL(process.env.GHOST_URL).pathname.replace(/\/$/, '');
async function call(method, p, body, raw) {
  const res = await handler({
    version: '2.0', rawPath: `${base}/ghost/api/admin${p.split('?')[0]}`, rawQueryString: p.split('?')[1] ?? '',
    headers: { host: 'example.test', 'x-forwarded-proto': 'http', 'x-ghost-version': '6.73', authorization: `Ghost ${token()}`, 'content-type': raw ? raw.type : 'application/json', origin: 'http://example.test' },
    requestContext: { http: { method, path: `${base}/ghost/api/admin${p}`, sourceIp: '127.0.0.1' } },
    body: raw ? raw.body.toString('base64') : body ? JSON.stringify(body) : undefined, isBase64Encoded: Boolean(raw),
  }, {});
  const text = res.isBase64Encoded ? Buffer.from(res.body, 'base64').toString() : res.body;
  let json; try { json = JSON.parse(text); } catch {}
  console.log(`  ${res.statusCode} ${method} ${p} ${json ? '' : String(text).slice(0, 100)}`);
  return { status: res.statusCode, json, text };
}

const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } };
let r = await call('GET', '/posts/?limit=2');
ok(r.status === 200 && r.json.posts.length, 'list posts');
r = await call('GET', '/site/');
ok(r.status === 200, 'site');
r = await call('GET', '/settings/');
ok(r.status === 200, 'settings');
r = await call('GET', '/tags/?limit=3');
ok(r.status === 200, 'tags');
r = await call('GET', '/members/?limit=2');
ok(r.status === 200, 'members');
r = await call('GET', '/newsletters/');
ok(r.status === 200, 'newsletters');
r = await call('GET', '/users/?limit=2');
ok(r.status === 200, 'users');
r = await call('POST', '/tags/', { tags: [{ name: 'admin local test' }] });
ok(r.status === 201, 'create tag');
r = await call('POST', '/posts/', { posts: [{ title: 'Admin local test', status: 'draft' }] });
ok(r.status === 201, 'create post');
const post = r.json.posts[0];
r = await call('PUT', `/posts/${post.id}/`, { posts: [{ status: 'published', updated_at: post.updated_at }] });
ok(r.status === 200 && r.json.posts[0].status === 'published', 'publish');
r = await call('DELETE', `/posts/${post.id}/`);
ok(r.status === 204, 'delete post');

// Draft saves do not ask for a regeneration (the editor autosaves a draft every few seconds); anything that
// touches the public site does.
{
  const count = () => sent.length;
  let before = count();
  r = await call('POST', '/posts/', { posts: [{ title: 'Draft only test', status: 'draft' }] });
  const d = r.json.posts[0];
  ok(count() === before, 'creating a draft requests no regeneration');
  r = await call('PUT', `/posts/${d.id}/`, { posts: [{ title: 'Draft only test, saved', updated_at: d.updated_at }] });
  ok(r.status === 200 && count() === before, 'saving a draft requests no regeneration');
  r = await call('PUT', `/posts/${d.id}/`, { posts: [{ status: 'published', updated_at: r.json.posts[0].updated_at }] });
  ok(r.status === 200 && count() === before + 1, 'publishing requests a regeneration');
  before = count();
  r = await call('PUT', `/posts/${d.id}/`, { posts: [{ title: 'Published, edited', updated_at: r.json.posts[0].updated_at }] });
  ok(r.status === 200 && count() === before + 1, 'editing a published post requests a regeneration');
  before = count();
  r = await call('PUT', `/posts/${d.id}/`, { posts: [{ status: 'draft', updated_at: r.json.posts[0].updated_at }] });
  ok(r.status === 200 && count() === before + 1, 'unpublishing requests a regeneration');
  before = count();
  r = await call('DELETE', `/posts/${d.id}/`);
  ok(r.status === 204 && count() === before, 'deleting a draft requests no regeneration');
  r = await call('POST', '/posts/', { posts: [{ title: 'Published at creation', status: 'published' }] });
  ok(r.status === 201 && count() === before + 1, 'creating a published post requests a regeneration');
  before = count();
  r = await call('DELETE', `/posts/${r.json.posts[0].id}/`);
  ok(r.status === 204 && count() === before + 1, 'deleting a published post requests a regeneration');
}

// Multipart upload helper: the files and fields Ghost's upload endpoints take.
function multipart(fields, file) {
  const boundary = '----phase3test';
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { type: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
r = await call('POST', '/images/upload/', null, multipart({ purpose: 'image', ref: 't.png' }, { name: 't.png', type: 'image/png', data: png }));
ok(r.status === 201, 'image upload');
r = await call('POST', '/files/upload/', null, multipart({}, { name: 't.txt', type: 'text/plain', data: Buffer.from('hello') }));
ok(r.status === 201, 'file upload');
r = await call('GET', '/members/upload/');
ok(r.status === 200, 'members export');
r = await call('GET', '/db/');
ok(r.status === 403, 'db export is staff-only (an integration key is refused)');
r = await call('GET', '/posts/export/');
ok(r.status === 200, 'posts export');
r = await call('POST', '/members/upload/', null, multipart({ 'mapping[email]': 'email' }, { field: 'membersfile', name: 'm.csv', type: 'text/csv', data: Buffer.from('email\nimport-test@example.invalid\n') }));
if (r.status >= 400) console.log(r.text);
ok(r.status === 201 || r.status === 200, 'members import');
r = await call('GET', '/members/?filter=email:import-test@example.invalid');
ok(r.json?.members?.length === 1, 'imported member exists (the import job ran inside the request)');

// Every admin read endpoint: a lazily loaded module that the pruned tree lacks shows up as a 500 here.
for (const g of ['/posts/', '/pages/', '/tags/', '/members/', '/members/stats/count/', '/labels/', '/tiers/', '/offers/', '/newsletters/', '/automations/', '/automated_emails/', '/emails/', '/comments/', '/feedback/', '/recommendations/', '/mentions/', '/links/', '/stats/', '/snippets/', '/webhooks/', '/integrations/', '/users/', '/roles/', '/invites/', '/themes/', '/custom_theme_settings/', '/settings/', '/config/', '/site/', '/slugs/post/test/', '/actions/', '/search-index/posts/', '/redirects/download/', '/oembed/?url=https://example.invalid/', '/schedules/', '/identities/', '/gifts/', '/gift_links/', '/stats/top-content/', '/stats/mrr/', '/exports/']) {
  r = await call('GET', g);
  ok(r.status < 500, `no server error for GET ${g}`);
}

// A scheduled post published through the callback a scheduler would fire.
const { getSignedAdminToken } = ghostRequire(path.join(process.env.GHOST_ROOT, 'core/server/adapters/scheduling/utils'));
const internalKeys = ghostRequire(path.join(process.env.GHOST_ROOT, 'core/server/services/internal-keys')).default.service;
const urlUtils = ghostRequire(path.join(process.env.GHOST_ROOT, 'core/shared/url-utils')).default;
r = await call('POST', '/posts/', { posts: [{ title: 'Scheduled local test', status: 'draft' }] });
const sp = r.json.posts[0];
const at = new Date(Date.now() + 5 * 60_000).toISOString();
r = await call('PUT', `/posts/${sp.id}/`, { posts: [{ status: 'scheduled', published_at: at, updated_at: sp.updated_at }] });
ok(r.status === 200 && r.json.posts[0].status === 'scheduled', 'schedule a post');
const apiUrl = urlUtils.urlFor('api', { type: 'admin' }, true);
const callbackUrl = `${apiUrl}schedules/posts/${sp.id}/?token=${getSignedAdminToken({ publishedAt: at, apiUrl, key: await internalKeys.get('ghost-scheduler') })}`;
const cb = await handler.callback({ url: callbackUrl });
console.log(`  ${cb.statusCode} scheduled callback ${String(cb.body).slice(0, 150)}`);
ok(cb.statusCode === 200, 'scheduled callback');
r = await call('GET', `/posts/${sp.id}/?fields=status`);
ok(r.json.posts[0].status === 'published', 'scheduled post is published by the callback');
ok(sent.length >= 1, `regeneration requested (${sent.length})`);
console.log('queue messages', sent.length);

// Staff sign-in (password check, session cookie), then a call that uses only the cookie.
const rawCall = (method, p, headers, body) => handler({
  version: '2.0', rawPath: `${base}/ghost/api/admin${p}`, rawQueryString: '',
  headers: { host: 'example.test', 'x-forwarded-proto': 'http', 'x-ghost-version': '6.73', 'content-type': 'application/json', origin: new URL(process.env.GHOST_URL).origin, ...headers },
  requestContext: { http: { method, path: `${base}/ghost/api/admin${p}`, sourceIp: '127.0.0.1' } },
  body: body ? JSON.stringify(body) : undefined, isBase64Encoded: false,
}, {});
const bad = await rawCall('POST', '/session/', {}, { username: owner.email, password: 'wrong' });
console.log(`  ${bad.statusCode} wrong password`);
ok(bad.statusCode === 422, 'wrong password is refused (422)');
const login = await rawCall('POST', '/session/', {}, { username: owner.email, password: SIGNIN_PASSWORD });
console.log(`  ${login.statusCode} sign-in ${String(login.body).slice(0, 200)}`);
ok(login.statusCode === 201, 'staff sign-in');
const cookie = (login.cookies ?? []).map((c) => c.split(';')[0]).join('; ') || String(login.headers?.['set-cookie'] ?? '').split(';')[0];
ok(cookie.includes('ghost-admin-api-session'), 'session cookie set');
const me = await rawCall('GET', '/users/me/', { cookie });
console.log(`  ${me.statusCode} users/me with the session cookie`);
ok(me.statusCode === 200, 'session cookie authenticates');
process.exit(process.exitCode ?? 0);
