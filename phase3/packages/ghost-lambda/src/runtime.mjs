// Shared boot for every Ghost-backed function: points Ghost at the S3-backed
// SQLite store, and keeps a warm environment's database fresh between requests.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  SqliteS3Client,
  registerS3Config,
  createManifestStore,
  createSegmentStore,
  createS3ObjectStore,
  createCheckpointPolicy,
  createLeaseStore,
  flushPendingShips,
  shipCount,
} from '@ghost-phase3/sqlite-s3';
import { findDatabaseInfoPaths, patchDatabaseInfoAt } from './database-info-patch.mjs';
import { buildMailConfig } from './mail-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The pruned Ghost tree sits one level above the function code in the zip.
export const ghostRoot = process.env.GHOST_ROOT ?? path.resolve(here, '../..');
export const R = (p) => require(path.join(ghostRoot, 'core', p));

const dbPath = path.join(process.env.DATA_DIR ?? '/tmp', 'ghost.db');
const FRESH_TTL_MS = Number(process.env.FRESH_TTL_MS ?? 30_000);

let store; // { manifestStore, objectStore }

// objectStore is injectable for tests; Lambda passes nothing and gets S3.
export async function configure({ objectStore } = {}) {
  process.chdir(ghostRoot);
  const region = process.env.AWS_REGION;
  objectStore ??= createS3ObjectStore({ bucket: process.env.STORE_BUCKET, client: new S3Client({ region }) });
  const manifestStore = createManifestStore(objectStore);
  store = { manifestStore, objectStore };

  for (const p of findDatabaseInfoPaths(ghostRoot)) patchDatabaseInfoAt(p, SqliteS3Client, require);

  const s3Config = {
    manifestStore,
    segmentStore: createSegmentStore(objectStore),
    // Checkpointing is the scheduled function's job; a request never starts one
    // of its own (a fire-and-forget checkpoint would be frozen mid-way).
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: Number.MAX_SAFE_INTEGER, maxIntervalMs: Number.MAX_SAFE_INTEGER }),
    leaseStore: createLeaseStore(objectStore),
  };
  registerS3Config(s3Config);

  const config = R('shared/config');
  config.set('database:client', SqliteS3Client);
  config.set('database:useNullAsDefault', true);
  config.set('database:connection', { filename: dbPath, s3: { ...s3Config, readerPoolSize: 2, acquireTimeoutMillis: 15000 } });
  config.set('url', process.env.GHOST_URL);
  config.set('logging:transports', ['stdout']);

  if (process.env.SMTP_PARAMETER_NAME) {
    const ssm = new SSMClient({ region });
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: process.env.SMTP_PARAMETER_NAME, WithDecryption: true }));
    config.set('mail', buildMailConfig({ user: process.env.MAIL_USER, pass: Parameter.Value }));
  }
  return config;
}

// Ghost services every Ghost-backed function needs (from the boot spike).
export async function initCore() {
  const config = R('shared/config');
  const DSM = R('server/data/db/database-state-manager');
  await new DSM({ knexMigratorFilePath: config.get('paths:appRoot') }).makeReady();
  await R('server/data/db/info').init();
  R('server/services/adapter-manager').default.init();
  R('shared/url-utils');
  await R('server/services/limits').init();
  await R('server/services/settings/settings-service').init();
  await R('server/services/i18n').init();
  R('server/services/gift-links').init();
  R('server/services/members-custom-fields').init();
}

export async function initMemberServices() {
  R('server/services/email-address').init();
  await R('server/services/stripe').init();
  await Promise.all([
    R('server/services/identity-tokens').init(),
    R('server/services/member-attribution').init(),
    R('server/services/members').init(),
    R('server/services/tiers').init(),
    R('server/services/members-events').init(),
    R('server/services/permissions').init(),
    R('server/services/comments').init(),
    R('server/services/email-suppression-list').init(),
    R('server/services/audience-feedback').init(),
  ]);
}

// Freshness: a warm environment reuses its restored database for at most
// FRESH_TTL_MS, then asks the manifest whether anything changed. A change
// (another function wrote) drops Ghost's single pooled connection, so the next
// query restores from the store, and the settings cache is reloaded.
let lastCheck = 0;
let knownEtag;

export async function ensureFresh() {
  const now = Date.now();
  if (now - lastCheck < FRESH_TTL_MS) return;
  lastCheck = now;
  const { etag } = await store.manifestStore.read();
  if (knownEtag !== undefined && etag !== knownEtag) {
    const knex = R('server/data/db').knex;
    await knex.destroy();
    knex.initialize();
    await R('server/services/settings/settings-service').init();
  }
  knownEtag = etag;
}

// Wraps one invocation: freshness check before, durable commit after. A write's
// ship to the store has to finish before the environment is frozen, and our own
// writes must not look like somebody else's change at the next check.
export async function withStore(run) {
  await ensureFresh();
  const before = shipCount();
  try {
    return await run();
  } finally {
    await flushPendingShips(dbPath);
    if (shipCount() !== before) {
      knownEtag = (await store.manifestStore.read()).etag;
      lastCheck = Date.now();
    }
  }
}
