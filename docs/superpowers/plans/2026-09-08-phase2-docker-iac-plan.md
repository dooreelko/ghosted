# Phase 2 Docker Image + IaC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production Ghost image carrying the S3-backed-SQLite integration, and stand up (and actually apply) the OpenTofu-managed AWS infra — S3 bucket, private ECR repo, IAM, Lightsail Container Service — to run it, per moth hnj9a.

**Architecture:** Two-stage Docker build (Ghost's own upstream `Dockerfile.production` unmodified, then a thin launcher layer on top). The launcher preload grows three boot-time jobs: DB wiring (already existed, from moth yofwh), AWS credentials via a `credential_process` profile, and mail + image-storage config. OpenTofu under `phase2/iac/`, one file per component, flat local state, applied for real.

**Tech Stack:** Docker, OpenTofu (via nix), AWS CLI, Node.js (launcher), AWS SDK v3 (`@aws-sdk/client-sts`, `@aws-sdk/client-ssm`, `@aws-sdk/client-s3`).

**Spec:** `docs/superpowers/specs/2026-09-08-phase2-docker-iac-design.md`

## Global Constraints

- Region: `us-east-1` for every new resource.
- Tag: `app:ghost-phase2` on every new AWS resource.
- Never patch Ghost's own source or `Dockerfile.production` — all integration is a layer on top or runtime config.
- IAM app-runtime role trust policy: **no `sts:ExternalId`** (per design doc; flag immediately if `tofu apply`/first boot shows this doesn't work — don't silently add it back without noting the correction).
- Real AWS resource identifiers (bucket name, ECR repo URI, role ARNs, service name) go in `.local-secrets.md` under a new "Phase 2 Docker/IaC (moth hnj9a)" heading — never in tracked files. Reference them elsewhere by role/tag.
- No CloudFront/DNS changes, no content/DB migration — out of scope (moth i8hlt).
- `moth update hnj9a` is allowed and expected (decision record); `moth start`/`moth done` are never run by the implementer.

---

### Task 1: Fix launcher's Ghost-path semantics + extract testable helpers

The current `GHOST_CHECKOUT_DIR` env var means "monorepo root, `ghost/core` appended" — true only for the dev-mode smoke-test layout. The production image (built in Task 5) has a flat `pnpm deploy` layout: `core/` sits directly under the app root (`/home/ghost`), no `ghost/core` nesting. Redefine the env var to mean "directory that directly contains `core/`" and fix the one caller that assumed the old meaning.

**Files:**
- Modify: `phase2/packages/ghost-sqlite-s3-launcher/src/preload.mjs`
- Modify: `phase2/packages/sqlite-s3/smoke/docker-compose.smoke.yaml` (env var value, not the launcher this compose file itself doesn't use — see Task 4, this task only touches the launcher)
- Create: `phase2/packages/ghost-sqlite-s3-launcher/src/database-info-patch.mjs`
- Create: `phase2/packages/ghost-sqlite-s3-launcher/test/database-info-patch.test.mjs`
- Modify: `phase2/packages/ghost-sqlite-s3-launcher/package.json` (add `"test": "node --test"` script)

**Interfaces:**
- Produces: `findDatabaseInfoPaths(nodeModulesRoot: string): string[]` — exported from `database-info-patch.mjs`, returns absolute paths to every installed `@tryghost/database-info/index.js` found under `<nodeModulesRoot>/.pnpm`, discovered by directory-name prefix match, empty array if the `.pnpm` dir doesn't exist. Also exports `patchDatabaseInfoAt(absolutePath: string, SqliteS3Client: Function): void` (same monkeypatch logic already in `preload.mjs`, moved here so it's independently testable/reusable).
- Consumes (Task 1 has no upstream deps — first task).

- [ ] **Step 1: Write the failing test for path discovery**

```javascript
// phase2/packages/ghost-sqlite-s3-launcher/test/database-info-patch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findDatabaseInfoPaths } from '../src/database-info-patch.mjs';

test('findDatabaseInfoPaths finds every @tryghost/database-info copy under .pnpm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbinfo-test-'));
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  const versionDirs = [
    '@tryghost+database-info@0.3.35',
    '@tryghost+database-info@2.3.12',
    'some-other-package@1.0.0',
  ];
  for (const dir of versionDirs) {
    const target = path.join(pnpmDir, dir, 'node_modules', '@tryghost', 'database-info');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'index.js'), 'module.exports = {};');
  }

  const found = findDatabaseInfoPaths(root);

  assert.equal(found.length, 2);
  assert.ok(found.every((p) => p.endsWith('database-info/index.js')));
  assert.ok(found.some((p) => p.includes('0.3.35')));
  assert.ok(found.some((p) => p.includes('2.3.12')));
});

test('findDatabaseInfoPaths returns empty array when .pnpm is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbinfo-test-empty-'));
  assert.deepEqual(findDatabaseInfoPaths(root), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/database-info-patch.test.mjs`
Expected: FAIL — `database-info-patch.mjs` doesn't exist yet (Cannot find module).

- [ ] **Step 3: Write `database-info-patch.mjs`**

```javascript
// phase2/packages/ghost-sqlite-s3-launcher/src/database-info-patch.mjs
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every installed copy of @tryghost/database-info under <nodeModulesRoot>/.pnpm
 * (a pnpm virtual store can hold multiple resolved versions at once). Returns
 * absolute paths to each version's index.js. Empty array if .pnpm is absent.
 */
export function findDatabaseInfoPaths(nodeModulesRoot) {
  const pnpmDir = path.join(nodeModulesRoot, 'node_modules', '.pnpm');
  let entries;
  try {
    entries = fs.readdirSync(pnpmDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith('@tryghost+database-info@'))
    .map((entry) => path.join(pnpmDir, entry, 'node_modules', '@tryghost', 'database-info', 'index.js'));
}

/**
 * Ghost's ecosystem does string-based client-type detection in several places
 * (Ghost core's connection.js, knex-migrator's database.js, and
 * @tryghost/database-info) that a class-valued Knex `client` fails, since they
 * check `config.client === 'better-sqlite3'` rather than duck-typing. Patch this
 * one installed copy of database-info so it recognizes SqliteS3Client too.
 */
export function patchDatabaseInfoAt(absolutePath, SqliteS3Client) {
  const require = (globalThis.require ?? (0, eval)('require'));
  const DatabaseInfo = require(absolutePath);
  const origIsSQLite = DatabaseInfo.isSQLite;
  const origIsSQLiteConfig = DatabaseInfo.isSQLiteConfig;
  DatabaseInfo.isSQLite = (knex) =>
    knex.client.config.client === SqliteS3Client || origIsSQLite.call(DatabaseInfo, knex);
  DatabaseInfo.isSQLiteConfig = (config) =>
    config.client === SqliteS3Client || origIsSQLiteConfig.call(DatabaseInfo, config);
}
```

Note: `patchDatabaseInfoAt` needs a real CommonJS `require` (the target file is CJS); `preload.mjs` will pass its own `createRequire`-built `require` in in Step 5 below rather than relying on the `eval` fallback — fix this now:

```javascript
export function patchDatabaseInfoAt(absolutePath, SqliteS3Client, requireFn) {
  const DatabaseInfo = requireFn(absolutePath);
  const origIsSQLite = DatabaseInfo.isSQLite;
  const origIsSQLiteConfig = DatabaseInfo.isSQLiteConfig;
  DatabaseInfo.isSQLite = (knex) =>
    knex.client.config.client === SqliteS3Client || origIsSQLite.call(DatabaseInfo, knex);
  DatabaseInfo.isSQLiteConfig = (config) =>
    config.client === SqliteS3Client || origIsSQLiteConfig.call(DatabaseInfo, config);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/database-info-patch.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Rewire `preload.mjs` to use the extracted helpers and the corrected path semantics**

Replace the inline monkeypatch block and the `ghostCoreDir` derivation:

```javascript
// near the top, replace:
//   const ghostCoreDir = path.join(ghostCheckoutDir, 'ghost/core');
// with:
const ghostCoreDir = ghostCheckoutDir; // GHOST_CHECKOUT_DIR now names the dir containing core/ directly

// replace the whole inline `require`/`patchDatabaseInfoAt`/try-catch block with:
import { findDatabaseInfoPaths, patchDatabaseInfoAt } from './database-info-patch.mjs';
// ...
const require = (await import('node:module')).createRequire(import.meta.url);
for (const dbInfoPath of findDatabaseInfoPaths(ghostCheckoutDir)) {
  try {
    patchDatabaseInfoAt(dbInfoPath, SqliteS3Client, require);
  } catch (err) {
    console.error(`[ghost-sqlite-s3-launcher] could not patch ${dbInfoPath}:`, err.message);
  }
}
```

- [ ] **Step 6: Add the test script to `package.json`**

```json
  "scripts": {
    "test": "node --test"
  },
```

- [ ] **Step 7: Run the full launcher test suite**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add phase2/packages/ghost-sqlite-s3-launcher/
git commit -m "launcher: fix GHOST_CHECKOUT_DIR semantics for prod image layout, extract testable db-info patch"
```

---

### Task 2: AssumeRole `credential_process` helper + wiring

**Files:**
- Create: `phase2/packages/ghost-sqlite-s3-launcher/src/assume-role-credential-process.mjs`
- Create: `phase2/packages/ghost-sqlite-s3-launcher/src/aws-credentials.mjs`
- Create: `phase2/packages/ghost-sqlite-s3-launcher/test/aws-credentials.test.mjs`
- Modify: `phase2/packages/ghost-sqlite-s3-launcher/src/preload.mjs`
- Modify: `phase2/packages/ghost-sqlite-s3-launcher/package.json` (add `@aws-sdk/client-sts` dependency)

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent concern).
- Produces: `buildAwsConfigFile({ profileName, roleArn, helperScriptPath }): string` — exported from `aws-credentials.mjs`, returns the exact INI-format `~/.aws/config` file content (a `credential_process` profile block). `writeCredentialProcessProfile({ configPath, profileName, roleArn, helperScriptPath }): void` — writes that content to `configPath`, creating parent dirs as needed. Both used by `preload.mjs` and by later tasks (Task 3's SSM read, Task 5's S3Storage config all rely on `AWS_PROFILE`/`AWS_SDK_LOAD_CONFIG` being set by this task, not on any exported function — no other file imports from this task directly).

