# Phase 2 Deploy Observability & Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `phase2/scripts/deploy.sh`, a manually-triggered pipeline that builds/pushes the Ghost image, applies it via OpenTofu, independently verifies the deployment (HTTP smoke test + a Ghost Admin API create/read/delete roundtrip), and actively rolls back to the previous image tag if verification fails.

**Architecture:** Bash orchestrates the parts that are already shell scripts or CLI tools (`build.sh`, `tofu`, `aws`); a small Node package (`phase2/packages/deploy-verify`) holds the logic worth unit-testing — Admin API JWT signing, request/response shaping, and previous-deployment-tag parsing — each function taking an injectable `fetch` so tests never hit the network. `deploy.sh` calls that package's CLI entrypoints and interprets their exit codes.

**Tech Stack:** Bash, Node.js (`>=20`, ESM, `node --test`, no new runtime deps — global `fetch`, `node:crypto` for HMAC), OpenTofu, AWS CLI.

**Spec:** [docs/superpowers/specs/2026-09-08-phase2-deploy-observability-design.md](../specs/2026-09-08-phase2-deploy-observability-design.md)

## Global Constraints

- Region `us-east-1` everywhere (matches every other phase2 resource).
- Never patch Ghost or the launcher for this — verification is entirely external (design doc, "Architecture").
- The container itself never receives the Admin API key; only `deploy.sh`'s own AWS identity fetches it from SSM (design doc, "Admin API key provisioning").
- Rollback re-derives current/previous state from Lightsail's own deployment history on every run — no local state file (design doc, "Error handling").
- Mail is explicitly NOT verified per-deploy (design doc, accepted gap) — do not add an email-send step.
- SSM parameter name: `ghost_phase2_admin_api_key` (SecureString, same pattern as `ghost_imap_token`).
- Existing resource names/outputs this plan depends on: ECR repo output `ecr_repository_url`, Lightsail service name `ghost-phase2`, S3 data bucket output `bucket_name`, IAM role output `app_runtime_role_arn` (none of these are touched by this plan except adding one new output).

---

## File Structure

- `phase2/iac/outputs.tf` (modify) — add a `public_url` output so `deploy.sh` and the verify package know what to hit; nothing else in `phase2/iac/` changes.
- `phase2/packages/deploy-verify/` (new package) — the unit-testable logic:
  - `package.json`
  - `src/http-smoke-test.mjs` — hits a list of URLs, expects HTTP 200.
  - `src/admin-token.mjs` — builds a Ghost Admin API JWT from an `id:secret` key.
  - `src/admin-api-client.mjs` — `uploadImage`, `createDraftPost`, `getPost`, `deletePost` against the Admin API, each taking an injectable `fetchImpl`.
  - `src/s3-object-delete.mjs` — deletes one S3 object by URL, given a bucket name (uses `@aws-sdk/client-s3`, already a dependency pattern used by the launcher package).
  - `src/previous-deployment.mjs` — parses `aws lightsail get-container-service-deployments` JSON, returns the previous image tag or `null`.
  - `fixtures/test-pixel.png` — a tiny real PNG used as the Admin API roundtrip's test image.
  - `bin/verify.mjs` — CLI: runs the smoke test + Admin API roundtrip + S3 cleanup, exits 0 on full success, 1 on any failure, prints a one-line JSON summary to stdout.
  - `bin/previous-tag.mjs` — CLI: reads Lightsail deployments JSON from stdin, prints the previous tag to stdout and exits 0, or exits 3 with no stdout if there is none.
  - `test/*.test.mjs` — one test file per `src/*.mjs` module.
- `phase2/scripts/deploy.sh` (new) — the orchestrator: build & push, `tofu apply`, run `verify.mjs`, and on verification failure, look up the previous tag via `previous-tag.mjs` and `tofu apply` again to roll back.

---

## Task 1: Add the `public_url` Terraform output

**Files:**
- Modify: `phase2/iac/outputs.tf`

**Interfaces:**
- Produces: a `tofu output -raw public_url` value that later tasks' `deploy.sh` reads — the Lightsail container service's own public HTTPS endpoint (e.g. `https://ghost-phase2.xxxxx.us-east-1.cs.amazonlightsail.com/`), independent of the not-yet-cut-over `the-well-architected-cloud.com` domain.

