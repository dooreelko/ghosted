#!/usr/bin/env node
// Seed an S3-backed sqlite-s3 store from a plain SQLite file.
//
//   node bin/seed-from-sqlite.mjs --db ./snapshot.db --bucket my-bucket [--region us-east-1]
//
// Fails if the store already holds a manifest. There is no --force.
import { S3Client } from '@aws-sdk/client-s3';
import { createS3ObjectStore } from '../src/object-store.js';
import { createManifestStore } from '../src/manifest.js';
import { createSegmentStore } from '../src/segments.js';
import { seedStoreFromSqliteFile } from '../src/seed.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

async function main() {
  const { db: dbPath, bucket, region = 'us-east-1' } = parseArgs(process.argv.slice(2));
  if (!dbPath || !bucket) {
    console.error('usage: seed-from-sqlite.mjs --db <file.db> --bucket <bucket> [--region <region>]');
    process.exit(1);
  }

  const store = createS3ObjectStore({ bucket, client: new S3Client({ region }) });
  const result = await seedStoreFromSqliteFile({
    dbPath,
    manifestStore: createManifestStore(store),
    segmentStore: createSegmentStore(store),
  });

  console.log(
    JSON.stringify({
      ok: true,
      bucket,
      baseSegmentId: result.baseSegmentId,
      pageSize: result.pageSize,
      bytes: result.bytes,
    })
  );
}

main().catch((err) => {
  console.error(`seed failed: ${err.message}`);
  process.exit(1);
});
