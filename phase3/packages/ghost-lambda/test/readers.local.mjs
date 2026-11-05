// Preview and content API entries, locally, against an in-memory store seeded
// from a database. Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import { createInMemoryObjectStore, createManifestStore, createSegmentStore, seedStoreFromSqliteFile } from '@ghost-phase3/sqlite-s3';
import { createRenderApp } from '../src/render-app.mjs';
import { toHandler } from '../src/express-handler.mjs';
import { createRequire } from 'node:module';

const Database = createRequire(`${process.env.GHOST_ROOT}/package.json`)('better-sqlite3');
const db = new Database(process.env.SEED_DB, { readonly: true });
const key = db.prepare("select secret from api_keys where type='content' limit 1").get()?.secret;
const draft = db.prepare("select uuid, slug from posts where status='draft' limit 1").get();
db.close();

const objectStore = createInMemoryObjectStore();
await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore: createManifestStore(objectStore), segmentStore: createSegmentStore(objectStore) });
const { root } = await createRenderApp({ objectStore, api: true });
const handler = toHandler(root);
const call = async (path, query = '') => {
  const res = await handler({ version: '2.0', rawPath: path, rawQueryString: query, headers: { host: 'example.test', accept: '*/*', 'x-forwarded-proto': 'http' },
    requestContext: { http: { method: 'GET', path, sourceIp: '127.0.0.1' } }, isBase64Encoded: false }, {});
  console.log(`  ${res.statusCode} ${path}${query ? '?' + query.slice(0, 20) : ''} ${String(res.body).length}B ${String(res.body).slice(0, 60).replace(/\n/g, ' ')}`);
};
await call('/blog/ghost/api/content/posts/', `key=${key}&limit=2`);
await call('/blog/ghost/api/content/settings/', `key=${key}`);
await call('/blog/ghost/api/content/posts/', 'key=wrong');
if (draft) await call(`/blog/p/${draft.uuid}/`);
await call('/blog/unsubscribe/', 'uuid=none');
process.exit(0);