- [ ] **Step 1: Write the failing test for the config file content**

```javascript
// phase2/packages/ghost-sqlite-s3-launcher/test/aws-credentials.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAwsConfigFile } from '../src/aws-credentials.mjs';

test('buildAwsConfigFile produces a valid credential_process profile block', () => {
  const content = buildAwsConfigFile({
    profileName: 'ghost-phase2',
    roleArn: 'arn:aws:iam::699571927575:role/ghost-phase2-app-runtime',
    helperScriptPath: '/home/ghost/node_modules/@ghost-phase2/ghost-sqlite-s3-launcher/src/assume-role-credential-process.mjs',
  });

  assert.match(content, /^\[profile ghost-phase2\]$/m);
  assert.match(
    content,
    /^credential_process = node \/home\/ghost\/node_modules\/@ghost-phase2\/ghost-sqlite-s3-launcher\/src\/assume-role-credential-process\.mjs arn:aws:iam::699571927575:role\/ghost-phase2-app-runtime$/m
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/aws-credentials.test.mjs`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `aws-credentials.mjs`**

```javascript
// phase2/packages/ghost-sqlite-s3-launcher/src/aws-credentials.mjs
import fs from 'node:fs';
import path from 'node:path';

/**
 * INI content for an AWS CLI/SDK config file with one `credential_process`
 * profile. Every AWS SDK v3 client that resolves credentials via the default
 * chain (no explicit `credentials` option — this is deliberate, see
 * preload.mjs) with AWS_SDK_LOAD_CONFIG=1 and AWS_PROFILE set to this
 * profile's name will call `helperScriptPath` itself, independently, whenever
 * its own cached token nears the Expiration it printed last time. One
 * mechanism covers every client, including ones this codebase doesn't
 * construct itself (Ghost's own S3Storage adapter).
 */
export function buildAwsConfigFile({ profileName, roleArn, helperScriptPath }) {
  return `[profile ${profileName}]\ncredential_process = node ${helperScriptPath} ${roleArn}\n`;
}

export function writeCredentialProcessProfile({ configPath, profileName, roleArn, helperScriptPath }) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, buildAwsConfigFile({ profileName, roleArn, helperScriptPath }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/aws-credentials.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the credential_process helper script itself**

Not unit-tested directly (it makes a real STS call) — this is the one piece verified via the real deployment in Task 13, same pattern as `preload.mjs` itself.

```javascript
// phase2/packages/ghost-sqlite-s3-launcher/src/assume-role-credential-process.mjs
// Invoked by the AWS SDK's credential_process resolver (see aws-credentials.mjs)
// as: node assume-role-credential-process.mjs <roleArn>. Must print AWS CLI's
// standard credential_process JSON shape to stdout and exit 0, or exit non-zero
// on failure (the SDK surfaces stderr/exit code as the resolution error).
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

