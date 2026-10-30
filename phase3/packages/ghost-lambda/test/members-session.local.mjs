// Local run of the members-session function against an in-memory store seeded
// from a migrated Ghost database. Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import {
  createInMemoryObjectStore, createManifestStore, createSegmentStore, seedStoreFromSqliteFile,
} from '@ghost-phase3/sqlite-s3';
import { createMembersHandler } from '../src/members-session-app.mjs';

const objectStore = createInMemoryObjectStore();
await seedStoreFromSqliteFile({
  dbPath: process.env.SEED_DB,
  manifestStore: createManifestStore(objectStore),
  segmentStore: createSegmentStore(objectStore),
});

const t0 = Date.now();
const handler = await createMembersHandler({ objectStore });
console.log(`init ${Date.now() - t0}ms rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);

const call = async (path, query = '') => {
  const s = Date.now();
  const res = await handler({
    version: '2.0',
    rawPath: path,
    rawQueryString: query,
    headers: { host: 'example.test', accept: 'application/json', 'x-forwarded-proto': 'https' },
    requestContext: { http: { method: 'GET', path, sourceIp: '127.0.0.1' } },
    isBase64Encoded: false,
  }, {});
  console.log(`  ${res.statusCode} ${path} ${Date.now() - s}ms ${String(res.body).slice(0, 60).replace(/\n/g, ' ')}`);
  return res;
};
await call('/blog/members/api/site/');
await call('/blog/members/api/member/');
await call('/blog/members/api/session/');
await call('/blog/members/api/comments/counts/', 'ids=abc');
await call('/blog/members/api/site/');
console.log(`rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
process.exit(0);
