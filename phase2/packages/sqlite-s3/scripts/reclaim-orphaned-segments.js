#!/usr/bin/env node
import { createS3ObjectStore } from '../src/object-store.js';
import { createManifestStore } from '../src/manifest.js';
import { createSegmentStore } from '../src/segments.js';
import { createLeaseStore } from '../src/leases.js';
import { reclaimOrphanedSegments } from '../src/reclaim.js';

const SEGMENT_PREFIX = 'segments/';
const SEGMENT_SUFFIX = '.seg';

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

  if (!execute) {
    const { manifest } = await manifestStore.read();
    const reachable = new Set(
      [manifest?.baseSegmentId, ...(manifest?.walSegmentIds ?? [])].filter(Boolean)
    );
    const protectedIds = await leaseStore.listActiveSegmentIds();
    const allKeys = await objectStore.list(SEGMENT_PREFIX);
    const orphaned = allKeys.filter((key) => {
      const id = key.slice(SEGMENT_PREFIX.length, key.length - SEGMENT_SUFFIX.length);
      return !reachable.has(id) && !protectedIds.has(id);
    });
    console.log(`Dry run against bucket "${bucket}": ${orphaned.length} of ${allKeys.length} segments would be deleted.`);
    console.log('Re-run with --execute to actually delete them.');
    return;
  }

  const { scanned, deleted } = await reclaimOrphanedSegments({ manifestStore, segmentStore, objectStore, leaseStore });
  console.log(`Scanned ${scanned} segments in bucket "${bucket}", deleted ${deleted.length} orphans.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