const roleArn = process.argv[2];
if (!roleArn) {
  console.error('usage: assume-role-credential-process.mjs <roleArn>');
  process.exit(1);
}

const sts = new STSClient({});
const result = await sts.send(
  new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'ghost-phase2-launcher',
  })
);

const creds = result.Credentials;
process.stdout.write(
  JSON.stringify({
    Version: 1,
    AccessKeyId: creds.AccessKeyId,
    SecretAccessKey: creds.SecretAccessKey,
    SessionToken: creds.SessionToken,
    Expiration: creds.Expiration.toISOString(),
  }) + '\n'
);
```

- [ ] **Step 6: Wire it into `preload.mjs`**, before any AWS client is constructed:

```javascript
import { fileURLToPath } from 'node:url';
import { writeCredentialProcessProfile } from './aws-credentials.mjs';

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
});
process.env.AWS_CONFIG_FILE = awsConfigPath;
process.env.AWS_SDK_LOAD_CONFIG = '1';
process.env.AWS_PROFILE = 'ghost-phase2';
```

Then remove the explicit `region` from the existing `new S3Client({ region })` call's credentials — it already doesn't pass `credentials` explicitly, so it already falls back to the default chain, which now resolves through this profile. No further change needed there.

- [ ] **Step 7: Add `@aws-sdk/client-sts` to `package.json` dependencies**

```json
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/client-sts": "^3.700.0",
    "@ghost-phase2/sqlite-s3": "git+https://github.com/dooreelko/ghosted.git#91f37fecd5772593b5052234e1f6cc3e2e868ccc:phase2/packages/sqlite-s3"
  },
```

- [ ] **Step 8: Run the full launcher test suite**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && npm install && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add phase2/packages/ghost-sqlite-s3-launcher/
git commit -m "launcher: wire AssumeRole via a credential_process profile"
```

---

### Task 3: Mail config + S3 image storage wiring

**Files:**
- Create: `phase2/packages/ghost-sqlite-s3-launcher/src/mail-config.mjs`
- Create: `phase2/packages/ghost-sqlite-s3-launcher/src/storage-config.mjs`
- Create: `phase2/packages/ghost-sqlite-s3-launcher/test/mail-config.test.mjs`
- Create: `phase2/packages/ghost-sqlite-s3-launcher/test/storage-config.test.mjs`
- Modify: `phase2/packages/ghost-sqlite-s3-launcher/src/preload.mjs`
- Modify: `phase2/packages/ghost-sqlite-s3-launcher/package.json` (add `@aws-sdk/client-ssm`)