- [ ] **Step 1: Add the output block**

Append to `phase2/iac/outputs.tf`:

```hcl
output "public_url" {
  value = aws_lightsail_container_service.ghost.url
}
```

- [ ] **Step 2: Validate**

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu validate"`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add phase2/iac/outputs.tf
git commit -m "iac: add public_url output for deploy.sh's smoke test target"
```

---

## Task 2: Scaffold the `deploy-verify` package

**Files:**
- Create: `phase2/packages/deploy-verify/package.json`

**Interfaces:**
- Produces: `node --test` runnable from `phase2/packages/deploy-verify/`, `@aws-sdk/client-s3` available as a dependency for Task 6.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@ghost-phase2/deploy-verify",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "description": "Post-deploy verification (HTTP smoke test + Ghost Admin API roundtrip) used by phase2/scripts/deploy.sh.",
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0"
  }
}
```

- [ ] **Step 2: Install**

Run: `cd phase2/packages/deploy-verify && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Commit**

```bash
git add phase2/packages/deploy-verify/package.json phase2/packages/deploy-verify/package-lock.json
git commit -m "deploy-verify: scaffold package"
```

---

## Task 3: HTTP smoke test

**Files:**
- Create: `phase2/packages/deploy-verify/src/http-smoke-test.mjs`
- Test: `phase2/packages/deploy-verify/test/http-smoke-test.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `checkUrls(urls, fetchImpl = fetch) -> Promise<{ ok: boolean, results: Array<{ url: string, status?: number, error?: string }> }>` — used by Task 7's `bin/verify.mjs`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrls } from '../src/http-smoke-test.mjs';

test('checkUrls reports ok when every URL returns 200', async () => {
  const fetchImpl = async (url) => ({ status: 200, url });
  const result = await checkUrls(['https://x/blog/', 'https://x/blog/ghost/'], fetchImpl);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [
    { url: 'https://x/blog/', status: 200 },
    { url: 'https://x/blog/ghost/', status: 200 },
  ]);
});

test('checkUrls reports not-ok and keeps checking remaining URLs on a non-200', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/blog/') ? { status: 503, url } : { status: 200, url };
  const result = await checkUrls(['https://x/blog/', 'https://x/blog/ghost/'], fetchImpl);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results, [
    { url: 'https://x/blog/', status: 503 },
    { url: 'https://x/blog/ghost/', status: 200 },
  ]);
});

