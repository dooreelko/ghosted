// Publishing a post to a newsletter asks the send function to run. It reads the email row the
// publish request wrote, so it must only be asked once that row is in the store.
// Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInMemoryObjectStore, createManifestStore, createSegmentStore, createLeaseStore, seedStoreFromSqliteFile, dumpStoreToSqliteFile } from '@ghost-phase3/sqlite-s3';

const ghostRequire = createRequire(path.join(process.env.GHOST_ROOT, 'core', 'x.js'));
const jwt = ghostRequire('jsonwebtoken');
const Database = ghostRequire('better-sqlite3');
const objectStore = createInMemoryObjectStore();
const manifestStore = createManifestStore(objectStore);
const segmentStore = createSegmentStore(objectStore);
await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore, segmentStore });
const seed = new Database(process.env.SEED_DB, { readonly: true });
const key = seed.prepare("select id, secret from api_keys where type = 'admin' limit 1").get();
const newsletter = seed.prepare("select slug from newsletters where status = 'active' limit 1").get();
const token = () => jwt.sign({}, Buffer.from(key.secret, 'hex'), { keyid: key.id, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/' });

process.env.EMAIL_SEND_FUNCTION = 'send-function';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
const dispatched = [];
const lambda = {
  send: async (cmd) => {
    const job = JSON.parse(cmd.input.Payload).job;
    // what the send function would see: the store as it is right now
    const dump = path.join(process.env.DATA_DIR, `dump-${dispatched.length}.db`);
    await dumpStoreToSqliteFile({ manifestStore, segmentStore, leaseStore: createLeaseStore(objectStore), dbPath: dump });
    const row = new Database(dump, { readonly: true }).prepare('select id, status from emails where id = ?').get(job.emailId);
    dispatched.push({ emailId: job.emailId, rowInStore: Boolean(row) });
  },
};
const { createAdminHandler } = await import('../src/admin-app.mjs');
const handler = await createAdminHandler({ objectStore, lambda, queue: { send: async () => {} } });
const base = new URL(process.env.GHOST_URL).pathname.replace(/\/$/, '');
const call = async (method, p, body) => {
  const res = await handler({
    version: '2.0', rawPath: `${base}/ghost/api/admin${p.split('?')[0]}`, rawQueryString: p.split('?')[1] ?? '',
    headers: { host: 'example.test', 'x-forwarded-proto': 'http', 'x-ghost-version': '6.73', authorization: `Ghost ${token()}`, 'content-type': 'application/json', origin: 'http://example.test' },
    requestContext: { http: { method, path: `${base}/ghost/api/admin${p}`, sourceIp: '127.0.0.1' } },
    body: body ? JSON.stringify(body) : undefined, isBase64Encoded: false,
  }, {});
  return { status: res.statusCode, json: (() => { try { return JSON.parse(res.body); } catch { return undefined; } })(), text: res.body };
};
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } };

let r = await call('POST', '/posts/', { posts: [{ title: 'Dispatch test', status: 'draft' }] });
ok(r.status === 201, 'create draft');
const post = r.json.posts[0];
r = await call('PUT', `/posts/${post.id}/?newsletter=${newsletter.slug}`, { posts: [{ status: 'published', updated_at: post.updated_at }] });
console.log('publish', r.status, r.text.slice(0, 200));
ok(r.status === 200, 'publish to the newsletter');
console.log('dispatched', JSON.stringify(dispatched));
ok(dispatched.length === 1, `the send function was asked once (${dispatched.length})`);
ok(dispatched[0]?.rowInStore, 'the email row was already in the store when the send function was asked');
process.exit(process.exitCode ?? 0);
