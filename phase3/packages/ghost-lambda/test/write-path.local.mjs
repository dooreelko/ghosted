// Write path and freshness across processes, against a shared directory store.
// Parent: seeds the store, starts a long-lived reader (A) and a one-shot
// writer (W), then checks that W's write is in the store and that A picks it up.
// Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  createManifestStore, createSegmentStore, createLeaseStore, seedStoreFromSqliteFile, dumpStoreToSqliteFile,
} from '@ghost-phase3/sqlite-s3';
import { createFsObjectStore } from './fs-object-store.mjs';

const Database = createRequire(`${process.env.GHOST_ROOT}/package.json`)('better-sqlite3');
const [mode, storeDir, dataDir] = process.argv.slice(2);

const event = (method, path, body) => ({
  version: '2.0', rawPath: path, rawQueryString: '',
  headers: { host: 'example.test', accept: 'application/json', 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
  requestContext: { http: { method, path, sourceIp: '127.0.0.1' } },
  body: body ? JSON.stringify(body) : undefined, isBase64Encoded: false,
});
const counts = (db) => {
  const d = new Database(db, { readonly: true });
  const n = (t) => d.prepare(`select count(*) c from ${t}`).get().c;
  const out = { tokens: n('tokens'), members: n('members') };
  d.close();
  return out;
};

if (mode === 'child') {
  process.env.DATA_DIR = dataDir;
  process.env.FRESH_TTL_MS = '0';
  fs.mkdirSync(dataDir, { recursive: true });
  const { createMembersHandler } = await import('../src/members-session-app.mjs');
  const handler = await createMembersHandler({ objectStore: createFsObjectStore(storeDir) });
  const run = async (method, path, body) => {
    const r = await handler(event(method, path, body), {});
    return { status: r.statusCode, body: String(r.body).slice(0, 120) };
  };
  console.log('READY');
  if (process.argv[5] === 'once') {
    const it = await handler(event('GET', '/blog/members/api/integrity-token/'), {});
    const integrityToken = String(it.body);
    console.log('integrity token', it.statusCode, integrityToken.length);
    console.log('RESULT', JSON.stringify(await run('POST', '/blog/members/api/send-magic-link/', { email: 'reader@example.test', emailType: 'signup', name: 'Reader', integrityToken, requestSrc: 'portal' })));
    process.exit(0);
  }
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line === 'site') console.log('RESULT', JSON.stringify(await run('GET', '/blog/members/api/site/')));
    if (line === 'counts') console.log('RESULT', JSON.stringify(counts(`${dataDir}/ghost.db`)));
    if (line === 'quit') process.exit(0);
  }
} else {
  const store = createFsObjectStore('/tmp/lam-store');
  fs.rmSync('/tmp/lam-store', { recursive: true, force: true });
  const objectStore = createFsObjectStore('/tmp/lam-store');
  const manifestStore = createManifestStore(objectStore);
  const segmentStore = createSegmentStore(objectStore);
  await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore, segmentStore });
  const child = (dir, extra) => {
    const p = spawn('node', [new URL(import.meta.url).pathname, 'child', '/tmp/lam-store', dir, ...(extra ? [extra] : [])], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
    const lines = [];
    const waiters = [];
    readline.createInterface({ input: p.stdout }).on('line', (l) => { lines.push(l); waiters.shift()?.(); });
    const next = async () => { while (!lines.length) await new Promise((r) => waiters.push(r)); return lines.shift(); };
    return { p, next, send: (s) => p.stdin.write(s + '\n') };
  };
  const A = child('/tmp/lam-a');
  console.log('A', await A.next());
  A.send('counts'); console.log('A before write:', await A.next());
  const W = child('/tmp/lam-w', 'once');
  for (;;) { const l = await W.next(); console.log('W', l); if (l.startsWith('RESULT')) break; }
  await new Promise((r) => W.p.on('exit', r));
  const dump = '/tmp/lam-dump.db';
  fs.rmSync(dump, { force: true });
  await dumpStoreToSqliteFile({ manifestStore, segmentStore, leaseStore: createLeaseStore(objectStore), dbPath: dump });
  console.log('store after W:', counts(dump));
  A.send('site'); await A.next();
  A.send('counts'); console.log('A after next request:', await A.next());
  A.send('quit');
  process.exit(0);
}