**Interfaces:**
- Consumes: nothing from Tasks 1-2 directly at the function level (uses the same ambient-credential S3/SSM clients Task 2 set up, but that's a runtime effect, not an import).
- Produces: `buildMailConfig(smtpCredential: {user: string, pass: string}): object` from `mail-config.mjs` — returns the exact object shape for `config.set('mail', ...)`. `buildS3StorageConfig({ bucket, region, cdnUrl }): object` from `storage-config.mjs` — returns the value for `config.set('storage:S3Storage', ...)`.

- [ ] **Step 1: Write the failing test for mail config shape**

```javascript
// phase2/packages/ghost-sqlite-s3-launcher/test/mail-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMailConfig } from '../src/mail-config.mjs';

test('buildMailConfig produces Ghost SMTP transport config', () => {
  const result = buildMailConfig({ user: 'robots@the-well-architected-cloud.com', pass: 'secret-token' });

  assert.deepEqual(result, {
    transport: 'SMTP',
    options: {
      service: 'ProtonMail',
      host: 'smtp.protonmail.ch',
      port: 587,
      secure: false,
      auth: {
        user: 'robots@the-well-architected-cloud.com',
        pass: 'secret-token',
      },
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/mail-config.test.mjs`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `mail-config.mjs`**

```javascript
// phase2/packages/ghost-sqlite-s3-launcher/src/mail-config.mjs
/**
 * Ghost's SMTP transport config shape (config.set('mail', ...)). Same Proton
 * submission host/port phase1 (moth jpjiy) already uses.
 */
export function buildMailConfig({ user, pass }) {
  return {
    transport: 'SMTP',
    options: {
      service: 'ProtonMail',
      host: 'smtp.protonmail.ch',
      port: 587,
      secure: false,
      auth: { user, pass },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/mail-config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing test for storage config shape**

```javascript
// phase2/packages/ghost-sqlite-s3-launcher/test/storage-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildS3StorageConfig } from '../src/storage-config.mjs';

test('buildS3StorageConfig produces Ghost S3Storage adapter config', () => {
  const result = buildS3StorageConfig({
    bucket: 'ghost-phase2-data',
    region: 'us-east-1',
    cdnUrl: 'https://ghost-phase2-data.s3.us-east-1.amazonaws.com',
  });

  assert.deepEqual(result, {
    bucket: 'ghost-phase2-data',
    region: 'us-east-1',
    staticFileURLPrefix: 'content/images',
    cdnUrl: 'https://ghost-phase2-data.s3.us-east-1.amazonaws.com',
    multipartUploadThresholdBytes: 25 * 1024 * 1024,
    multipartChunkSizeBytes: 5 * 1024 * 1024,
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/storage-config.test.mjs`
Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Write `storage-config.mjs`**

```javascript
// phase2/packages/ghost-sqlite-s3-launcher/src/storage-config.mjs
/**
 * Ghost's S3Storage adapter config shape (config.set('storage:S3Storage', ...),
 * with config.set('storage:active', 'S3Storage') set alongside it — see
 * preload.mjs). No accessKeyId/secretAccessKey: S3Storage falls back to the
 * ambient credential chain, which the credential_process profile (see
 * aws-credentials.mjs) already points at the assumed app-runtime role.
 *
 * cdnUrl points at the bucket directly — nothing fronts it publicly yet (no
 * CDN; that's moth i8hlt's cutover work). Uploads still work and are recorded
 * correctly; public image URLs won't resolve until then.
 */
export function buildS3StorageConfig({ bucket, region, cdnUrl }) {
  return {
    bucket,
    region,
    staticFileURLPrefix: 'content/images',
    cdnUrl,
    multipartUploadThresholdBytes: 25 * 1024 * 1024,
    multipartChunkSizeBytes: 5 * 1024 * 1024,
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/storage-config.test.mjs`
Expected: PASS.

- [ ] **Step 9: Wire both into `preload.mjs`**, after the existing DB config block:

```javascript
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { buildMailConfig } from './mail-config.mjs';
import { buildS3StorageConfig } from './storage-config.mjs';

const mailParamName = process.env.MAIL_SSM_PARAM_NAME ?? 'ghost_imap_token';
const ssm = new SSMClient({ region });
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
```

Note for the implementer: verify the actual value format of the `ghost_imap_token` SSM parameter (`user:password` is an assumption based on its name/history in `.local-secrets.md` — confirm against phase1/jpjiy's actual on-instance mail config before trusting the split-on-colon parsing; adjust if the real format differs, e.g. JSON).

- [ ] **Step 10: Add `@aws-sdk/client-ssm` to `package.json` dependencies**

```json
    "@aws-sdk/client-ssm": "^3.700.0",
```

- [ ] **Step 11: Run the full launcher test suite**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && npm install && npm test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add phase2/packages/ghost-sqlite-s3-launcher/
git commit -m "launcher: wire mail transport + S3 image storage config"
```

---

### Task 4: Fix smoke test's env var for the corrected `GHOST_CHECKOUT_DIR` semantics

Task 1 redefined `GHOST_CHECKOUT_DIR`. The smoke test (moth yofwh) uses the launcher's *predecessor* code path directly (`smoke/preload.mjs`, a separate, older file — not this launcher package), so check first whether it's actually affected.

**Files:**
- Read only, no modification expected: `phase2/packages/sqlite-s3/smoke/preload.mjs`, `phase2/packages/sqlite-s3/smoke/docker-compose.smoke.yaml`

**Interfaces:** none (verification task).

- [ ] **Step 1: Confirm the smoke test doesn't import the launcher package**

Run: `grep -rn "ghost-sqlite-s3-launcher" phase2/packages/sqlite-s3/smoke/`
Expected: no output — the smoke test has its own standalone `preload.mjs` (predates the launcher package, per moth yofwh's design doc: "generalizes the existing smoke/preload.mjs" — generalized into a *new* package, the original smoke script was left as-is). If this instead shows a real import, stop and re-scope this task to fix that file too, using the same env var semantics as Task 1.

- [ ] **Step 2: No commit needed for this task if Step 1 confirms no coupling** — note the finding in the moth ticket update (Task 15) instead.

---

### Task 5: `phase2/docker/Dockerfile` — the launcher layer (stage B)

**Files:**
- Create: `phase2/docker/Dockerfile`
- Create: `phase2/docker/build.sh`

**Interfaces:**
- Consumes: the launcher package from Tasks 1-3 (its `package.json`/`src/`), and a pre-built stage-A image tag (produced by `build.sh` itself, calling `docker build` against `Ghost/`).
- Produces: a final image tag `ghost-phase2:<git-sha>`, used by Task 12 (build+push) and referenced by IaC docs/comments in Task 9.

- [ ] **Step 1: Write `phase2/docker/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# Stage B of the two-stage build (see docs/superpowers/specs/2026-09-08-phase2-docker-iac-design.md).
# Stage A (Ghost's own Dockerfile.production, target=full) is built separately
# by build.sh and passed in as BASE_IMAGE — this file never touches Ghost's
# own Dockerfile or source.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root
COPY --chown=nobody:nogroup phase2/packages/sqlite-s3 /home/ghost/phase2-packages/sqlite-s3
COPY --chown=nobody:nogroup phase2/packages/ghost-sqlite-s3-launcher /home/ghost/phase2-packages/ghost-sqlite-s3-launcher
RUN cd /home/ghost/phase2-packages/ghost-sqlite-s3-launcher && npm install --omit=dev

USER ghost
ENV GHOST_CHECKOUT_DIR=/home/ghost
CMD ["node", "--import=/home/ghost/phase2-packages/ghost-sqlite-s3-launcher/src/preload.mjs", "index.js"]
```

- [ ] **Step 2: Write `phase2/docker/build.sh`**

```bash
#!/usr/bin/env bash
# Two-stage build: Ghost's own production image (target=full, unmodified),
# then this repo's launcher layer on top. Run from the repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GHOST_DIR="$REPO_ROOT/Ghost"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
BASE_TAG="ghost-phase2-base:$SHA"
FINAL_TAG="ghost-phase2:$SHA"

echo "== Building admin UI (needed by Dockerfile.production's full target) =="
docker run --rm -v "$GHOST_DIR":/work -w /work node:22.23.1-bookworm-slim bash -c \
  "corepack enable && pnpm install --frozen-lockfile --filter '@tryghost/admin...' && pnpm nx run @tryghost/admin:build"

echo "== Building Ghost's own production image (stage A, unmodified) =="
docker build -f "$GHOST_DIR/Dockerfile.production" --target full -t "$BASE_TAG" "$GHOST_DIR"

echo "== Building launcher layer (stage B) =="
docker build -f "$REPO_ROOT/phase2/docker/Dockerfile" --build-arg BASE_IMAGE="$BASE_TAG" -t "$FINAL_TAG" "$REPO_ROOT"

echo "== Built $FINAL_TAG =="
echo "$FINAL_TAG"
```

- [ ] **Step 3: Make it executable and run it**

Run: `chmod +x phase2/docker/build.sh && ./phase2/docker/build.sh`
Expected: succeeds, prints `ghost-phase2:<sha>` as the last line. (Admin build and stage-A build were already proven working during design; this step re-runs them through the script and adds stage B.)

- [ ] **Step 4: Sanity-check stage B's launcher install**

Run: `docker run --rm ghost-phase2:$(git rev-parse --short HEAD) sh -c "ls /home/ghost/phase2-packages/ghost-sqlite-s3-launcher/node_modules/@ghost-phase2/sqlite-s3 2>&1 | head -3"`
Expected: lists sqlite-s3's files — confirms the git-dependency install resolved inside the image build.

- [ ] **Step 5: Commit**

```bash
git add phase2/docker/
git commit -m "docker: add phase2 launcher-layer Dockerfile + two-stage build script"
```

---

### Task 6: `shell.nix` + OpenTofu scaffolding

**Files:**
- Modify: `shell.nix`
- Create: `phase2/iac/providers.tf`
- Modify: `.gitignore`

**Interfaces:** none (infra scaffolding, no code interfaces).

- [ ] **Step 1: Add OpenTofu to `shell.nix`**

```nix
      pkgs.opentofu
```
(insert alongside the existing `buildInputs` entries, e.g. after `pkgs.sqlite`)

- [ ] **Step 2: Add tfstate/tfvars to `.gitignore`**

```
phase2/iac/.terraform/
phase2/iac/terraform.tfstate
phase2/iac/terraform.tfstate.backup
phase2/iac/*.tfvars
```

- [ ] **Step 3: Write `phase2/iac/providers.tf`**

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      app = "ghost-phase2"
    }
  }
}
```

- [ ] **Step 4: Verify tofu is available and init succeeds**

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu init"`
Expected: `Terraform has been successfully initialized!` (OpenTofu prints the same message text).

- [ ] **Step 5: Commit**

```bash
git add shell.nix .gitignore phase2/iac/providers.tf
git commit -m "iac: scaffold phase2/iac/ with OpenTofu, add tofu to shell.nix"
```

---

### Task 7: S3 bucket + ECR repository

**Files:**
- Create: `phase2/iac/s3.tf`
- Create: `phase2/iac/ecr.tf`

**Interfaces:**
- Produces: `aws_s3_bucket.data` (referenced by Task 8's IAM policy and Task 9's Lightsail env vars), `aws_ecr_repository.ghost` (referenced by Task 9's `image_puller` block and Task 12's push target).

- [ ] **Step 1: Write `phase2/iac/s3.tf`**

```hcl
resource "aws_s3_bucket" "data" {
  bucket = "ghost-phase2-data-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket = aws_s3_bucket.data.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_caller_identity" "current" {}
```

(Account-ID suffix keeps the globally-unique bucket-name constraint out of any manually-chosen name; `data.aws_caller_identity` also gets reused by `iam.tf` in Task 8.)

- [ ] **Step 2: Write `phase2/iac/ecr.tf`**

```hcl
resource "aws_ecr_repository" "ghost" {
  name                 = "ghost-phase2"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}
```

- [ ] **Step 3: Validate the config parses**

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu validate"`
Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Commit**

```bash
git add phase2/iac/s3.tf phase2/iac/ecr.tf
git commit -m "iac: add S3 data bucket + ECR repository"
```

---

### Task 8: App-runtime IAM role

**Files:**
- Create: `phase2/iac/iam.tf`

**Interfaces:**
- Consumes: `aws_s3_bucket.data` (Task 7), `aws_lightsail_container_service.ghost` (Task 9 — see note below on ordering).
- Produces: `aws_iam_role.app_runtime` (its ARN is `AWS_ROLE_ARN` in Task 9's deployment env vars).

Note on ordering: this role's trust policy needs the Lightsail container service's own principal ARN, which doesn't exist until that resource is created (Task 9). Since OpenTofu resolves same-`tofu apply` cross-references via its dependency graph regardless of file order, write this file now (referencing `aws_lightsail_container_service.ghost.private_domain_name`'s sibling attribute — see Step 1's note) and Task 9's resource next; both apply together in Task 10.

- [ ] **Step 1: Write `phase2/iac/iam.tf`**

```hcl
# Verify at apply time (Task 10) whether the AWS provider's
# aws_lightsail_container_service resource exposes the principal ARN as a
# computed attribute directly (check `tofu providers schema -json | jq
# '.provider_schemas."registry.opentofu.org/hashicorp/aws".resource_schemas."aws_lightsail_container_service"'`
# for a `principal_arn` or similarly-named field). If it's exposed, reference
# it directly below. If not, fall back to a `data "aws_lightsail_container_service"`
# data source (often exposes attributes a resource block doesn't) or, as a last
# resort, an `aws lightsail get-container-services` CLI call captured via an
# `external` data source. Placeholder reference below assumes the resource
# attribute exists — Task 10 corrects this if it doesn't.
data "aws_iam_policy_document" "app_runtime_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [aws_lightsail_container_service.ghost.private_registry_access[0].ecr_image_puller_role[0].principal_arn == null ? "" : aws_lightsail_container_service.ghost.arn]
    }
  }
}

resource "aws_iam_role" "app_runtime" {
  name               = "ghost-phase2-app-runtime"
  assume_role_policy = data.aws_iam_policy_document.app_runtime_trust.json
}

data "aws_iam_policy_document" "app_runtime_permissions" {
  statement {
    sid    = "S3DataBucketCrud"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.data.arn,
      "${aws_s3_bucket.data.arn}/*",
    ]
  }

  statement {
    sid       = "MailCredentialRead"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:us-east-1:${data.aws_caller_identity.current.account_id}:parameter/ghost_imap_token"]
  }

  statement {
    sid       = "MailCredentialDecrypt"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"] # narrow to the specific KMS key ARN at apply time once known (Task 10) — SSM SecureString params typically use the account's default aws/ssm key
  }
}

resource "aws_iam_role_policy" "app_runtime_permissions" {
  name   = "ghost-phase2-app-runtime-permissions"
  role   = aws_iam_role.app_runtime.id
  policy = data.aws_iam_policy_document.app_runtime_permissions.json
}
```

Implementer note: the trust-policy `principals` block above is deliberately written as a placeholder expression that will fail `tofu validate`/`plan` — this is intentional, forcing Task 10's implementer to look up the actual attribute name (the comment above the data source explains how) rather than trusting an unverified guess. Replace the whole `identifiers` line with the real attribute reference (or data-source/external fallback) before running `tofu plan` in Task 10. Do not skip this — it's the one piece of this design explicitly flagged as unverified against the real provider schema.

- [ ] **Step 2: Commit** (even though `tofu validate` will fail on the placeholder — that's expected and corrected in Task 10, not this task; committing captures the intent)

```bash
git add phase2/iac/iam.tf
git commit -m "iac: add app-runtime IAM role (trust-policy principal ARN lookup left for Task 10)"
```

---

### Task 9: Lightsail container service

**Files:**
- Create: `phase2/iac/lightsail.tf`

**Interfaces:**
- Consumes: `aws_ecr_repository.ghost` (Task 7).
- Produces: `aws_lightsail_container_service.ghost` (referenced by Task 8's trust policy and Task 13's deployment).

- [ ] **Step 1: Write `phase2/iac/lightsail.tf`**

```hcl
resource "aws_lightsail_container_service" "ghost" {
  name        = "ghost-phase2"
  power       = "micro"
  scale       = 1
  is_disabled = false

  private_registry_access {
    ecr_image_puller_role {
      is_active = true
    }
  }
}

resource "aws_ecr_repository_policy" "lightsail_pull" {
  repository = aws_ecr_repository.ghost.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowLightsailPull"
      Effect = "Allow"
      Principal = {
        AWS = aws_lightsail_container_service.ghost.private_registry_access[0].ecr_image_puller_role[0].principal_arn
      }
      Action = [
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]
    }]
  })
}
```

Implementer note: this assumes `private_registry_access.ecr_image_puller_role.principal_arn` is a real computed attribute on the AWS provider's `aws_lightsail_container_service` resource (as of provider ~5.0, this block was added specifically for ECR-puller support, so it likely is — but verify with `tofu providers schema` per Task 8's note before trusting it, since Task 8's trust policy references the sibling `aws_lightsail_container_service.ghost.arn`/principal similarly). If the attribute name differs, fix both this file and Task 8's `iam.tf` together — they reference the same resource.

- [ ] **Step 2: Commit**

```bash
git add phase2/iac/lightsail.tf
git commit -m "iac: add Lightsail container service (micro, ECR image puller role activated)"
```

---

### Task 10: First real `tofu apply` — S3, ECR, Lightsail service, IAM role

This is the first task that touches real AWS resources. Confirm with the user before running `tofu apply` if not already given a general go-ahead for this session (the design/brainstorming conversation already secured one — proceed).

**Files:** none created; this task runs the config from Tasks 6-9 and fixes any attribute-name mismatches found.

- [ ] **Step 1: Inspect the real provider schema for the disputed attributes**

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu init && tofu providers schema -json"` piped through `jq '.provider_schemas | to_entries[0].value.resource_schemas."aws_lightsail_container_service".block.block_types.private_registry_access'`
Expected: shows the real nested attribute names. Fix `iam.tf`'s trust-policy `identifiers` line and `lightsail.tf`'s `aws_ecr_repository_policy`'s `Principal.AWS` line to match exactly what this reveals. Common outcomes to handle: the attribute might be named `principal_arn` directly as shown, or nested differently, or (if truly absent from this provider version) require a `data "external"` block shelling out to `aws lightsail get-container-services --service-name ghost-phase2 --query 'containerServices[0].privateRegistryAccess.ecrImagePullerRole.principalArn'` after the service exists — in which case split this into two applies (service first, then a second apply once the data source can read it).

