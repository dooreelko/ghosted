// Local run of the generator against an in-memory store seeded from a migrated
// database, writing to an in-memory content store. Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import { createInMemoryObjectStore, createManifestStore, createSegmentStore, seedStoreFromSqliteFile } from '@ghost-phase3/sqlite-s3';
import { createMemoryContentStore } from '../src/content-store-memory.mjs';
import { createGeneratorHandler } from '../src/generator-app.mjs';

const objectStore = createInMemoryObjectStore();
await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore: createManifestStore(objectStore), segmentStore: createSegmentStore(objectStore) });
const contentStore = createMemoryContentStore();

const t0 = Date.now();
const handler = await createGeneratorHandler({ objectStore, contentStore });
console.log(`init ${Date.now() - t0}ms rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
const out = await handler({ Records: [{ body: '{}' }] }, {});
console.log('result', JSON.stringify(out));
for (const key of [...contentStore.objects.keys()].sort()) {
  const o = contentStore.objects.get(key);
  console.log(`  ${key}  ${o.contentType}  ${o.bytes.length}B`);
}
console.log(`rss=${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
process.exit(0);
