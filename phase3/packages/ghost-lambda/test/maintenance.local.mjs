// Maintenance and checkpoint entries, locally. Needs GHOST_ROOT, SEED_DB, GHOST_URL.
import { createInMemoryObjectStore, createManifestStore, createSegmentStore, seedStoreFromSqliteFile } from '@ghost-phase3/sqlite-s3';
import { createMaintenanceHandler } from '../src/maintenance-app.mjs';
import { createCheckpointHandler } from '../src/checkpoint-app.mjs';

const objectStore = createInMemoryObjectStore();
await seedStoreFromSqliteFile({ dbPath: process.env.SEED_DB, manifestStore: createManifestStore(objectStore), segmentStore: createSegmentStore(objectStore) });
console.log('checkpoint', JSON.stringify(await createCheckpointHandler({ objectStore })()));
const handler = await createMaintenanceHandler({ objectStore });
console.log('maintenance', JSON.stringify(await handler({}, {})));
console.log('checkpoint after', JSON.stringify(await createCheckpointHandler({ objectStore })()));
process.exit(0);