- [ ] **Step 2: `tofu plan`**

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu plan -out=tfplan"`
Expected: shows a plan to create the S3 bucket, public-access-block, ECR repo, IAM role + policy, Lightsail service, ECR repo policy. Review it — no resource should be planned for destruction (nothing exists yet).

- [ ] **Step 3: `tofu apply`**

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu apply tfplan"`
Expected: all resources created successfully.

- [ ] **Step 4: Record the real identifiers in `.local-secrets.md`**

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu output -json 2>&1 || tofu show -json tfplan | jq '.planned_values.root_module.resources[] | {address, values: .values | {id, arn, bucket, name}}'"` (add an `outputs.tf` first if it doesn't exist yet — see Step 4a) to get the bucket name, ECR repo URI, role ARN, service name/ARN.

Step 4a — if not already present, add `phase2/iac/outputs.tf` before re-running:
```hcl
output "bucket_name" {
  value = aws_s3_bucket.data.bucket
}
output "ecr_repository_url" {
  value = aws_ecr_repository.ghost.repository_url
}
output "app_runtime_role_arn" {
  value = aws_iam_role.app_runtime.arn
}
output "lightsail_service_name" {
  value = aws_lightsail_container_service.ghost.name
}
```
Then `tofu apply` again (adding outputs doesn't change any resource, so this is a no-op apply that just populates state's output values) and `tofu output`.

