// Shared boot for every Ghost-backed function: points Ghost at the S3-backed
// SQLite store, and keeps a warm environment's database fresh between requests.
import fs from 'node:fs';
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
import { buildMailConfig } from './mail-config.mjs';

// Ghost picks its config file by NODE_ENV (the Ghost image sets it; Lambda does not).
process.env.NODE_ENV ??= 'production';

// Init timing: one JSON log line per cold start, so the cold start can be split
// into its parts from the function's logs.
const startedAt = Date.now();
const marks = [['node_start_to_runtime_load', Math.round(process.uptime() * 1000)]];
export const mark = (name, extra) => marks.push([name, Date.now() - startedAt, ...(extra === undefined ? [] : [extra])]);
export const reportMarks = () => console.log(JSON.stringify({ initTiming: marks }));

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The pruned Ghost tree sits one level above the function code in the zip.
export const ghostRoot = process.env.GHOST_ROOT ?? path.resolve(here, '../..');
export const R = (p) => require(path.join(ghostRoot, 'core', p));

const dbPath = path.join(process.env.DATA_DIR ?? '/tmp', 'ghost.db');
const FRESH_TTL_MS = Number(process.env.FRESH_TTL_MS ?? 30_000);

let store; // { manifestStore, objectStore }
let lastCheck = 0;
let knownEtag;
let shipsAtConfigure = 0;

// objectStore is injectable for tests; Lambda passes nothing and gets S3.
export async function configure({ objectStore } = {}) {
  process.chdir(ghostRoot);
  // The code is read-only on Lambda; Ghost wants a content directory that exists.
  // Must be set before Ghost's config is first loaded.
  const contentPath = (process.env.paths__contentPath ??= path.join(process.env.DATA_DIR ?? '/tmp', 'content'));
  for (const d of ['', 'themes', 'data', 'logs', 'public']) fs.mkdirSync(path.join(contentPath, d), { recursive: true });
  const region = process.env.AWS_REGION;
  objectStore ??= createS3ObjectStore({ bucket: process.env.STORE_BUCKET, client: new S3Client({ region }) });
  const manifestStore = createManifestStore(objectStore);
  store = { manifestStore, objectStore };
  // Read before the first restore: a write that lands after this point shows up
  // as a changed etag at the first check, never as a missed one.
  knownEtag = (await manifestStore.read()).etag;
  shipsAtConfigure = shipCount();

  useS3Dialect();

  const s3Config = {
    manifestStore,
    segmentStore: createSegmentStore(objectStore),
    // Checkpointing is the scheduled function's job; a request never starts one
    // of its own (a fire-and-forget checkpoint would be frozen mid-way).
    checkpointPolicy: createCheckpointPolicy({ maxWalBytes: Number.MAX_SAFE_INTEGER, maxIntervalMs: Number.MAX_SAFE_INTEGER }),
    leaseStore: createLeaseStore(objectStore),
    onRestoreComplete: ({ attempts, durationMs }) => mark('store_restore_ms', durationMs),
  };
  registerS3Config(s3Config);

  const config = R('shared/config');
  // The client stays the string Ghost's own checks expect; the store wiring
  // reaches SqliteS3Client through registerS3Config above, since Ghost's config
  // deep-clones what it holds (functions do not survive that).
  config.set('database:client', 'better-sqlite3');
  config.set('database:useNullAsDefault', true);
  config.set('database:connection', { filename: dbPath });
  config.set('url', process.env.GHOST_URL);
  config.set('logging:transports', ['stdout']);

  if (process.env.SMTP_PARAMETER_NAME) {
    const ssm = new SSMClient({ region });
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: process.env.SMTP_PARAMETER_NAME, WithDecryption: true }));
    config.set('mail', buildMailConfig({ user: process.env.MAIL_USER, pass: Parameter.Value }));
  }
  mark('smtp_parameter');
  return config;
}

// Ghost (and knex-migrator) resolve the 'better-sqlite3' client by requiring
// knex's own dialect module. Swap that module's export for the S3-backed client
// in every installed copy of knex, before Ghost first asks for it.
function useS3Dialect() {
  const pnpm = path.join(ghostRoot, 'node_modules', '.pnpm');
  const copies = fs.readdirSync(pnpm).filter((d) => d.startsWith('knex@'));
  if (!copies.length) throw new Error('no knex found under the Ghost tree');
  for (const d of copies) {
    const dialect = path.join(pnpm, d, 'node_modules/knex/lib/dialects/better-sqlite3/index.js');
    require(dialect);
    require.cache[dialect].exports = SqliteS3Client;
  }
}

// A service module's export, whether it is the module itself or its default.
export const svc = (p) => {
  const m = R(p);
  return m.default ?? m;
};

// Ghost services every Ghost-backed function needs: the order and the
// selection follow core/boot.js of the bundled release (6.73).
export async function initCore() {
  const config = R('shared/config');
  const DSM = R('server/data/db/database-state-manager');
  await new DSM({ knexMigratorFilePath: config.get('paths:appRoot') }).makeReady();
  mark('database_ready');
  await R('server/data/db/info').init();
  svc('server/services/adapter-manager').init();
  R('shared/url-utils');
  await svc('server/services/limits').init();
  await svc('server/services/settings/settings-service').init();
  await svc('server/services/signing-keys').init();
  await svc('server/services/internal-keys').init();
  await svc('server/services/i18n').init();
  await svc('server/services/gift-links').init();
  svc('server/services/members-metafields').init();
  await svc('server/services/stripe-checkout-config').init();
  mark('core_services');
}

export async function initMemberServices() {
  svc('server/services/email-address').init();
  await svc('server/services/stripe').init();
  await svc('server/services/member-attribution').init();
  await svc('server/services/audience-feedback').init();
  await Promise.all([
    svc('server/services/identity-tokens').init(),
    svc('server/services/members').init(),
    svc('server/services/tiers').init(),
    svc('server/services/members-events').init(),
    svc('server/services/permissions').init(),
    svc('server/services/comments').init(),
    svc('server/services/email-suppression-list').init(),
  ]);
  mark('member_services');
}

// Call once initialization is done. Boot itself can write (Ghost fills in
// settings defaults); those writes are ours, not another function's.
export async function markReady() {
  await flushPendingShips(dbPath);
  mark('boot_writes_flushed');
  if (shipCount() !== shipsAtConfigure) knownEtag = (await store.manifestStore.read()).etag;
}

// Freshness: a warm environment reuses its restored database for at most
// FRESH_TTL_MS, then asks the manifest whether anything changed. A change
// (another function wrote) drops Ghost's single pooled connection, so the next
// query restores from the store, and the settings cache is reloaded.

export async function ensureFresh() {
  const now = Date.now();
  if (now - lastCheck < FRESH_TTL_MS) return;
  lastCheck = now;
  const { etag } = await store.manifestStore.read();
  if (etag !== knownEtag) {
    if (process.env.DEBUG_FRESH) console.error('fresh: manifest changed, reconnecting');
    const knex = R('server/data/db').knex;
    await knex.destroy();
    knex.initialize();
    await knex.raw('select 1'); // acquire now, which restores from the store
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
