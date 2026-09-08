import fs from 'node:fs';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import {
  SqliteS3Client,
  registerS3Config,
  createManifestStore,
  createSegmentStore,
  createS3ObjectStore,
  createCheckpointPolicy,
} from '@ghost-phase2/sqlite-s3';

const ghostCheckoutDir = process.env.GHOST_CHECKOUT_DIR;
const bucket = process.env.SQLITE_S3_BUCKET;
const region = process.env.SQLITE_S3_REGION;
if (!ghostCheckoutDir || !bucket || !region) {
  throw new Error('GHOST_CHECKOUT_DIR, SQLITE_S3_BUCKET and SQLITE_S3_REGION must be set');
}
const ghostCoreDir = path.join(ghostCheckoutDir, 'ghost/core');

const dataDir = process.env.SQLITE_S3_DATA_DIR ?? '/tmp/ghost-sqlite-s3';
fs.mkdirSync(dataDir, { recursive: true });

const objectStore = createS3ObjectStore({ bucket, client: new S3Client({ region }) });

// Ghost's ecosystem does string-based client-type detection in several
// places (Ghost core's connection.js, knex-migrator's database.js, and
// @tryghost/database-info) that a class-valued Knex `client` fails, since
// they check `config.client === 'better-sqlite3'` rather than duck-typing.
// database-info is a third-party dependency (not Ghost core) with a small,
// patchable static surface — monkey-patch every installed copy so it
// recognizes SqliteS3Client as SQLite-flavored. Multiple pnpm-resolved
// versions can coexist in the workspace, so patch each one found.
const require = (await import('node:module')).createRequire(import.meta.url);
function patchDatabaseInfoAt(absolutePath) {
  const DatabaseInfo = require(absolutePath);
  const origIsSQLite = DatabaseInfo.isSQLite;
  const origIsSQLiteConfig = DatabaseInfo.isSQLiteConfig;
  DatabaseInfo.isSQLite = (knex) =>
    knex.client.config.client === SqliteS3Client || origIsSQLite.call(DatabaseInfo, knex);
  DatabaseInfo.isSQLiteConfig = (config) =>
    config.client === SqliteS3Client || origIsSQLiteConfig.call(DatabaseInfo, config);
}
try {
  const pnpmDir = path.resolve(ghostCheckoutDir, 'node_modules/.pnpm');
  for (const entry of fs.readdirSync(pnpmDir)) {
    if (entry.startsWith('@tryghost+database-info@')) {
      patchDatabaseInfoAt(path.join(pnpmDir, entry, 'node_modules/@tryghost/database-info/index.js'));
    }
  }
} catch (err) {
  console.error('[ghost-sqlite-s3-launcher] could not patch @tryghost/database-info:', err.message);
}

const s3Config = {
  manifestStore: createManifestStore(objectStore),
  segmentStore: createSegmentStore(objectStore),
  checkpointPolicy: createCheckpointPolicy({
    maxWalBytes: Number(process.env.SQLITE_S3_MAX_WAL_BYTES ?? 50_000_000),
    maxIntervalMs: Number(process.env.SQLITE_S3_MAX_CHECKPOINT_INTERVAL_MS ?? 3_600_000),
  }),
};

// The process-wide registry is the reliable path (see knex-client.js) — some
// hosts construct additional Knex clients from an independently re-derived
// config copy that doesn't reliably carry nested function-valued objects.
registerS3Config(s3Config);

const configModule = await import(path.join(ghostCoreDir, 'core/shared/config/index.js'));
const config = configModule.default ?? configModule;

config.set('database:client', SqliteS3Client);
config.set('database:useNullAsDefault', true);
config.set('database:connection', {
  filename: path.join(dataDir, 'ghost.db'),
  s3: s3Config,
});