test('checkUrls reports a fetch rejection as a failure without throwing', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/blog/')) throw new Error('ECONNREFUSED');
    return { status: 200, url };
  };
  const result = await checkUrls(['https://x/blog/', 'https://x/blog/ghost/'], fetchImpl);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results, [
    { url: 'https://x/blog/', error: 'ECONNREFUSED' },
    { url: 'https://x/blog/ghost/', status: 200 },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/deploy-verify && node --test test/http-smoke-test.test.mjs`
Expected: FAIL — `Cannot find module '../src/http-smoke-test.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
export async function checkUrls(urls, fetchImpl = fetch) {
  const results = [];
  for (const url of urls) {
    try {
      const response = await fetchImpl(url);
      results.push({ url, status: response.status });
    } catch (err) {
      results.push({ url, error: err.message });
    }
  }
  const ok = results.every((r) => r.status === 200);
  return { ok, results };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/deploy-verify && node --test test/http-smoke-test.test.mjs`
Expected: PASS, 3/3

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/deploy-verify/src/http-smoke-test.mjs phase2/packages/deploy-verify/test/http-smoke-test.test.mjs
git commit -m "deploy-verify: add HTTP smoke test module"
```

---

## Task 4: Admin API JWT

**Files:**
- Create: `phase2/packages/deploy-verify/src/admin-token.mjs`
- Test: `phase2/packages/deploy-verify/test/admin-token.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `generateAdminToken({ keyId, secretHex }, nowMs = Date.now()) -> string` — a Ghost Admin API JWT (HS256, `kid` header = `keyId`, `exp` = `iat + 300`, `aud: '/admin/'`) — used by Task 5's `admin-api-client.mjs`.

Ghost's Admin API key is `id:secretHex` split on `:`. The JWT is signed
HS256 with the raw bytes of `secretHex` (hex-decoded), matching Ghost's
own `admin-api-key` auth strategy.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateAdminToken } from '../src/admin-token.mjs';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

test('generateAdminToken produces a valid HS256 JWT with the expected claims', () => {
  const nowMs = 1_800_000_000_000; // fixed instant
  const token = generateAdminToken({ keyId: 'abc123', secretHex: 'deadbeef' }, nowMs);

  const [headerB64, payloadB64, sigB64] = token.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT', kid: 'abc123' });
  assert.equal(payload.aud, '/admin/');
  assert.equal(payload.iat, Math.floor(nowMs / 1000));
  assert.equal(payload.exp, Math.floor(nowMs / 1000) + 300);

  const expectedSig = crypto
    .createHmac('sha256', Buffer.from('deadbeef', 'hex'))
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  assert.equal(sigB64, expectedSig);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/deploy-verify && node --test test/admin-token.test.mjs`
Expected: FAIL — `Cannot find module '../src/admin-token.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
import crypto from 'node:crypto';

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function generateAdminToken({ keyId, secretHex }, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: keyId };
  const payload = { iat, exp: iat + 300, aud: '/admin/' };

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const signature = crypto
    .createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  return `${headerB64}.${payloadB64}.${signature}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/deploy-verify && node --test test/admin-token.test.mjs`
Expected: PASS, 1/1

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/deploy-verify/src/admin-token.mjs phase2/packages/deploy-verify/test/admin-token.test.mjs
git commit -m "deploy-verify: add Ghost Admin API JWT generation"
```

---

## Task 5: Admin API client (upload / create / get / delete)

**Files:**
- Create: `phase2/packages/deploy-verify/src/admin-api-client.mjs`
- Test: `phase2/packages/deploy-verify/test/admin-api-client.test.mjs`

**Interfaces:**
- Consumes: nothing directly (token is passed in as a plain string by the caller — `bin/verify.mjs` in Task 7 calls `generateAdminToken` from Task 4 itself).
- Produces, all `(baseUrl, token, ..., fetchImpl = fetch)`:
  - `uploadImage(baseUrl, token, { buffer, filename }, fetchImpl) -> Promise<{ url: string }>`
  - `createDraftPost(baseUrl, token, { title, featureImageUrl }, fetchImpl) -> Promise<{ id: string }>`
  - `getPost(baseUrl, token, id, fetchImpl) -> Promise<{ id: string, status: string }>`
  - `deletePost(baseUrl, token, id, fetchImpl) -> Promise<void>`
  These four are used by Task 7's `bin/verify.mjs`; `uploadImage`'s
  returned `url` is also consumed by Task 6's `deleteS3Object`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadImage,
  createDraftPost,
  getPost,
  deletePost,
} from '../src/admin-api-client.mjs';

test('uploadImage posts multipart form data and returns the image URL', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      status: 201,
      json: async () => ({ images: [{ url: 'https://bucket.s3.amazonaws.com/2026/09/test-pixel.png' }] }),
    };
  };

  const result = await uploadImage(
    'https://x/ghost/api/admin',
    'TOKEN',
    { buffer: Buffer.from([1, 2, 3]), filename: 'test-pixel.png' },
    fetchImpl,
  );

  assert.equal(result.url, 'https://bucket.s3.amazonaws.com/2026/09/test-pixel.png');
  assert.equal(seen.url, 'https://x/ghost/api/admin/images/upload/');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, 'Ghost TOKEN');
  assert.ok(seen.opts.body instanceof FormData);
});

test('createDraftPost posts a draft with the feature image and returns its id', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      status: 201,
      json: async () => ({ posts: [{ id: 'post123', status: 'draft' }] }),
    };
  };

  const result = await createDraftPost(
    'https://x/ghost/api/admin',
    'TOKEN',
    { title: 'deploy-verify test post', featureImageUrl: 'https://bucket/img.png' },
    fetchImpl,
  );

  assert.equal(result.id, 'post123');
  assert.equal(seen.url, 'https://x/ghost/api/admin/posts/');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, 'Ghost TOKEN');
  assert.equal(seen.opts.headers['Content-Type'], 'application/json');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.posts[0].title, 'deploy-verify test post');
  assert.equal(body.posts[0].status, 'draft');
  assert.equal(body.posts[0].feature_image, 'https://bucket/img.png');
});