Append these to `.local-secrets.md` under a new `## Phase 2 Docker/IaC (moth hnj9a)` heading, in the same style as the existing `## Ghost On A Stick` section (resource type: value, one per line).

- [ ] **Step 5: Commit** (the outputs.tf addition, and iam.tf/lightsail.tf if Step 1 required fixes)

```bash
git add phase2/iac/
git commit -m "iac: apply S3/ECR/IAM/Lightsail service, add outputs"
```

---

### Task 11: Build and push the image to ECR

**Files:**
- Modify: `phase2/docker/build.sh` (add push step)

**Interfaces:**
- Consumes: `ecr_repository_url` output from Task 10.

- [ ] **Step 1: Extend `build.sh` with an ECR push**

```bash
# append to phase2/docker/build.sh, after the existing "Built $FINAL_TAG" echo:

ECR_URL="$(nix-shell -p opentofu --run "cd $REPO_ROOT/phase2/iac && tofu output -raw ecr_repository_url")"
ECR_TAG="$ECR_URL:$SHA"

echo "== Authenticating docker to ECR =="
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${ECR_URL%%/*}"

echo "== Tagging and pushing $ECR_TAG =="
docker tag "$FINAL_TAG" "$ECR_TAG"
docker push "$ECR_TAG"

echo "== Pushed $ECR_TAG =="
echo "$ECR_TAG"
```

