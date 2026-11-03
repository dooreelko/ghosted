// A store that needs a migration: every function refuses to start, the maintenance function
// starts anyway and migrates only when asked. Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInMemoryObjectStore, createManifestStore, createSegmentStore, seedStoreFromSqliteFile } from '@ghost-phase3/sqlite-s3';

const Database = createRequire(`${process.env.GHOST_ROOT}/core/x.js`)('better-sqlite3');
const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-seed-')), 'g.db');
fs.copyFileSync(process.env.SEED_DB, copy);
const db = new Database(copy);
const last = db.prepare("select id, name, version from migrations where version != 'init' order by id desc limit 1").get();
db.prepare('delete from migrations where id = ?').run(last.id);
db.close();
console.log('removed migration record', last.version, last.name);

const objectStore = createInMemoryObjectStore();
await seedStoreFromSqliteFile({ dbPath: copy, manifestStore: createManifestStore(objectStore), segmentStore: createSegmentStore(objectStore) });
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-data-'));

const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } };
const { createMaintenanceHandler } = await import('../src/maintenance-app.mjs');
const handler = await createMaintenanceHandler({ objectStore });
let err;
try { await handler({}, {}); } catch (e) { err = e; }
ok(err && /needs migration/.test(err.message), `a plain invocation on an unmigrated store refuses (${err?.message})`);
const r = await handler({ migrate: true }, {});
console.log('migrate result', JSON.stringify(r));
ok(r.migrated === true, 'migrate: true migrates');
const { assertMigrated } = await import('../src/runtime.mjs');
await assertMigrated();
console.log('store is migrated now');
process.exit(process.exitCode ?? 0);