test('getPost fetches by id and returns it', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({ posts: [{ id: 'post123', status: 'draft' }] }) };
  };

  const result = await getPost('https://x/ghost/api/admin', 'TOKEN', 'post123', fetchImpl);

  assert.deepEqual(result, { id: 'post123', status: 'draft' });
  assert.equal(seen.url, 'https://x/ghost/api/admin/posts/post123/');
  assert.equal(seen.opts.headers.Authorization, 'Ghost TOKEN');
});

test('deletePost issues a DELETE and resolves on success', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 204 };
  };

  await deletePost('https://x/ghost/api/admin', 'TOKEN', 'post123', fetchImpl);

  assert.equal(seen.url, 'https://x/ghost/api/admin/posts/post123/');
  assert.equal(seen.opts.method, 'DELETE');
  assert.equal(seen.opts.headers.Authorization, 'Ghost TOKEN');
});

test('a non-ok response throws with the status and body text', async () => {
  const fetchImpl = async () => ({ ok: false, status: 422, text: async () => 'validation failed' });
  await assert.rejects(
    () => getPost('https://x/ghost/api/admin', 'TOKEN', 'post123', fetchImpl),
    /422.*validation failed/s,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/deploy-verify && node --test test/admin-api-client.test.mjs`
Expected: FAIL — `Cannot find module '../src/admin-api-client.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
async function assertOk(response) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ghost Admin API request failed: ${response.status} ${body}`);
  }
  return response;
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Ghost ${token}`, ...extra };
}

export async function uploadImage(baseUrl, token, { buffer, filename }, fetchImpl = fetch) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('purpose', 'image');

  const response = await fetchImpl(`${baseUrl}/images/upload/`, {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
  });
  await assertOk(response);
  const { images } = await response.json();
  return { url: images[0].url };
}

export async function createDraftPost(baseUrl, token, { title, featureImageUrl }, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/posts/`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      posts: [{ title, status: 'draft', feature_image: featureImageUrl }],
    }),
  });
  await assertOk(response);
  const { posts } = await response.json();
  return { id: posts[0].id };
}

export async function getPost(baseUrl, token, id, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/posts/${id}/`, {
    headers: authHeaders(token),
  });
  await assertOk(response);
  const { posts } = await response.json();
  return posts[0];
}

