// Two admin copies save posts at the same time against one shared store. Every save that
// answered with success must be in the store afterwards (a lost race is replayed, not dropped).
// Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  createManifestStore, createSegmentStore, createLeaseStore, seedStoreFromSqliteFile, dumpStoreToSqliteFile,
} from '@ghost-phase3/sqlite-s3';
import { createFsObjectStore } from './fs-object-store.mjs';

const ghostRequire = createRequire(`${process.env.GHOST_ROOT}/core/x.js`);
const Database = ghostRequire('better-sqlite3');
const jwt = ghostRequire('jsonwebtoken');
const [mode, storeDir, dataDir, tag, count] = process.argv.slice(2);
const SAVES = 6;

if (mode === 'child') {
  process.env.DATA_DIR = dataDir;
  process.env.FRESH_TTL_MS = '0';
  process.env.WRITE_ATTEMPTS = '8';
  fs.mkdirSync(dataDir, { recursive: true });
  const key = new Database(process.env.SEED_DB, { readonly: true }).prepare("select id, secret from api_keys where type = 'admin' limit 1").get();
  const token = () => jwt.sign({}, Buffer.from(key.secret, 'hex'), { keyid: key.id, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/' });
  const { createAdminHandler } = await import('../src/admin-app.mjs');
  const handler = await createAdminHandler({ objectStore: createFsObjectStore(storeDir), queue: { send: async () => {} } });
  const base = new URL(process.env.GHOST_URL).pathname.replace(/\/$/, '');
  const save = async (title) => {
    const p = '/posts/';
    const r = await handler({
      version: '2.0', rawPath: `${base}/ghost/api/admin${p}`, rawQueryString: '',
      headers: { host: 'example.test', 'x-forwarded-proto': 'http', 'x-ghost-version': '6.73', authorization: `Ghost ${token()}`, 'content-type': 'application/json', origin: 'http://example.test' },
      requestContext: { http: { method: 'POST', path: `${base}/ghost/api/admin${p}`, sourceIp: '127.0.0.1' } },
      body: JSON.stringify({ posts: [{ title, status: 'draft' }] }), isBase64Encoded: false,
    }, {});
    return r.statusCode;
  };
  console.log('READY');
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line !== 'go') continue;
    const ok = [];
    for (let i = 0; i < Number(count); i += 1) { const title = `durable-${tag}-${i}`; if ((await save(title)) === 201) ok.push(title); }
    console.log('RESULT', JSON.stringify(ok));
    process.exit(0);
  }
} else {
  const dir = '/tmp/lam-durable-store';
  fs.rmSync(dir, { recursive: true, force: true });
  const objectStore = createFsObjectStore(dir);
  const manifestStore = createManifestStore(objectStore);
  const segmentStore = createSegmentStore(objectStore);
  await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore, segmentStore });
  const child = (data, tag) => {
    const p = spawn('node', [new URL(import.meta.url).pathname, 'child', dir, data, tag, String(SAVES)], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
    const lines = []; const waiters = [];
    readline.createInterface({ input: p.stdout }).on('line', (l) => { lines.push(l); waiters.shift()?.(); });
    return { p, next: async () => { while (!lines.length) await new Promise((r) => waiters.push(r)); return lines.shift(); }, go: () => p.stdin.write('go\n') };
  };
  const A = child('/tmp/lam-durable-a', 'a');
  const B = child('/tmp/lam-durable-b', 'b');
  console.log('A', await A.next(), 'B', await B.next());
  A.go(); B.go();
  const results = [];
  for (const c of [A, B]) { let l; do { l = await c.next(); } while (!l.startsWith('RESULT')); results.push(...JSON.parse(l.slice(7))); }
  const dump = '/tmp/lam-durable-dump.db';
  fs.rmSync(dump, { force: true });
  await dumpStoreToSqliteFile({ manifestStore, segmentStore, leaseStore: createLeaseStore(objectStore), dbPath: dump });
  const have = new Set(new Database(dump, { readonly: true }).prepare("select title from posts where title like 'durable-%'").all().map((r) => r.title));
  const missing = results.filter((t) => !have.has(t));
  console.log(`saves answered 201: ${results.length}, in the store: ${results.length - missing.length}`, missing.length ? `MISSING ${missing}` : '');
  if (results.length < SAVES || missing.length) { console.error('FAIL: an acknowledged save is not in the store (or too few saved)'); process.exit(1); }
  process.exit(0);
}
