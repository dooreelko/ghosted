// What does a cold boot write? Boot twice on one store (two processes; the second sees a complete
// store, like a warm one), print the WAL segments each boot added and the rows that differ.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createManifestStore, createSegmentStore, createLeaseStore, seedStoreFromSqliteFile, dumpStoreToSqliteFile } from '@ghost-phase3/sqlite-s3';
import { createFsObjectStore } from './fs-object-store.mjs';
const Database = createRequire(`${process.env.GHOST_ROOT}/core/x.js`)('better-sqlite3');
const dir = '/tmp/lam-boot-store';
if (process.argv[2] !== 'boot') fs.rmSync(dir, { recursive: true, force: true });
const os = createFsObjectStore(dir); const m = createManifestStore(os); const s = createSegmentStore(os);
console.log('start');
const wal = async () => (await m.read()).manifest.walSegmentIds.length;
const dump = async (to) => { fs.rmSync(to, { force: true }); await dumpStoreToSqliteFile({ manifestStore: m, segmentStore: s, leaseStore: createLeaseStore(os), dbPath: to }); };
const rows = (db, t) => db.prepare(`select * from ${t}`).all().map((r) => JSON.stringify(r));
const tables = (db) => db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map((r) => r.name);

if (process.argv[2] === 'boot') {
  process.env.DATA_DIR = `/tmp/lam-boot-data-${process.argv[3]}`;
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  const { createAdminHandler } = await import('../src/admin-app.mjs');
  await createAdminHandler({ objectStore: os, queue: { send: async () => {} } });
  process.exit(0);
}
console.log('seeding');
await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore: m, segmentStore: s });
console.log('seeded');
let prev = '/tmp/lam-boot-seed.db'; fs.copyFileSync(process.env.SEED_DB, prev);
for (const n of ['first', 'second']) {
  console.log('booting', n); const w0 = await wal();
  const r = spawnSync('node', [new URL(import.meta.url).pathname, 'boot', n], { env: n === 'second' ? { ...process.env, DEBUG: 'knex:query' } : process.env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status) process.exit(r.status);
  const cur = `/tmp/lam-boot-${n}.db`; await dump(cur);
  console.log(`${n} boot: ${await wal() - w0} WAL segment(s) shipped`);
  const a = new Database(prev, { readonly: true }); const b = new Database(cur, { readonly: true });
  for (const t of tables(a)) {
    const ra = new Set(rows(a, t)); const diff = rows(b, t).filter((x) => !ra.has(x));
    if (diff.length) console.log(`  ${t}: ${diff.length} row(s) differ`, diff.slice(0, 2).map((x) => x.slice(0, 120)));
  }
  if (n === 'second') { const shipped = await wal() - w0; if (shipped !== 0) { console.error(`FAIL: a boot on a complete store shipped ${shipped} segment(s)`); process.exit(1); } }
  prev = cur;
}
process.exit(0);