export async function deletePost(baseUrl, token, id, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/posts/${id}/`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await assertOk(response);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/deploy-verify && node --test test/admin-api-client.test.mjs`
Expected: PASS, 5/5

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/deploy-verify/src/admin-api-client.mjs phase2/packages/deploy-verify/test/admin-api-client.test.mjs
git commit -m "deploy-verify: add Ghost Admin API client (upload/create/get/delete)"
```

---

## Task 6: S3 test-image cleanup

**Files:**
- Create: `phase2/packages/deploy-verify/src/s3-object-delete.mjs`
- Test: `phase2/packages/deploy-verify/test/s3-object-delete.test.mjs`

**Interfaces:**
- Consumes: an image URL shaped like Task 5's `uploadImage` result (`{ url }`).
- Produces: `deleteS3Object(bucket, imageUrl, s3Client) -> Promise<void>` — used by Task 7's `bin/verify.mjs`. `s3Client` is injectable (an object with a `send(command)` method, matching `@aws-sdk/client-s3`'s `S3Client`) so the test never touches AWS.

The `cdnUrl` Ghost's `S3Storage` adapter returns points at the bucket
directly (design doc / `hnj9a`'s "Correction" note: no CDN fronts it
yet), so the S3 key is the URL's path with the bucket's own domain
prefix stripped — same shape regardless of virtual-hosted vs
path-style, since both put the key after the bucket name.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteS3Object } from '../src/s3-object-delete.mjs';

test('deleteS3Object sends a DeleteObject command for the URL-derived key', async () => {
  let sentCommand;
  const s3Client = {
    send: async (command) => {
      sentCommand = command;
      return {};
    },
  };

  await deleteS3Object(
    'ghost-phase2-data-699571927575',
    'https://ghost-phase2-data-699571927575.s3.amazonaws.com/2026/09/test-pixel.png',
    s3Client,
  );

  assert.equal(sentCommand.input.Bucket, 'ghost-phase2-data-699571927575');
  assert.equal(sentCommand.input.Key, '2026/09/test-pixel.png');
});

test('deleteS3Object strips a leading slash from a path-style URL key', async () => {
  let sentCommand;
  const s3Client = { send: async (command) => { sentCommand = command; return {}; } };

  await deleteS3Object(
    'ghost-phase2-data-699571927575',
    'https://s3.amazonaws.com/ghost-phase2-data-699571927575/2026/09/test-pixel.png',
    s3Client,
  );

  assert.equal(sentCommand.input.Key, '2026/09/test-pixel.png');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/deploy-verify && node --test test/s3-object-delete.test.mjs`
Expected: FAIL — `Cannot find module '../src/s3-object-delete.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

export async function deleteS3Object(bucket, imageUrl, s3Client) {
  const { pathname } = new URL(imageUrl);
  let key = pathname.replace(/^\//, '');
  if (key.startsWith(`${bucket}/`)) {
    key = key.slice(bucket.length + 1);
  }
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/deploy-verify && node --test test/s3-object-delete.test.mjs`
Expected: PASS, 2/2

- [ ] **Step 5: Commit**

```bash
git add phase2/packages/deploy-verify/src/s3-object-delete.mjs phase2/packages/deploy-verify/test/s3-object-delete.test.mjs
git commit -m "deploy-verify: add direct S3 cleanup for the Admin API roundtrip's test image"
```

---

## Task 7: `verify.mjs` CLI + test fixture

**Files:**
- Create: `phase2/packages/deploy-verify/fixtures/test-pixel.png`
- Create: `phase2/packages/deploy-verify/bin/verify.mjs`

**Interfaces:**
- Consumes: `checkUrls` (Task 3), `generateAdminToken` (Task 4), `uploadImage`/`createDraftPost`/`getPost`/`deletePost` (Task 5), `deleteS3Object` (Task 6).
- Produces: a CLI, invoked as
  `node bin/verify.mjs --public-url <url> --bucket <bucket>`, reading
  `GHOST_ADMIN_API_KEY` (`id:secret`) from the environment (never a CLI
  arg — keeps the secret out of process listings). Exits `0` and prints
  a one-line JSON summary on full success; exits `1` and prints the
  failure detail on any check failing. This is the "no unit test, must
  be exercised for real" wiring layer per the design doc's Testing
  section — no test file for this task, Task 9's plan step covers the
  real end-to-end run.

This is the only fixture in the repo that's a binary file — a minimal
valid 1x1 transparent PNG (68 bytes), used as the Admin API roundtrip's
test image so the request exercises real image bytes, not an empty
buffer.

- [ ] **Step 1: Add the fixture**

Run this once to generate a real, minimal valid PNG (do not hand-write PNG bytes):

```bash
python3 -c "
import struct, zlib
def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
sig = b'\x89PNG\r\n\x1a\n'
ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0))
raw = b'\x00' + b'\xff\xff\xff\x00'
idat = chunk(b'IDAT', zlib.compress(raw))
iend = chunk(b'IEND', b'')
open('phase2/packages/deploy-verify/fixtures/test-pixel.png', 'wb').write(sig + ihdr + idat + iend)
"
```

Expected: `phase2/packages/deploy-verify/fixtures/test-pixel.png` exists, `file` reports it as `PNG image data, 1 x 1, 8-bit/color RGBA, non-interlaced`.

- [ ] **Step 2: Write `bin/verify.mjs`**

```js
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { checkUrls } from '../src/http-smoke-test.mjs';
import { generateAdminToken } from '../src/admin-token.mjs';
import { uploadImage, createDraftPost, getPost, deletePost } from '../src/admin-api-client.mjs';
import { deleteS3Object } from '../src/s3-object-delete.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

async function main() {
  const { 'public-url': publicUrl, bucket } = parseArgs(process.argv.slice(2));
  if (!publicUrl || !bucket) {
    console.error('usage: verify.mjs --public-url <url> --bucket <bucket>');
    process.exit(1);
  }
  const adminApiKey = process.env.GHOST_ADMIN_API_KEY;
  if (!adminApiKey) {
    console.error('GHOST_ADMIN_API_KEY env var is required');
    process.exit(1);
  }
  const base = publicUrl.replace(/\/$/, '');

  const smoke = await checkUrls([`${base}/blog/`, `${base}/blog/ghost/`]);
  if (!smoke.ok) {
    console.log(JSON.stringify({ ok: false, step: 'http-smoke-test', detail: smoke.results }));
    process.exit(1);
  }

  const [keyId, secretHex] = adminApiKey.split(':');
  const token = generateAdminToken({ keyId, secretHex });
  const adminBase = `${base}/blog/ghost/api/admin`;

  let postId;
  let imageUrl;
  try {
    const fixturePath = fileURLToPath(new URL('../fixtures/test-pixel.png', import.meta.url));
    const buffer = await readFile(fixturePath);
    const image = await uploadImage(adminBase, token, { buffer, filename: 'test-pixel.png' });
    imageUrl = image.url;

    const draft = await createDraftPost(adminBase, token, {
      title: `deploy-verify roundtrip ${new Date().toISOString()}`,
      featureImageUrl: imageUrl,
    });
    postId = draft.id;

    const readBack = await getPost(adminBase, token, postId);
    if (readBack.status !== 'draft') {
      throw new Error(`expected draft status, got ${readBack.status}`);
    }
  } catch (err) {
    console.log(JSON.stringify({ ok: false, step: 'admin-api-roundtrip', detail: err.message }));
    process.exit(1);
  } finally {
    if (postId) {
      await deletePost(adminBase, token, postId).catch((err) =>
        console.error(`cleanup: failed to delete test post ${postId}: ${err.message}`),
      );
    }
    if (imageUrl) {
      const s3Client = new S3Client({ region: 'us-east-1' });
      await deleteS3Object(bucket, imageUrl, s3Client).catch((err) =>
        console.error(`cleanup: failed to delete test image ${imageUrl}: ${err.message}`),
      );
    }
  }

  console.log(JSON.stringify({ ok: true }));
}

main();
```

- [ ] **Step 3: Commit**

```bash
git add phase2/packages/deploy-verify/fixtures/test-pixel.png phase2/packages/deploy-verify/bin/verify.mjs
git commit -m "deploy-verify: add verify.mjs CLI (smoke test + Admin API roundtrip)"
```

---

## Task 8: Previous-deployment-tag lookup + CLI

**Files:**
- Create: `phase2/packages/deploy-verify/src/previous-deployment.mjs`
- Test: `phase2/packages/deploy-verify/test/previous-deployment.test.mjs`
- Create: `phase2/packages/deploy-verify/bin/previous-tag.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `findPreviousTag(deploymentsResponse) -> string | null`, where
  `deploymentsResponse` is the parsed JSON of
  `aws lightsail get-container-service-deployments` (shape:
  `{ deployments: [{ version, state, containers: { <name>: { image } } } ] }`,
  ordered newest-version-first, per AWS's documented behavior). Tag is
  the substring after the image's last `:`. Used by `bin/previous-tag.mjs`
  and, indirectly, by Task 9's `deploy.sh` rollback step.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPreviousTag } from '../src/previous-deployment.mjs';

const repo = '699571927575.dkr.ecr.us-east-1.amazonaws.com/ghost-phase2';

test('findPreviousTag returns the second-newest deployment\'s image tag', () => {
  const response = {
    deployments: [
      { version: 3, state: 'ACTIVE', containers: { ghost: { image: `${repo}:new-sha` } } },
      { version: 2, state: 'INACTIVE', containers: { ghost: { image: `${repo}:prev-sha` } } },
      { version: 1, state: 'INACTIVE', containers: { ghost: { image: `${repo}:oldest-sha` } } },
    ],
  };
  assert.equal(findPreviousTag(response), 'prev-sha');
});

test('findPreviousTag returns null when there is only one deployment', () => {
  const response = {
    deployments: [{ version: 1, state: 'ACTIVE', containers: { ghost: { image: `${repo}:only-sha` } } }],
  };
  assert.equal(findPreviousTag(response), null);
});

test('findPreviousTag returns null with no deployments at all', () => {
  assert.equal(findPreviousTag({ deployments: [] }), null);
});

test('findPreviousTag sorts by version regardless of input order', () => {
  const response = {
    deployments: [
      { version: 1, state: 'INACTIVE', containers: { ghost: { image: `${repo}:oldest-sha` } } },
      { version: 3, state: 'ACTIVE', containers: { ghost: { image: `${repo}:new-sha` } } },
      { version: 2, state: 'INACTIVE', containers: { ghost: { image: `${repo}:prev-sha` } } },
    ],
  };
  assert.equal(findPreviousTag(response), 'prev-sha');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd phase2/packages/deploy-verify && node --test test/previous-deployment.test.mjs`
Expected: FAIL — `Cannot find module '../src/previous-deployment.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
export function findPreviousTag(deploymentsResponse, containerName = 'ghost') {
  const sorted = [...(deploymentsResponse.deployments ?? [])].sort((a, b) => b.version - a.version);
  if (sorted.length < 2) return null;
  const image = sorted[1].containers[containerName].image;
  return image.slice(image.lastIndexOf(':') + 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd phase2/packages/deploy-verify && node --test test/previous-deployment.test.mjs`
Expected: PASS, 4/4

- [ ] **Step 5: Write `bin/previous-tag.mjs`**

```js
#!/usr/bin/env node
import { findPreviousTag } from '../src/previous-deployment.mjs';

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const tag = findPreviousTag(JSON.parse(input));
  if (!tag) {
    console.error('no previous deployment to roll back to');
    process.exit(3);
  }
  process.stdout.write(tag);
});
```

- [ ] **Step 6: Commit**

```bash
git add phase2/packages/deploy-verify/src/previous-deployment.mjs phase2/packages/deploy-verify/test/previous-deployment.test.mjs phase2/packages/deploy-verify/bin/previous-tag.mjs
git commit -m "deploy-verify: add previous-deployment-tag lookup + CLI"
```

---

## Task 9: `deploy.sh` orchestrator

**Files:**
- Create: `phase2/scripts/deploy.sh`

**Interfaces:**
- Consumes: `phase2/docker/build.sh` (unchanged, run as-is), `phase2/iac/` via `tofu`, `phase2/packages/deploy-verify/bin/verify.mjs` (Task 7) and `bin/previous-tag.mjs` (Task 8), the `public_url`/`bucket_name` outputs (Task 1 + existing `s3.tf` output).
- Produces: the pipeline itself — no other task consumes this.

- [ ] **Step 1: Write `phase2/scripts/deploy.sh`**

```bash
#!/usr/bin/env bash
# Full deploy pipeline: build & push, apply, verify, roll back on failure.
# See docs/superpowers/specs/2026-09-08-phase2-deploy-observability-design.md
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IAC_DIR="$REPO_ROOT/phase2/iac"
VERIFY_DIR="$REPO_ROOT/phase2/packages/deploy-verify"
SERVICE_NAME="ghost-phase2"
REGION="us-east-1"

tofu_() { nix-shell -p opentofu --run "cd '$IAC_DIR' && tofu $*"; }

echo "== Step 1/4: build & push =="
NEW_TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
"$REPO_ROOT/phase2/docker/build.sh"

echo "== Step 2/4: tofu apply (image_tag=$NEW_TAG) =="
if ! tofu_ "apply -auto-approve -var image_tag=$NEW_TAG"; then
  echo "DEPLOY FAILED at tofu apply -- Lightsail rejected the new version." >&2
  echo "The previously ACTIVE deployment is untouched and still serving. No rollback needed." >&2
  exit 1
fi

PUBLIC_URL="$(tofu_ "output -raw public_url")"
BUCKET="$(tofu_ "output -raw bucket_name")"

echo "== Step 3/4: verification (smoke test + Admin API roundtrip) =="
GHOST_ADMIN_API_KEY="$(aws ssm get-parameter --name ghost_phase2_admin_api_key --with-decryption --region "$REGION" --query Parameter.Value --output text)"
export GHOST_ADMIN_API_KEY

if node "$VERIFY_DIR/bin/verify.mjs" --public-url "$PUBLIC_URL" --bucket "$BUCKET"; then
  echo "== Step 4/4: SUCCESS -- $NEW_TAG is live and verified =="
  exit 0
fi

echo "Verification failed for $NEW_TAG. Looking up the previous deployment to roll back to..." >&2

DEPLOYMENTS_JSON="$(aws lightsail get-container-service-deployments --service-name "$SERVICE_NAME" --region "$REGION")"
if ! PREVIOUS_TAG="$(echo "$DEPLOYMENTS_JSON" | node "$VERIFY_DIR/bin/previous-tag.mjs")"; then
  echo "DEPLOY FAILED verification, and there is no previous deployment to roll back to (first-ever deploy)." >&2
  echo "The new, failing deployment ($NEW_TAG) is left live -- there is nothing safer to fall back to." >&2
  exit 1
fi

echo "== Step 4/4: rolling back to $PREVIOUS_TAG =="
if ! tofu_ "apply -auto-approve -var image_tag=$PREVIOUS_TAG"; then
  echo "ROLLBACK ALSO FAILED. Manual intervention needed. Currently-live tag is whatever Lightsail last had ACTIVE (check 'aws lightsail get-container-service-deployments')." >&2
  exit 1
fi

echo "DEPLOY FAILED verification for $NEW_TAG. Rolled back successfully -- $PREVIOUS_TAG is now live." >&2
exit 1
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x phase2/scripts/deploy.sh`

- [ ] **Step 3: Shellcheck**

Run: `nix-shell -p shellcheck --run "shellcheck phase2/scripts/deploy.sh"`
Expected: no errors (warnings about the `tofu_` word-splitting helper are expected and intentional — it's building a command string for `nix-shell --run` on purpose).

- [ ] **Step 4: Commit**

```bash
git add phase2/scripts/deploy.sh
git commit -m "deploy: add deploy.sh orchestrating build, apply, verify, and rollback"
```

---

## Task 10: One-time Admin API key provisioning + real end-to-end run

This task is **not automatable** — it requires a human to click through
Ghost's admin panel and requires real AWS spend/infra. Do not attempt to
script around it; stop and hand this task to the user when reached.

**Files:** none (operational task, `.local-secrets.md` gets a new entry per this repo's sensitive-data convention).

- [ ] **Step 1: Re-apply the torn-down infra**

Run: `nix-shell -p opentofu --run "cd phase2/iac && tofu apply -auto-approve -var image_tag=<current short-SHA>"` (or just run `phase2/scripts/deploy.sh` once — steps 3-4 will fail with no Admin API key yet, which is expected; that's what this task provisions).

- [ ] **Step 2 (user): create the Admin API Custom Integration**

In the live Ghost admin panel (`<public_url>/blog/ghost/#/settings/integrations/new`), create a Custom Integration named e.g. "deploy-verify", copy its Admin API Key (`id:secret`).

- [ ] **Step 3 (user or agent, with the key from step 2): store it in SSM**

```bash
aws ssm put-parameter --name ghost_phase2_admin_api_key --type SecureString --value '<id:secret from step 2>' --region us-east-1
```

Then add an entry to `.local-secrets.md` under a "Phase 2 Deploy Observability (moth i8hlt)" heading recording that this parameter exists (not its value).

- [ ] **Step 4: Run the real pipeline end-to-end**

Run: `phase2/scripts/deploy.sh`
Expected: exits 0, prints `{"ok":true}`-shaped success line, admin panel shows no leftover draft post, S3 bucket shows no leftover test image.

- [ ] **Step 5: Exercise the rollback path for real**

Deliberately deploy a tag that will fail verification (e.g. temporarily
edit `phase2/iac/deployment.tf`'s `GHOST_URL` env var to a wrong subpath
so the smoke test 404s, commit, run `deploy.sh`, confirm it detects the
failure and rolls back to the previous tag, then revert that temporary
change and redeploy the real tag).

- [ ] **Step 6: Update the moth ticket**

Once steps 1-5 are verified for real, append a "Verification" section to
`i8hlt` via `moth update` (read `moth show i8hlt` first, append, never
overwrite) recording what was verified and how. Do not run `moth done`
— that decision belongs to the user.
