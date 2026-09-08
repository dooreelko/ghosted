import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';
import {
  SqliteS3Client,
  registerS3Config,
  createManifestStore,
  createSegmentStore,
  createS3ObjectStore,
  createCheckpointPolicy,
} from '@ghost-phase2/sqlite-s3';
import { findDatabaseInfoPaths, patchDatabaseInfoAt } from './database-info-patch.mjs';
import { writeCredentialProcessProfile } from './aws-credentials.mjs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { buildMailConfig } from './mail-config.mjs';
import { buildS3StorageConfig } from './storage-config.mjs';

const ghostCheckoutDir = process.env.GHOST_CHECKOUT_DIR;
const bucket = process.env.SQLITE_S3_BUCKET;
const region = process.env.SQLITE_S3_REGION;
if (!ghostCheckoutDir || !bucket || !region) {
  throw new Error('GHOST_CHECKOUT_DIR, SQLITE_S3_BUCKET and SQLITE_S3_REGION must be set');
}
const ghostCoreDir = ghostCheckoutDir; // GHOST_CHECKOUT_DIR now names the dir containing core/ directly

const dataDir = process.env.SQLITE_S3_DATA_DIR ?? '/tmp/ghost-sqlite-s3';
fs.mkdirSync(dataDir, { recursive: true });

const roleArn = process.env.AWS_ROLE_ARN;
if (!roleArn) {
  throw new Error('AWS_ROLE_ARN must be set');
}
const awsConfigPath = process.env.AWS_CONFIG_FILE ?? '/tmp/ghost-aws-config';
const helperScriptPath = fileURLToPath(new URL('./assume-role-credential-process.mjs', import.meta.url));
writeCredentialProcessProfile({
  configPath: awsConfigPath,
  profileName: 'ghost-phase2',
  roleArn,
  helperScriptPath,
  region,
});
process.env.AWS_CONFIG_FILE = awsConfigPath;
process.env.AWS_SDK_LOAD_CONFIG = '1';
process.env.AWS_PROFILE = 'ghost-phase2';

// One shared, explicitly-instantiated credential provider for every client
// this file constructs itself, instead of leaving each on the SDK's default
// chain (which would resolve — and cache — credentials independently per
// client, each triggering its own credential_process subprocess spawn).
// fromIni's result memoizes internally (respects the STS response's
// Expiration), so passing this same instance to both clients below means
// they share one cache: one spawn per token lifetime instead of two. Ghost's
// own S3Storage adapter (constructed elsewhere, not by this file) still uses
// the ambient default chain — that spawn is unavoidable.
const sharedCredentials = fromIni({ profile: 'ghost-phase2', configFilepath: awsConfigPath });

const objectStore = createS3ObjectStore({ bucket, client: new S3Client({ region, credentials: sharedCredentials }) });

// Ghost's ecosystem does string-based client-type detection in several
// places (Ghost core's connection.js, knex-migrator's database.js, and
// @tryghost/database-info) that a class-valued Knex `client` fails, since
// they check `config.client === 'better-sqlite3'` rather than duck-typing.
// database-info is a third-party dependency (not Ghost core) with a small,
// patchable static surface — monkey-patch every installed copy so it
// recognizes SqliteS3Client as SQLite-flavored. Multiple pnpm-resolved
// versions can coexist in the workspace, so patch each one found.
const require = (await import('node:module')).createRequire(import.meta.url);
for (const dbInfoPath of findDatabaseInfoPaths(ghostCheckoutDir)) {
  try {
    patchDatabaseInfoAt(dbInfoPath, SqliteS3Client, require);
  } catch (err) {
    console.error(`[ghost-sqlite-s3-launcher] could not patch ${dbInfoPath}:`, err.message);
  }
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

const mailParamName = process.env.MAIL_SSM_PARAM_NAME ?? 'ghost_imap_token';
const ssm = new SSMClient({ region, credentials: sharedCredentials });
const mailParam = await ssm.send(new GetParameterCommand({ Name: mailParamName, WithDecryption: true }));
// The existing SSM parameter stores "user:password" as its value (see
// phase1/jpjiy's mail-credential handling) — split on the first colon.
const [mailUser, ...mailPassParts] = mailParam.Parameter.Value.split(':');
config.set('mail', buildMailConfig({ user: mailUser, pass: mailPassParts.join(':') }));

const ghostUrl = process.env.GHOST_URL;
if (!ghostUrl) {
  throw new Error('GHOST_URL must be set');
}
config.set('url', ghostUrl);

config.set('storage:active', 'S3Storage');
config.set(
  'storage:S3Storage',
  buildS3StorageConfig({ bucket, region, cdnUrl: `https://${bucket}.s3.${region}.amazonaws.com` })
);