- [ ] **Step 2: Run the extended script**

Run: `./phase2/docker/build.sh`
Expected: builds (or reuses cached layers) and pushes, printing the final `<ecr-url>:<sha>` tag.

- [ ] **Step 3: Verify the image landed in ECR**

Run: `aws ecr describe-images --repository-name ghost-phase2 --region us-east-1`
Expected: lists the pushed image digest/tag, with an `imageSizeInBytes` well under any concerning threshold (sanity-check against the "stay under 10GB" cost note from the moth ticket — expect a few hundred MB).

- [ ] **Step 4: Commit**

```bash
git add phase2/docker/build.sh
git commit -m "docker: push built image to ECR"
```

---

### Task 12: Deployment env vars + `.local-secrets.md` record

**Files:** none created — this task assembles the exact env var values the deployment (Task 13) needs, from Task 10's outputs plus fixed values.

- [ ] **Step 1: Assemble the env var list**

From Task 10's `.local-secrets.md` entries and known values:
- `SQLITE_S3_BUCKET` = bucket name output
- `SQLITE_S3_REGION` = `us-east-1`
- `AWS_ROLE_ARN` = app runtime role ARN output
- `GHOST_URL` = `https://the-well-architected-cloud.com/blog` (real production url, per hnj9a's "wire it all" scope decision — note in the moth ticket, per Task 15, that nothing points real traffic here yet, matching the design doc's explicit out-of-scope note)
- `MAIL_SSM_PARAM_NAME` = `ghost_imap_token` (default, can be omitted)

Write these into `.local-secrets.md`'s `## Phase 2 Docker/IaC (moth hnj9a)` section (from Task 10) as a "Deployment env vars" subsection, values only (not committed — file is gitignored).

- [ ] **Step 2: No commit** — `.local-secrets.md` is gitignored by design.

---

### Task 13: Create the Lightsail deployment

**Files:**
- Create: `phase2/iac/deployment.tf` (or extend `lightsail.tf` if the OpenTofu resource for a deployment version exists in this provider — check first)

**Interfaces:**
- Consumes: `aws_lightsail_container_service.ghost` (Task 9), `aws_ecr_repository.ghost` (Task 7), env vars assembled in Task 12.

- [ ] **Step 1: Check whether the AWS provider has a deployment-version resource**

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu providers schema -json"` piped through `jq '.provider_schemas | to_entries[0].value.resource_schemas | keys[] | select(test(\"lightsail\"))'`
Expected: look for `aws_lightsail_container_service_deployment_version` or similar. If present, use it (Step 2a). If absent, use the CLI directly (Step 2b) — Tofu-managing the deployment isn't essential (the design doc already flagged this split as implementation-time-verified), only the surrounding infra needs to be Tofu-managed for the "flat local state" decision to matter.

- [ ] **Step 2a: If the Tofu resource exists, write `phase2/iac/deployment.tf`**

```hcl
resource "aws_lightsail_container_service_deployment_version" "ghost" {
  service_name = aws_lightsail_container_service.ghost.name

  container {
    container_name = "ghost"
    image          = "${aws_ecr_repository.ghost.repository_url}:${var.image_tag}"

    environment = {
      SQLITE_S3_BUCKET   = aws_s3_bucket.data.bucket
      SQLITE_S3_REGION   = "us-east-1"
      AWS_ROLE_ARN       = aws_iam_role.app_runtime.arn
      GHOST_URL          = "https://the-well-architected-cloud.com/blog"
      MAIL_SSM_PARAM_NAME = "ghost_imap_token"
    }

    ports = {
      "2368" = "HTTP"
    }
  }

  public_endpoint {
    container_name = "ghost"
    container_port = 2368

    health_check {
      healthy_threshold   = 2
      unhealthy_threshold = 5
      timeout_seconds     = 10
      interval_seconds    = 30
      path                = "/"
      success_codes       = "200-399"
    }
  }
}

variable "image_tag" {
  type        = string
  description = "Git short-SHA tag of the image to deploy (set via -var on each deploy)"
}
```

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu apply -var=\"image_tag=$(git rev-parse --short HEAD)\""`

- [ ] **Step 2b: If the Tofu resource doesn't exist, deploy via CLI instead**

```bash
ECR_URL="$(nix-shell -p opentofu --run "cd phase2/iac && tofu output -raw ecr_repository_url")"
BUCKET="$(nix-shell -p opentofu --run "cd phase2/iac && tofu output -raw bucket_name")"
ROLE_ARN="$(nix-shell -p opentofu --run "cd phase2/iac && tofu output -raw app_runtime_role_arn")"
SHA="$(git rev-parse --short HEAD)"

