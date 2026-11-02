// Admin API locally: reads, a draft created and published, a tag, a delete, and the
// regeneration request a site-changing write leaves. Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInMemoryObjectStore, createManifestStore, createSegmentStore, seedStoreFromSqliteFile } from '@ghost-phase3/sqlite-s3';
import { createAdminHandler } from '../src/admin-app.mjs';

const ghostRequire = createRequire(path.join(process.env.GHOST_ROOT, 'core', 'x.js'));
const jwt = ghostRequire('jsonwebtoken');
const Database = ghostRequire('better-sqlite3');

const objectStore = createInMemoryObjectStore();
await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore: createManifestStore(objectStore), segmentStore: createSegmentStore(objectStore) });

// An integration's admin key signs the token; the key lives in the seeded database.
const key = new Database(process.env.SEED_DB, { readonly: true }).prepare("select id, secret from api_keys where type = 'admin' limit 1").get();
const token = () => jwt.sign({}, Buffer.from(key.secret, 'hex'), { keyid: key.id, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/' });

const sent = [];
const handler = await createAdminHandler({ objectStore, queue: { send: async (m) => sent.push(m) } });

const base = new URL(process.env.GHOST_URL).pathname.replace(/\/$/, '');
async function call(method, p, body) {
  const res = await handler({
    version: '2.0', rawPath: `${base}/ghost/api/admin${p.split('?')[0]}`, rawQueryString: p.split('?')[1] ?? '',
    headers: { host: 'example.test', 'x-forwarded-proto': 'http', authorization: `Ghost ${token()}`, 'content-type': 'application/json', origin: 'http://example.test' },
    requestContext: { http: { method, path: `${base}/ghost/api/admin${p}`, sourceIp: '127.0.0.1' } },
    body: body ? JSON.stringify(body) : undefined, isBase64Encoded: false,
  }, {});
  const text = res.isBase64Encoded ? Buffer.from(res.body, 'base64').toString() : res.body;
  let json; try { json = JSON.parse(text); } catch {}
  console.log(`  ${res.statusCode} ${method} ${p} ${json ? '' : String(text).slice(0, 100)}`);
  return { status: res.statusCode, json };
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
ok(sent.length >= 1, `regeneration requested (${sent.length})`);
console.log('queue messages', sent.length);
process.exit(process.exitCode ?? 0);
