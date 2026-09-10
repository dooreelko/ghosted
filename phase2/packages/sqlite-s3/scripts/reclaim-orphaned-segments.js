#!/usr/bin/env node
import { createS3ObjectStore } from '../src/object-store.js';
import { createManifestStore } from '../src/manifest.js';
import { createSegmentStore } from '../src/segments.js';
import { createLeaseStore } from '../src/leases.js';
import { reclaimOrphanedSegments } from '../src/reclaim.js';

async function main() {
  const bucket = process.env.SQLITE_S3_BUCKET;
  if (!bucket) {
    console.error('SQLITE_S3_BUCKET env var is required.');
    process.exit(1);
  }
  const execute = process.argv.includes('--execute');

  const objectStore = createS3ObjectStore({ bucket });
  const manifestStore = createManifestStore(objectStore);
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);

  const { scanned, deleted } = await reclaimOrphanedSegments({
    manifestStore,
    segmentStore,
    objectStore,
    leaseStore,
    dryRun: !execute,
  });

  if (!execute) {
    console.log(`Dry run against bucket "${bucket}": ${deleted.length} of ${scanned} segments would be deleted.`);
    console.log('Re-run with --execute to actually delete them.');
    return;
  }

  console.log(`Scanned ${scanned} segments in bucket "${bucket}", deleted ${deleted.length} orphans.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