aws lightsail create-container-service-deployment \
  --service-name ghost-phase2 \
  --containers "{\"ghost\":{\"image\":\"$ECR_URL:$SHA\",\"ports\":{\"2368\":\"HTTP\"},\"environment\":{\"SQLITE_S3_BUCKET\":\"$BUCKET\",\"SQLITE_S3_REGION\":\"us-east-1\",\"AWS_ROLE_ARN\":\"$ROLE_ARN\",\"GHOST_URL\":\"https://the-well-architected-cloud.com/blog\",\"MAIL_SSM_PARAM_NAME\":\"ghost_imap_token\"}}}" \
  --public-endpoint '{"containerName":"ghost","containerPort":2368,"healthCheck":{"healthyThreshold":2,"unhealthyThreshold":5,"timeoutSeconds":10,"intervalSeconds":30,"path":"/","successCodes":"200-399"}}' \
  --region us-east-1
```

- [ ] **Step 3: Wait for the deployment to go live**

Run: `aws lightsail get-container-services --service-name ghost-phase2 --region us-east-1 --query 'containerServices[0].{state:state,url:url}'`
Expected: poll until `state` is `RUNNING` (can take a few minutes — Lightsail pulls the image and starts the container).

- [ ] **Step 4: Commit** (if Step 2a's file was created)

```bash
git add phase2/iac/deployment.tf
git commit -m "iac: deploy ghost-phase2 container service"
```

---

### Task 14: Verify the live deployment

**Files:** none — verification only.

- [ ] **Step 1: Fetch the service's public URL**

Run: `aws lightsail get-container-services --service-name ghost-phase2 --region us-east-1 --query 'containerServices[0].url' --output text`

- [ ] **Step 2: Check the site responds**

Run: `curl -sf --retry 20 --retry-delay 5 --retry-all-errors "<url-from-step-1>"`
Expected: 200, Ghost's default homepage HTML (empty blog, since this is a fresh DB in a fresh bucket).

- [ ] **Step 3: Check the admin panel loads**

Run: `curl -sf --retry 10 --retry-delay 3 "<url-from-step-1>ghost/"`
Expected: 200, admin SPA shell HTML.

- [ ] **Step 4: Check logs for credential/mail/storage wiring errors**

Run: `aws lightsail get-container-log --service-name ghost-phase2 --container-name ghost --region us-east-1 --query 'logEvents[*].message' --output text | tail -100`
Expected: no `AccessDenied`, no `credential_process` errors, no mail-config or S3Storage errors. If the no-`ExternalId` trust policy (Global Constraints) fails here with an AssumeRole `AccessDenied`, that's the flagged risk from the design doc materializing — fix by adding `sts:ExternalId` back to `iam.tf`'s trust policy (a real correction, not a workaround: update the design doc's "no ExternalId" section and the moth ticket to record it, then re-apply).

- [ ] **Step 5: No commit** (verification only) — record the outcome in Task 15's moth update.

---

### Task 15: Final moth ticket update

**Files:**
- Modify: `.moth/doing/hnj9a-med-docker_iac.md` (via `moth update hnj9a`, per this repo's convention — read current content first, append under a new dated section, never overwrite)

- [ ] **Step 1: Read the current ticket**

Run: `moth show hnj9a`

- [ ] **Step 2: Append an implementation-abstract section** covering: the two-stage Docker build is live (image built, pushed to ECR); the launcher's three boot-time jobs (DB, credentials via credential_process, mail+storage config) are live and unit-tested where the logic is pure; the OpenTofu-managed infra (S3, ECR, IAM, Lightsail service+deployment) is applied for real, with real identifiers in `.local-secrets.md`; Task 14's verification outcome (including whether the no-ExternalId trust policy needed correcting); Task 4's finding on the smoke test's independence. Do **not** mark the ticket done — that's the user's call, not this plan's.

- [ ] **Step 3: Update via `moth update hnj9a`** (pipe the full read-plus-appended content through stdin, per this repo's CLAUDE.md convention).

- [ ] **Step 4: Commit**

```bash
git add .moth/doing/hnj9a-med-docker_iac.md
git commit -m "moth hnj9a: record implementation outcome"
```

---

## Self-Review Notes

- **Spec coverage:** two-stage Docker build (Task 5), launcher credentials/mail/storage (Tasks 1-3), private ECR + ECR-puller role (Tasks 7, 9, 10), app-runtime IAM role no-ExternalId (Task 8, verified live in Task 14), S3 bucket (Task 7), Lightsail Micro service (Task 9), OpenTofu flat-state one-file-per-component layout (Tasks 6-9), real apply (Tasks 10, 13), out-of-scope CloudFront/migration correctly excluded throughout.
- **Known unresolved items surfaced deliberately, not hidden:** the exact `aws_lightsail_container_service` provider attribute name for the ECR-puller principal ARN (Tasks 8/9/10), whether a Tofu deployment-version resource exists at all (Task 13), the SSM mail-parameter's actual value format (Task 3 Step 9's note) — each has a concrete verification step and a fallback path, not a guess presented as fact.
- **Type/interface consistency:** `findDatabaseInfoPaths`/`patchDatabaseInfoAt` (Task 1) → consumed only by `preload.mjs`, not by later tasks. `buildAwsConfigFile`/`writeCredentialProcessProfile` (Task 2), `buildMailConfig` (Task 3), `buildS3StorageConfig` (Task 3) — each consumed once, by `preload.mjs`, with matching signatures between definition and call site.
