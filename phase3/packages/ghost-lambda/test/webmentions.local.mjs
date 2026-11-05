import { createInMemoryObjectStore, createManifestStore, createSegmentStore, seedStoreFromSqliteFile } from '@ghost-phase3/sqlite-s3';
import { createWebmentionsHandler } from '../src/webmentions-app.mjs';

const objectStore = createInMemoryObjectStore();
await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore: createManifestStore(objectStore), segmentStore: createSegmentStore(objectStore) });
const handler = await createWebmentionsHandler({ objectStore });
const res = await handler({ version: '2.0', rawPath: '/blog/webmentions/receive', rawQueryString: '', headers: { host: 'example.test', 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'http' },
  requestContext: { http: { method: 'POST', path: '/blog/webmentions/receive', sourceIp: '127.0.0.1' } }, body: 'source=http://a.invalid/&target=http://b.invalid/', isBase64Encoded: false }, {});
console.log(`  ${res.statusCode} POST /blog/webmentions/receive ${String(res.body).slice(0, 80)}`);
process.exit(0);
