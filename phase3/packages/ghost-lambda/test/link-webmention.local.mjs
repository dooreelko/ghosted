// Link redirect and webmention entries, locally. Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import { createInMemoryObjectStore, createManifestStore, createSegmentStore, seedStoreFromSqliteFile } from '@ghost-phase3/sqlite-s3';
import { createRequire } from 'node:module';
import { createLinkRedirectHandler } from '../src/link-redirect-app.mjs';

const Database = createRequire(`${process.env.GHOST_ROOT}/package.json`)('better-sqlite3');
const db = new Database(process.env.SEED_DB, { readonly: true });
const link = db.prepare('select `from`, `to` from redirects limit 1').get();
db.close();
console.log('link in database:', link ? `${link.from} -> ${String(link.to).slice(0, 50)}` : 'none');

const objectStore = createInMemoryObjectStore();
await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore: createManifestStore(objectStore), segmentStore: createSegmentStore(objectStore) });
const handler = await createLinkRedirectHandler({ objectStore });
const call = async (path) => {
  const res = await handler({ version: '2.0', rawPath: path, rawQueryString: '', headers: { host: 'example.test', 'x-forwarded-proto': 'http' },
    requestContext: { http: { method: 'GET', path, sourceIp: '127.0.0.1' } }, isBase64Encoded: false }, {});
  console.log(`  ${res.statusCode} ${path} -> ${res.headers?.location ?? ''}`);
};
if (link) await call(`/blog${link.from}`);
await call('/blog/r/does-not-exist');
process.exit(0);
