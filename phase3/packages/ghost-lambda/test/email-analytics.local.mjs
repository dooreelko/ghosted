// The scheduled Mailgun events poll: one invocation fetches the events and stores an open.
// Mailgun is a local stand-in; the seed database's Mailgun settings are pointed at it.
// Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInMemoryObjectStore, createManifestStore, createSegmentStore, createLeaseStore, seedStoreFromSqliteFile, dumpStoreToSqliteFile } from '@ghost-phase3/sqlite-s3';

const ghostRequire = createRequire(path.join(process.env.GHOST_ROOT, 'core', 'x.js'));
const Database = ghostRequire('better-sqlite3');
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } };

let EMAIL_ID;
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  res.setHeader('content-type', 'application/json');
  // first call: one open; every later page: nothing
  const items = requests.length === 1 ? [{
    id: 'evt1', event: 'opened', timestamp: Date.now() / 1000 - 60, recipient: 'reader@example.test',
    message: { headers: { 'message-id': 'practice@mg.example.test' } }, 'user-variables': { 'email-id': EMAIL_ID },
  }] : [];
  const page = (n) => `http://${req.headers.host}/v3/mg.example.test/events/${n}`;
  res.end(JSON.stringify({ items, paging: { next: page('next'), previous: page('previous'), first: page('first'), last: page('last') } }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// A seed copy with the stand-in as Mailgun and one recipient who has not opened yet.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-'));
const seedPath = path.join(work, 'seed.db');
fs.copyFileSync(process.env.SEED_DB, seedPath);
const db = new Database(seedPath);
const setting = db.prepare('update settings set value = ? where key = ?');
setting.run('key-test', 'mailgun_api_key');
setting.run('mg.example.test', 'mailgun_domain');
setting.run(`http://127.0.0.1:${server.address().port}`, 'mailgun_base_url');
const model = db.prepare('select * from email_recipients limit 1').get();
EMAIL_ID = model.email_id;
db.prepare('insert into email_recipients (id, email_id, member_id, batch_id, processed_at, member_uuid, member_email) values (?, ?, ?, ?, ?, ?, ?)')
  .run('6000000000000000000000aa', model.email_id, model.member_id, model.batch_id, model.processed_at, model.member_uuid, 'reader@example.test');
db.close();

const objectStore = createInMemoryObjectStore();
const manifestStore = createManifestStore(objectStore);
const segmentStore = createSegmentStore(objectStore);
await seedStoreFromSqliteFile({ dbPath: seedPath, manifestStore, segmentStore });

process.env.DATA_DIR = work;
const { createEmailAnalyticsHandler } = await import('../src/email-analytics-app.mjs');
const handler = await createEmailAnalyticsHandler({ objectStore });
const result = await handler({ source: 'schedule' }, {});
console.log('result', JSON.stringify(result), 'mailgun requests', requests.length);
ok(requests.length >= 1 && requests[0].includes('/events'), 'the Mailgun events API was asked');

// what the next function would see: the store as it is right now
const dump = path.join(work, 'after.db');
await dumpStoreToSqliteFile({ manifestStore, segmentStore, leaseStore: createLeaseStore(objectStore), dbPath: dump });
const after = new Database(dump, { readonly: true });
const row = after.prepare('select opened_at from email_recipients where id = ?').get('6000000000000000000000aa');
console.log('recipient after', JSON.stringify(row));
ok(row?.opened_at, 'the open was stored for the recipient');
server.close();
process.exit(process.exitCode ?? 0);
