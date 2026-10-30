#!/usr/bin/env node
// Materialise an S3-backed sqlite-s3 store as a plain SQLite file.
//
//   node bin/dump-to-sqlite.mjs --bucket my-bucket --out ./dumped.db [--region us-east-1]
//
// This is both the validation tool (compare against the migration source) and
// the store's disaster-recovery path.
import { S3Client } from '@aws-sdk/client-s3';
import { createS3ObjectStore } from '../src/object-store.js';
import { createManifestStore } from '../src/manifest.js';
import { createSegmentStore } from '../src/segments.js';
import { createLeaseStore } from '../src/leases.js';
import { dumpStoreToSqliteFile } from '../src/dump.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

async function main() {
  const { bucket, out: dbPath, region = 'us-east-1' } = parseArgs(process.argv.slice(2));
  if (!bucket || !dbPath) {
    console.error('usage: dump-to-sqlite.mjs --bucket <bucket> --out <file.db> [--region <region>]');
    process.exit(1);
  }

  const store = createS3ObjectStore({ bucket, client: new S3Client({ region }) });
  const result = await dumpStoreToSqliteFile({
    manifestStore: createManifestStore(store),
    segmentStore: createSegmentStore(store),
    leaseStore: createLeaseStore(store),
    dbPath,
  });

  console.log(JSON.stringify({ ok: true, bucket, path: dbPath, bytes: result.bytes }));
}

main().catch((err) => {
  console.error(`dump failed: ${err.message}`);
  process.exit(1);
});
