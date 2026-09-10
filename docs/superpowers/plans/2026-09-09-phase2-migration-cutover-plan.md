# Phase 2 Migration & Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tooling and infrastructure changes that move the live blog off the Phase 1 EC2 instance onto the Phase 2 Lightsail/S3 stack, with validation gates and a fast way back.

**Architecture:** Four independent pieces, each landing on its own: feature-flagged IaC so infrastructure comes up in stages (prereqs → Lightsail → CloudFront repoint); a backup extension that takes a clean `VACUUM INTO` database snapshot and syncs images straight to their final S3 location; a seeder that turns a plain SQLite file into the initial state of the S3-backed store (plus its inverse, which doubles as disaster recovery); and a validation CLI that compares the source database against the post-boot one and checks post/user/tag counts and every image, as a hard gate before traffic moves.

**Tech Stack:** OpenTofu (AWS provider ~> 5.0), AWS Lightsail Container Service, CloudFront, S3, ECR, Node.js >= 20 ESM (`.mjs` / `.js` with `"type": "module"`), `node --test`, `better-sqlite3`, `@aws-sdk/client-s3`, bash + AWS SSM.

**Spec:** `docs/superpowers/specs/2026-09-09-phase2-migration-cutover-design.md`

## Global Constraints

- Node >= 20, ESM only. `sqlite-s3` uses `.js` (package `"type": "module"`); `deploy-verify` and `ghost-sqlite-s3-launcher` use `.mjs`. Follow the extension already used in the package you are editing.
- Tests are `node --test`, colocated in the package's `test/` directory, using `node:test` + `node:assert/strict`. No test framework dependencies.
- All new logic is injectable: pass `fetchImpl = fetch`, `s3Client`, or an already-open database handle as a parameter so tests never hit the network or the real AWS.
- **Never put exact AWS resource IDs, account IDs, credential/parameter names, or similar identifiers into tracked files** (CLAUDE.md, Sensitive data). Reference resources by role/tag and point at `.local-secrets.md`. This applies to the CloudFront distribution ID, the state bucket name, and the EC2 instance ID.
- IaC region is `us-east-1`; provider default tag `app = "ghost-phase2"`.
- OpenTofu state lives in the S3 backend: every `tofu` command in this repo runs after `tofu init -backend-config=backend.hcl` in `phase2/iac/`.
- Bash scripts: `#!/usr/bin/env bash`, `set -euo pipefail`, and must pass `shellcheck`.
- Image key layout is fixed: `staticFileURLPrefix` = `blog/content/images`, `cdnUrl` = the site origin (no path). The rendered URL is `<origin>/blog/content/images/<relative path>` and the S3 key is `blog/content/images/<relative path>` — a 1:1 mapping, no URI rewriting anywhere.
- The seeder must never overwrite a live store, and has no `--force`.
- Do NOT run `moth done` or `moth start`. Do NOT run `tofu apply`, `tofu import`, or any AWS mutation against live infrastructure — those are operator runbook steps; package them as commands for the user to run.

---

## File Structure

**`phase2/packages/ghost-sqlite-s3-launcher/`**
- `src/storage-config.mjs` (modify) — derives `cdnUrl` and `staticFileURLPrefix` from `GHOST_URL` so path→key is 1:1.
- `src/preload.mjs` (modify) — passes `ghostUrl` instead of a hand-built `cdnUrl`.

**`phase2/iac/`**
- `variables.tf` (create) — `deploy_lightsail`, `deploy_cloudfront`, and the cross-flag validation.
- `lightsail.tf`, `iam.tf`, `deployment.tf`, `outputs.tf` (modify) — `count`-gated on `deploy_lightsail`.
- `cloudfront.tf` (create) — the imported Phase 1 distribution, with `/blog*` behaviours switching origin on `deploy_cloudfront`, plus the OAC for serving images out of the data bucket.
- `s3.tf` (modify) — bucket policy allowing CloudFront (OAC) to read the image prefix.

**`scripts/`**
- `ssm-backup-instance.sh` (modify) — two new optional flags: `--vacuum-db` (clean snapshot via `VACUUM INTO`) and `--sync-images <s3-uri>` (direct sync to the final image location).

**`phase2/packages/sqlite-s3/`**
- `src/seed.js` (create) — `seedStoreFromSqliteFile`; refuses a non-empty store.
- `src/dump.js` (create) — `dumpStoreToSqliteFile`; the inverse, and the store's disaster-recovery path.
- `bin/seed-from-sqlite.mjs`, `bin/dump-to-sqlite.mjs` (create) — thin CLIs that wire the S3 object store to those functions.
- `test/seed.test.js`, `test/dump.test.js` (create).

**`phase2/packages/deploy-verify/`**
- `src/db-compare.mjs` (create) — row counts, content-table checksums, settings diff, and the boot-mutation allowlist.
- `src/content-check.mjs` (create) — count assertions, image-URL extraction, and the two image checkers (S3 HeadObject pre-cutover, HTTP post-cutover).
- `src/admin-api-client.mjs` (modify) — add `getResourceTotal` and `listRecentPosts`.
- `bin/validate-migration.mjs` (create) — the operator-facing gate: runs both checks, prints the visual-check URLs, exits non-zero on any failure.
- `test/db-compare.test.mjs`, `test/content-check.test.mjs` (create), `test/admin-api-client.test.mjs` (modify).

**`phase2/readme.md`** (modify) — the cutover runbook.

---

### Task 1: Image key prefix derived from `GHOST_URL`

Ghost's `S3Storage.buildKey` joins `staticFileURLPrefix` with the relative path and returns `${cdnUrl}/${key}`. Today the launcher sets `staticFileURLPrefix: 'content/images'` and `cdnUrl` to the private bucket's own URL, so public image URLs do not resolve at all. Requests will arrive as `/blog/content/images/…` and CloudFront's `OriginPath` prepends rather than strips, so the key must carry the `blog/` prefix for the mapping to be 1:1.

**Files:**
- Modify: `phase2/packages/ghost-sqlite-s3-launcher/src/storage-config.mjs`
- Modify: `phase2/packages/ghost-sqlite-s3-launcher/src/preload.mjs:136-141`
- Test: `phase2/packages/ghost-sqlite-s3-launcher/test/storage-config.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `buildS3StorageConfig({ bucket, region, ghostUrl }) -> { bucket, region, staticFileURLPrefix, cdnUrl, multipartUploadThresholdBytes, multipartChunkSizeBytes }`. The `cdnUrl` is `new URL(ghostUrl).origin`; `staticFileURLPrefix` is the `GHOST_URL` path (leading/trailing slashes stripped) joined with `content/images`. Tasks 4 and 8 rely on the resulting key layout `blog/content/images/<relative path>`.

- [ ] **Step 1: Replace the existing test with the new signature's tests**

Replace the whole contents of `phase2/packages/ghost-sqlite-s3-launcher/test/storage-config.test.mjs` with:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildS3StorageConfig } from '../src/storage-config.mjs';

test('buildS3StorageConfig derives the cdn url and key prefix from a subpath GHOST_URL', () => {
  const result = buildS3StorageConfig({
    bucket: 'ghost-phase2-data',
    region: 'us-east-1',
    ghostUrl: 'https://example.com/blog',
  });

  assert.deepEqual(result, {
    bucket: 'ghost-phase2-data',
    region: 'us-east-1',
    staticFileURLPrefix: 'blog/content/images',
    cdnUrl: 'https://example.com',
    multipartUploadThresholdBytes: 25 * 1024 * 1024,
    multipartChunkSizeBytes: 5 * 1024 * 1024,
  });
});

test('buildS3StorageConfig tolerates a trailing slash on GHOST_URL', () => {
  const result = buildS3StorageConfig({
    bucket: 'b',
    region: 'us-east-1',
    ghostUrl: 'https://example.com/blog/',
  });

  assert.equal(result.staticFileURLPrefix, 'blog/content/images');
  assert.equal(result.cdnUrl, 'https://example.com');
});

test('buildS3StorageConfig handles a root-hosted GHOST_URL', () => {
  const result = buildS3StorageConfig({
    bucket: 'b',
    region: 'us-east-1',
    ghostUrl: 'https://example.com',
  });

  assert.equal(result.staticFileURLPrefix, 'content/images');
  assert.equal(result.cdnUrl, 'https://example.com');
});

test('buildS3StorageConfig rejects a GHOST_URL that is not a valid absolute URL', () => {
  assert.throws(
    () => buildS3StorageConfig({ bucket: 'b', region: 'us-east-1', ghostUrl: 'not-a-url' }),
    /ghostUrl must be an absolute URL/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/storage-config.test.mjs`
Expected: FAIL — the current implementation ignores `ghostUrl` and returns `staticFileURLPrefix: 'content/images'` with `cdnUrl: undefined`.

- [ ] **Step 3: Rewrite `storage-config.mjs`**

Replace the whole file with:

```javascript
/**
 * Ghost's S3Storage adapter config shape (config.set('storage:S3Storage', ...),
 * with config.set('storage:active', 'S3Storage') set alongside it — see
 * preload.mjs). No accessKeyId/secretAccessKey: S3Storage falls back to the
 * ambient credential chain, which the credential_process profile (see
 * aws-credentials.mjs) already points at the assumed app-runtime role.
 *
 * Key layout: S3Storage.buildKey joins staticFileURLPrefix with the image's
 * relative path and returns `${cdnUrl}/${key}`. Both are derived from
 * GHOST_URL so that the public path and the S3 key are identical modulo the
 * leading slash — CloudFront's OriginPath prepends rather than strips, so
 * anything else would need a URI-rewriting CloudFront Function. With
 * GHOST_URL=https://example.com/blog an image is served from
 * https://example.com/blog/content/images/... and stored at the key
 * blog/content/images/... .
 */
export function buildS3StorageConfig({ bucket, region, ghostUrl }) {
  let url;
  try {
    url = new URL(ghostUrl);
  } catch {
    throw new Error(`ghostUrl must be an absolute URL, got: ${ghostUrl}`);
  }

  const basePath = url.pathname.replace(/^\/+|\/+$/g, '');
  const staticFileURLPrefix = basePath ? `${basePath}/content/images` : 'content/images';

  return {
    bucket,
    region,
    staticFileURLPrefix,
    cdnUrl: url.origin,
    multipartUploadThresholdBytes: 25 * 1024 * 1024,
    multipartChunkSizeBytes: 5 * 1024 * 1024,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test test/storage-config.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Update the caller in `preload.mjs`**

`preload.mjs` already has `ghostUrl` in scope (it reads and validates `process.env.GHOST_URL` before `config.set('url', ghostUrl)`). Replace the storage block at the end of the file:

```javascript
config.set('storage:active', 'S3Storage');
config.set('storage:S3Storage', buildS3StorageConfig({ bucket, region, ghostUrl }));
console.error('[boot] storage config set');
```

- [ ] **Step 6: Run the launcher's full suite**

Run: `cd phase2/packages/ghost-sqlite-s3-launcher && node --test`
Expected: PASS, no failures.

- [ ] **Step 7: Commit**

```bash
git add phase2/packages/ghost-sqlite-s3-launcher/src/storage-config.mjs \
        phase2/packages/ghost-sqlite-s3-launcher/src/preload.mjs \
        phase2/packages/ghost-sqlite-s3-launcher/test/storage-config.test.mjs
git commit -m "launcher: derive image cdn url and key prefix from GHOST_URL"
```

---

### Task 2: IaC feature flags (prereqs / Lightsail split)

With no flags set, `phase2/iac/` must bring up only the S3 data bucket and the ECR repository — enough to push an image and seed the store before anything runs. The app-runtime IAM role's trust policy names the container service's own top-level `principal_arn`, and `assume_role_policy` is a required attribute that cannot be filled in later, so IAM moves under the Lightsail flag rather than staying a prereq. The ECR *repository* stays a prereq; its Lightsail pull policy moves under the flag because it names Lightsail's puller principal.

**Files:**
- Create: `phase2/iac/variables.tf`
- Modify: `phase2/iac/lightsail.tf`, `phase2/iac/iam.tf`, `phase2/iac/deployment.tf`, `phase2/iac/outputs.tf`, `phase2/scripts/deploy.sh`
- Test: `tofu validate` and `tofu plan` (there is no unit-test framework for HCL in this repo)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: variables `deploy_lightsail` (bool, default `false`) and `deploy_cloudfront` (bool, default `false`), consumed by Task 3. Outputs `lightsail_service_name`, `public_url`, `app_runtime_role_arn` become `null` when `deploy_lightsail = false`.

- [ ] **Step 1: Create `phase2/iac/variables.tf`**

`var.image_tag` currently lives at the bottom of `deployment.tf`; move it here so all variables sit in one file.

```hcl
variable "image_tag" {
  type        = string
  description = "Git short-SHA tag of the image to deploy (set via -var on each deploy)"
  # Only read when deploy_lightsail = true; the prereq-only apply has no image
  # to deploy yet, so it must not require a value.
  default     = ""
}

variable "deploy_lightsail" {
  type        = bool
  description = "Bring up the container service, its deployment, and the app-runtime IAM role. With this false only the prereqs (S3 data bucket, ECR repository) exist."
  default     = false
}

variable "deploy_cloudfront" {
  type        = bool
  description = "Point the CloudFront /blog* behaviours at Lightsail instead of the Phase 1 EC2 origin, and add the image behaviour. This is the cutover switch."
  default     = false

  validation {
    # Nothing to point at otherwise. Caught at plan time rather than as a
    # confusing provider error mid-apply.
    condition     = var.deploy_cloudfront == false || var.deploy_lightsail == true
    error_message = "deploy_cloudfront requires deploy_lightsail = true: there would be no Lightsail origin to point the behaviours at."
  }
}
```

Cross-variable references inside a `validation` block need OpenTofu >= 1.9. Check the version first:

```bash
nix-shell -p opentofu --run 'tofu version'
```

If it is below 1.9, delete the `validation` block above and add this instead, after the variable declarations:

```hcl
# Cross-variable validation for OpenTofu < 1.9, which cannot reference other
# variables inside a variable validation block.
resource "terraform_data" "flag_guard" {
  lifecycle {
    precondition {
      condition     = var.deploy_cloudfront == false || var.deploy_lightsail == true
      error_message = "deploy_cloudfront requires deploy_lightsail = true: there would be no Lightsail origin to point the behaviours at."
    }
  }
}
```

- [ ] **Step 2: Remove the variable block from `deployment.tf` and gate the deployment**

Delete lines 40-43 of `phase2/iac/deployment.tf` (the `variable "image_tag"` block). Change the resource header to add `count` and index the gated service:

```hcl
resource "aws_lightsail_container_service_deployment_version" "ghost" {
  count = var.deploy_lightsail ? 1 : 0

  service_name = aws_lightsail_container_service.ghost[0].name
```

Inside the `container` block, index the one other reference to a now-gated resource. `aws_ecr_repository.ghost` and `aws_s3_bucket.data` are prereqs and stay un-indexed:

```hcl
      AWS_ROLE_ARN = aws_iam_role.app_runtime[0].arn
```

Leave the rest of the `container` and `public_endpoint` blocks — including the health-check comment about the `/blog/` subpath — exactly as they are.

- [ ] **Step 3: Gate `lightsail.tf`**

Add `count` to both resources and index the cross-references:

```hcl
resource "aws_lightsail_container_service" "ghost" {
  count = var.deploy_lightsail ? 1 : 0

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

# The ECR *repository* is a prereq (the image is pushed before Lightsail
# exists), but this policy names Lightsail's own puller principal, so it can
# only exist once the service does.
resource "aws_ecr_repository_policy" "lightsail_pull" {
  count = var.deploy_lightsail ? 1 : 0

  repository = aws_ecr_repository.ghost.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowLightsailPull"
      Effect = "Allow"
      Principal = {
        AWS = aws_lightsail_container_service.ghost[0].private_registry_access[0].ecr_image_puller_role[0].principal_arn
      }
      Action = [
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]
    }]
  })
}
```

- [ ] **Step 4: Gate `iam.tf`**

Keep the existing explanatory comment block at the top of the file verbatim — it records a real past bug. Add `count` to the trust-policy data source, the role, and the role policy:

```hcl
data "aws_iam_policy_document" "app_runtime_trust" {
  count = var.deploy_lightsail ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [aws_lightsail_container_service.ghost[0].principal_arn]
    }
  }
}

resource "aws_iam_role" "app_runtime" {
  count = var.deploy_lightsail ? 1 : 0

  name               = "ghost-phase2-app-runtime"
  assume_role_policy = data.aws_iam_policy_document.app_runtime_trust[0].json
}
```

`data "aws_kms_alias" "ssm_default"` stays un-gated (a read-only lookup that costs nothing). `data "aws_iam_policy_document" "app_runtime_permissions"` also stays un-gated — it references only the S3 bucket and the account ID, both prereqs. Gate only the role policy that attaches it:

```hcl
resource "aws_iam_role_policy" "app_runtime_permissions" {
  count = var.deploy_lightsail ? 1 : 0

  name   = "ghost-phase2-app-runtime-permissions"
  role   = aws_iam_role.app_runtime[0].id
  policy = data.aws_iam_policy_document.app_runtime_permissions.json
}
```

- [ ] **Step 5: Make the outputs flag-safe**

Replace `phase2/iac/outputs.tf` with:

```hcl
output "bucket_name" {
  value = aws_s3_bucket.data.bucket
}

output "ecr_repository_url" {
  value = aws_ecr_repository.ghost.repository_url
}

# The three Lightsail-dependent outputs are null when deploy_lightsail is
# false. `one()` turns a count-gated resource's 0-or-1 element list into
# null-or-the-value, which is exactly the shape callers want; deploy.sh reads
# these with `tofu output -raw` and will print an empty string.
output "app_runtime_role_arn" {
  value = one(aws_iam_role.app_runtime[*].arn)
}

output "lightsail_service_name" {
  value = one(aws_lightsail_container_service.ghost[*].name)
}

output "public_url" {
  value = one(aws_lightsail_container_service.ghost[*].url)
}
```

- [ ] **Step 6: Validate and inspect all three plans**

```bash
cd phase2/iac
nix-shell -p opentofu --run 'tofu init -backend-config=backend.hcl'
nix-shell -p opentofu --run 'tofu validate'
nix-shell -p opentofu --run 'tofu plan -var image_tag=deadbeef'
nix-shell -p opentofu --run 'tofu plan -var deploy_lightsail=true -var image_tag=deadbeef'
nix-shell -p opentofu --run 'tofu plan -var deploy_cloudfront=true -var image_tag=deadbeef'
```

Expected: `validate` succeeds. The first plan proposes *destroying* the Lightsail service, the deployment, the IAM role/policy and the ECR repository policy (the flag defaults to false and those resources currently exist in state) and leaves the bucket and repository alone — read it, confirm exactly that set, and **do not apply it**. The second plan is empty or near-empty. The third fails with the `deploy_cloudfront requires deploy_lightsail = true` error message.

Quote the first plan's resource list in your task report; the operator decides when that down-then-up happens.

- [ ] **Step 7: Make `deploy.sh` pass the flag**

`deploy.sh` deploys the running service, so it must set the flag. In `phase2/scripts/deploy.sh`, change both `tofu apply` invocations (lines 19 and 47) to include `-var deploy_lightsail=true`:

```bash
# deploy_lightsail=true, and deploy_cloudfront deliberately left at its
# default false: a routine deploy must never move public traffic. The cutover
# is a separate, explicit apply (see phase2/readme.md).
if ! tofu_ "apply -auto-approve -var deploy_lightsail=true -var image_tag=$NEW_TAG"; then
```

```bash
if ! tofu_ "apply -auto-approve -var deploy_lightsail=true -var image_tag=$PREVIOUS_TAG"; then
```

- [ ] **Step 8: Shellcheck and commit**

```bash
shellcheck phase2/scripts/deploy.sh
git add phase2/iac/ phase2/scripts/deploy.sh
git commit -m "iac: stage the stack behind deploy_lightsail/deploy_cloudfront flags"
```

---

### Task 3: CloudFront in IaC, with the `/blog*` origin switch

The distribution is a Phase 1 resource created by hand: it serves the marketing root from S3 and `/blog` from the EC2 VPC origin, and it owns the site's certificate and DNS target. It is *not* gated by `deploy_cloudfront` — it always exists once imported, and the flag switches which origin its `/blog*` behaviours point at. Because it serves the entire site, it carries `prevent_destroy`.

**The HCL is not written from memory.** Import it, let OpenTofu generate the configuration, trim it, then iterate until `tofu plan` reports no changes. That empty plan is the safety gate; nothing else in this task is trustworthy without it.

**Files:**
- Create: `phase2/iac/cloudfront.tf`
- Modify: `phase2/iac/s3.tf`
- Test: an empty `tofu plan` for the distribution with `deploy_cloudfront = false`

**Interfaces:**
- Consumes: `var.deploy_lightsail`, `var.deploy_cloudfront` (Task 2); `aws_lightsail_container_service.ghost[0].url` for the origin domain; `aws_s3_bucket.data` for the image origin.
- Produces: no code consumed by later tasks. The cutover runbook (Task 9) flips `deploy_cloudfront`.

- [ ] **Step 1: Write the import block and generate the configuration**

The distribution ID is in `.local-secrets.md` under the Phase 1 heading — read it from there; **never** paste it into a tracked file. Create a throwaway `phase2/iac/import.tf` (deleted in Step 3):

```hcl
import {
  to = aws_cloudfront_distribution.site
  id = "REPLACE_WITH_ID_FROM_LOCAL_SECRETS"
}
```

Then generate:

```bash
cd phase2/iac
nix-shell -p opentofu --run 'tofu plan -generate-config-out=cloudfront_generated.tf -var deploy_lightsail=true -var image_tag=deadbeef'
```

Expected: a `cloudfront_generated.tf` holding the live distribution's full configuration, and a plan reporting 1 to import, 0 to change.

- [ ] **Step 2: Move the generated config into `cloudfront.tf` and make the origin switchable**

Copy the generated resource into `phase2/iac/cloudfront.tf` verbatim, then make exactly these edits.

1. Add a `lifecycle` block, because `tofu destroy` on this directory was routine at the end of `hnj9a` and this distribution serves the whole site:

```hcl
  lifecycle {
    prevent_destroy = true
  }
```

2. Add a Lightsail origin and an image origin alongside the existing EC2 VPC origin. Leave the generated origin blocks untouched; append:

```hcl
  # The Lightsail origin exists only while the container service does. With
  # deploy_lightsail = false this list is empty and the /blog* behaviours keep
  # pointing at the Phase 1 EC2 origin.
  dynamic "origin" {
    for_each = var.deploy_lightsail ? [1] : []
    content {
      origin_id   = "lightsail-ghost-phase2"
      domain_name = replace(replace(aws_lightsail_container_service.ghost[0].url, "https://", ""), "/", "")

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # The data bucket, so /blog/content/images/* is served straight from S3
  # rather than through the container. The OAC below is what makes this
  # readable while the bucket itself stays private.
  dynamic "origin" {
    for_each = var.deploy_cloudfront ? [1] : []
    content {
      origin_id                = "s3-ghost-phase2-data"
      domain_name              = aws_s3_bucket.data.bucket_regional_domain_name
      origin_access_control_id = aws_cloudfront_origin_access_control.data[0].id
    }
  }
```

3. In the existing `/blog*` ordered cache behaviour, make the target conditional. Copy the EC2 origin's `origin_id` verbatim out of the generated config for the false branch:

```hcl
    target_origin_id = var.deploy_cloudfront ? "lightsail-ghost-phase2" : "<the existing EC2 origin_id, copied verbatim>"
```

4. Add the image behaviour. `ordered_cache_behavior` blocks are matched in the order they appear, so this block must come *before* the `/blog*` one in the file:

```hcl
  dynamic "ordered_cache_behavior" {
    for_each = var.deploy_cloudfront ? [1] : []
    content {
      path_pattern           = "/blog/content/images/*"
      target_origin_id       = "s3-ghost-phase2-data"
      viewer_protocol_policy = "redirect-to-https"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true

      forwarded_values {
        query_string = false
        cookies {
          forward = "none"
        }
      }
    }
  }
```

On keys: the request path is `/blog/content/images/x.png` and the S3 key is `blog/content/images/x.png`. CloudFront drops the leading slash when forming the origin request, so no `origin_path` and no URI rewriting is needed — which is exactly why Task 1 put `blog/` into the prefix.

- [ ] **Step 3: Add the OAC and the bucket policy**

Append to `phase2/iac/cloudfront.tf`:

```hcl
resource "aws_cloudfront_origin_access_control" "data" {
  count = var.deploy_cloudfront ? 1 : 0

  name                              = "ghost-phase2-data"
  description                       = "Lets the site distribution read images out of the private phase2 data bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
```

Append to `phase2/iac/s3.tf`:

```hcl
# Read access for the site distribution, scoped to the image prefix only — the
# same bucket also holds the SQLite store's segments and manifest, which must
# never be publicly reachable. The public access block above stays fully on;
# an OAC bucket policy is not "public" access.
data "aws_iam_policy_document" "data_cloudfront_read" {
  count = var.deploy_cloudfront ? 1 : 0

  statement {
    sid       = "AllowCloudFrontOACReadImages"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.data.arn}/blog/content/images/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "data_cloudfront_read" {
  count = var.deploy_cloudfront ? 1 : 0

  bucket = aws_s3_bucket.data.id
  policy = data.aws_iam_policy_document.data_cloudfront_read[0].json
}
```

Then delete the throwaway files:

```bash
rm phase2/iac/import.tf phase2/iac/cloudfront_generated.tf
```

- [ ] **Step 4: Prove the empty plan**

```bash
cd phase2/iac
nix-shell -p opentofu --run 'tofu validate'
nix-shell -p opentofu --run 'tofu plan -var deploy_lightsail=true -var image_tag=deadbeef'
```

Expected, and this is the gate: **no changes** to `aws_cloudfront_distribution.site`. If the plan wants to change any distribution attribute, the HCL does not match reality — fix the HCL, never the distribution. Iterate until the distribution shows no diff. Do not proceed while any diff remains.

Then confirm the cutover plan is the switch you expect:

```bash
nix-shell -p opentofu --run 'tofu plan -var deploy_lightsail=true -var deploy_cloudfront=true -var image_tag=deadbeef'
```

Expected: the distribution updates in place (Lightsail and S3 origins added, `/blog*` target changed, image behaviour added), plus the new OAC and bucket policy. No destroy of the distribution.

- [ ] **Step 5: Commit**

```bash
git add phase2/iac/cloudfront.tf phase2/iac/s3.tf
git commit -m "iac: bring the site CloudFront distribution under phase2 state"
```

Quote both plan outputs (the empty one and the cutover one) in your task report. The import itself is an operator step (Task 9's runbook) — do not run `tofu apply`.

---

### Task 4: Backup extension — clean database snapshot and image sync

`scripts/ssm-backup-instance.sh` today tars `config.production.json`, the Ghost data directory, and nginx config, and pulls the tarball over SSM. Two additions are needed for the cutover, both optional flags so existing behaviour is unchanged when they are absent.

The database must be captured with `VACUUM INTO`, not a file copy: Ghost is running, so a copied `.db` is a torn snapshot with its WAL in a separate file. `VACUUM INTO` is safe against a live database and produces a single clean file with the WAL folded in — exactly the shape the seeder in Task 5 needs.

Images go straight from the instance to their final location in the data bucket. They are ~15MB, well past what the base64 chunked SSM transfer (`ssm-scp.sh`) can carry, and a staging copy buys nothing.

**Files:**
- Modify: `scripts/ssm-backup-instance.sh`
- Test: `shellcheck`, plus a real run (operator step)

**Interfaces:**
- Consumes: `run_command` and `ssm_pull` from `scripts/ssm-scp.sh --lib` (already sourced by this script).
- Produces: `.instance-backups/<timestamp>.db` — the clean SQLite snapshot consumed by Task 5's seeder and Task 7's comparison. Images at `s3://<data bucket>/blog/content/images/…`, checked by Task 8's S3 image checker.

- [ ] **Step 1: Replace the header comment and add argument parsing**

Replace lines 1-17 (the header comment through `set -euo pipefail`) with:

```bash
#!/usr/bin/env bash
# Back up the Ghost instance's config and posts (not its software) to a local
# file, over SSM only (the instance has no SSH). Run before any change to
# CloudFront or the instance's nginx/Ghost config.
#
# Backs up:
#   - Ghost's config.production.json
#   - Ghost's SQLite data directory (the posts database)
#   - /etc/nginx/sites-enabled/ (the reverse-proxy config)
#
# Does NOT back up: Ghost/node_modules/themes (software - reinstallable).
#
# Two extra modes exist for the phase 2 migration (moth i8hlt):
#
#   --vacuum-db
#       Also produce a clean, single-file SQLite snapshot via `VACUUM INTO`
#       and pull it out alongside the tarball. A plain file copy of a live
#       Ghost database is torn and leaves the WAL in a separate file; the
#       phase 2 seeder needs one consistent file.
#
#   --sync-images s3://BUCKET/PREFIX
#       Sync content/images straight from the instance to S3 at their FINAL
#       live location (no staging copy). Requires the instance role to hold
#       s3:PutObject/s3:ListBucket on that prefix. Resumable and idempotent.
#
# Usage: scripts/ssm-backup-instance.sh [--vacuum-db] [--sync-images S3_URI]
# Output: .instance-backups/<timestamp>.tgz (gitignored)
#         .instance-backups/<timestamp>.db   (with --vacuum-db)

set -euo pipefail

VACUUM_DB=false
SYNC_IMAGES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vacuum-db)
      VACUUM_DB=true
      shift
      ;;
    --sync-images)
      SYNC_IMAGES="${2:-}"
      if [[ -z "$SYNC_IMAGES" ]]; then
        echo "--sync-images needs an s3:// URI" >&2
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: $0 [--vacuum-db] [--sync-images s3://BUCKET/PREFIX]" >&2
      exit 1
      ;;
  esac
done
```

Leave everything from `REPO_ROOT=` onward as it is.

- [ ] **Step 2: Add the `VACUUM INTO` snapshot**

Append after the existing `tar tzf "$LOCAL_TGZ"` line at the end of the file:

```bash
if [[ "$VACUUM_DB" == true ]]; then
  REMOTE_DB="/tmp/ghost-snapshot-${TS}.db"
  LOCAL_DB="$OUT_DIR/${TS}.db"

  echo "Taking a clean database snapshot with VACUUM INTO..."
  # VACUUM INTO reads the live database and writes a new, fully-checkpointed
  # single file; it never modifies the source. A plain `cp` of a running
  # Ghost's ghost.db is torn and leaves the WAL behind in a separate file.
  run_command "sudo rm -f $REMOTE_DB; \
    sudo sqlite3 /var/www/ghost/content/data/ghost.db \"VACUUM INTO '$REMOTE_DB'\"; \
    sudo chmod 644 $REMOTE_DB; \
    sudo sqlite3 $REMOTE_DB 'PRAGMA integrity_check;'" >/dev/null

  echo "Fetching database snapshot..."
  ssm_pull "$REMOTE_DB" "$LOCAL_DB"
  run_command "rm -f $REMOTE_DB" >/dev/null

  echo "Database snapshot saved: $LOCAL_DB"
fi
```

- [ ] **Step 3: Add the image sync**

Append:

```bash
if [[ -n "$SYNC_IMAGES" ]]; then
  echo "Syncing images to $SYNC_IMAGES ..."
  # Runs on the instance under the instance role's own credentials, so the
  # ~15MB of images never travel through the SSM base64 channel (which caps
  # out in the low single-digit MB). `s3 sync` is resumable and idempotent.
  run_command "sudo aws s3 sync /var/www/ghost/content/images '$SYNC_IMAGES' --only-show-errors && echo sync-ok"

  echo "Image sync complete."
fi
```

- [ ] **Step 4: Shellcheck**

Run: `shellcheck scripts/ssm-backup-instance.sh`
Expected: no output (clean).

- [ ] **Step 5: Verify unknown arguments fail loudly**

Run: `scripts/ssm-backup-instance.sh --nonsense; echo "exit=$?"`
Expected: `unknown argument: --nonsense`, the usage line, and `exit=1`.

Do **not** run the script without arguments here — it is a live-instance operation and belongs to the operator.

- [ ] **Step 6: Commit**

```bash
git add scripts/ssm-backup-instance.sh
git commit -m "backup: add --vacuum-db snapshot and --sync-images for the phase2 cutover"
```

---

### Task 5: Seed the S3-backed store from a plain SQLite file

The store's on-disk format is a base segment holding the raw whole-database file bytes, zero or more page-image WAL segments, and a `root.json` manifest naming them plus the page size (see `phase2/packages/sqlite-s3/src/merge.js:16-18`, which does `Buffer.from(base.bytes)` on the base segment). Seeding is therefore: read the `.db`, read its page size out of the SQLite header, store the file as a base segment, and write the initial manifest with an empty WAL list.

The manifest write uses `expectedEtag: null`, which the manifest store turns into `If-None-Match: *`. Seeding a bucket that already holds a store fails outright rather than overwriting it. There is deliberately no `--force`: clearing a store is a separate, explicit act.

**Files:**
- Create: `phase2/packages/sqlite-s3/src/seed.js`
- Create: `phase2/packages/sqlite-s3/bin/seed-from-sqlite.mjs`
- Modify: `phase2/packages/sqlite-s3/src/index.js`
- Test: `phase2/packages/sqlite-s3/test/seed.test.js`

**Interfaces:**
- Consumes: `createManifestStore(store)` from `src/manifest.js` (its `write(manifest, { expectedEtag })` and `read()`); `createSegmentStore(store)` from `src/segments.js` (`putSegment(bytes, meta) -> id`, `getSegment(id) -> { meta, bytes }`); `createInMemoryObjectStore()` / `createS3ObjectStore({ bucket, client })` from `src/object-store.js`. The manifest shape written by `src/commit.js:28-32` is `{ baseSegmentId, walSegmentIds, pageSize }`.
- Produces: `readPageSize(fileBytes) -> number` and `seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore }) -> { baseSegmentId, pageSize, etag, bytes }`. Task 6's round-trip test consumes both.

- [ ] **Step 1: Write the failing tests**

Create `phase2/packages/sqlite-s3/test/seed.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createManifestStore } from '../src/manifest.js';
import { createSegmentStore } from '../src/segments.js';
import { seedStoreFromSqliteFile, readPageSize } from '../src/seed.js';

async function makeDb(pageSize = 4096) {
  const dir = await mkdtemp(path.join(tmpdir(), 'seed-test-'));
  const dbPath = path.join(dir, 'source.db');
  const db = new Database(dbPath);
  db.pragma(`page_size = ${pageSize}`);
  db.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO posts (title) VALUES (?)').run('hello');
  db.close();
  return dbPath;
}

test('readPageSize reads the page size out of the SQLite header', async () => {
  const dbPath = await makeDb(8192);
  assert.equal(readPageSize(await readFile(dbPath)), 8192);
});

test('readPageSize decodes the 65536 special case', () => {
  const header = Buffer.alloc(100);
  header.write('SQLite format 3 ', 0, 'latin1');
  header.writeUInt16BE(1, 16);
  assert.equal(readPageSize(header), 65536);
});

test('readPageSize rejects a file too short to hold a header', () => {
  assert.throws(() => readPageSize(Buffer.alloc(4)), /not a SQLite database/);
});

test('seedStoreFromSqliteFile writes a base segment and an initial manifest', async () => {
  const dbPath = await makeDb();
  const store = createInMemoryObjectStore();
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);

  const result = await seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore });

  assert.equal(result.pageSize, 4096);
  assert.ok(result.baseSegmentId);
  assert.ok(result.bytes > 0);

  const { manifest } = await manifestStore.read();
  assert.deepEqual(manifest, {
    baseSegmentId: result.baseSegmentId,
    walSegmentIds: [],
    pageSize: 4096,
  });

  const segment = await segmentStore.getSegment(result.baseSegmentId);
  assert.deepEqual(Buffer.from(segment.bytes), await readFile(dbPath));
});

test('seedStoreFromSqliteFile refuses to overwrite an existing store', async () => {
  const dbPath = await makeDb();
  const store = createInMemoryObjectStore();
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);

  await seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore });

  await assert.rejects(
    () => seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore }),
    /already seeded/
  );
});

test('seedStoreFromSqliteFile rejects a file that is not a SQLite database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seed-test-'));
  const dbPath = path.join(dir, 'garbage.db');
  await writeFile(dbPath, Buffer.alloc(200, 0x41));

  const store = createInMemoryObjectStore();
  await assert.rejects(
    () =>
      seedStoreFromSqliteFile({
        dbPath,
        manifestStore: createManifestStore(store),
        segmentStore: createSegmentStore(store),
      }),
    /not a SQLite database/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd phase2/packages/sqlite-s3 && node --test test/seed.test.js`
Expected: FAIL — `Cannot find module '../src/seed.js'`.

- [ ] **Step 3: Write `src/seed.js`**

```javascript
import { readFile } from 'node:fs/promises';

const SQLITE_MAGIC = 'SQLite format 3 ';

/**
 * The page size lives at byte offset 16 of the SQLite header as a big-endian
 * 16-bit value. A stored value of 1 means 65536, which does not fit in 16
 * bits — SQLite's own encoding trick, and the same one src/merge.js decodes.
 */
export function readPageSize(fileBytes) {
  if (fileBytes.length < 100 || fileBytes.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
    throw new Error('not a SQLite database: header magic missing or file truncated');
  }
  const raw = fileBytes.readUInt16BE(16);
  return raw === 1 ? 65536 : raw;
}

/**
 * Turn a plain, single-file SQLite database into the initial state of an
 * S3-backed store: the whole file becomes the base segment, and the manifest
 * points at it with an empty WAL list — the same shape src/merge.js expects.
 *
 * The manifest is written with expectedEtag: null, which becomes an
 * If-None-Match: * conditional put. Seeding a store that already exists
 * therefore fails instead of destroying it. There is deliberately no force
 * option: emptying a store is a separate, explicit act.
 */
export async function seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore }) {
  const fileBytes = await readFile(dbPath);
  const pageSize = readPageSize(fileBytes);

  const { manifest: existing } = await manifestStore.read();
  if (existing) {
    throw new Error(
      'refusing to seed: this store is already seeded (root.json exists). ' +
        'Empty the bucket deliberately if you really mean to start over.'
    );
  }

  const baseSegmentId = await segmentStore.putSegment(fileBytes, { kind: 'base' });
  const { etag } = await manifestStore.write(
    { baseSegmentId, walSegmentIds: [], pageSize },
    { expectedEtag: null }
  );

  return { baseSegmentId, pageSize, etag, bytes: fileBytes.length };
}
```

The pre-read of the manifest is a friendly error, not the safety mechanism — the `expectedEtag: null` conditional write is, and it still fires if another writer seeds between that read and this write (surfacing as `ManifestConflictError`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/seed.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the CLI**

Create `phase2/packages/sqlite-s3/bin/seed-from-sqlite.mjs`:

```javascript
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
```

- [ ] **Step 6: Export from the package index**

Add to `phase2/packages/sqlite-s3/src/index.js`:

```javascript
export { seedStoreFromSqliteFile, readPageSize } from './seed.js';
```

- [ ] **Step 7: Run the package's full suite**

Run: `cd phase2/packages/sqlite-s3 && node --test`
Expected: PASS, no failures.

- [ ] **Step 8: Commit**

```bash
git add phase2/packages/sqlite-s3/src/seed.js \
        phase2/packages/sqlite-s3/src/index.js \
        phase2/packages/sqlite-s3/bin/seed-from-sqlite.mjs \
        phase2/packages/sqlite-s3/test/seed.test.js
git commit -m "sqlite-s3: seed a store from a plain SQLite file"
```

---

### Task 6: Dump a store back to a plain SQLite file

The inverse of Task 5. Validation needs it (Task 8's CLI compares the post-boot database against the source), and it doubles as the store's disaster-recovery tool: without it there is no way to get a readable database back out of the bucket.

**Files:**
- Create: `phase2/packages/sqlite-s3/src/dump.js`
- Create: `phase2/packages/sqlite-s3/bin/dump-to-sqlite.mjs`
- Modify: `phase2/packages/sqlite-s3/src/index.js`
- Test: `phase2/packages/sqlite-s3/test/dump.test.js`

**Interfaces:**
- Consumes: `restoreLocalDb({ manifest, segmentStore, dbPath })` from `src/restore.js`; `seedStoreFromSqliteFile({ dbPath, manifestStore, segmentStore })` from Task 5 (round-trip test only).
- Produces: `dumpStoreToSqliteFile({ manifestStore, segmentStore, dbPath }) -> { bytes }`, used by Task 9's runbook.

- [ ] **Step 1: Write the failing tests**

Create `phase2/packages/sqlite-s3/test/dump.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createInMemoryObjectStore } from '../src/object-store.js';
import { createManifestStore } from '../src/manifest.js';
import { createSegmentStore } from '../src/segments.js';
import { seedStoreFromSqliteFile } from '../src/seed.js';
import { dumpStoreToSqliteFile } from '../src/dump.js';

async function tmpFile(name) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dump-test-'));
  return path.join(dir, name);
}

async function makeDb() {
  const dbPath = await tmpFile('source.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
  const insert = db.prepare('INSERT INTO posts (title) VALUES (?)');
  for (let i = 0; i < 50; i += 1) insert.run(`post ${i}`);
  db.close();
  return dbPath;
}

test('seed then dump round-trips the database byte for byte', async () => {
  const sourcePath = await makeDb();
  const store = createInMemoryObjectStore();
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);

  await seedStoreFromSqliteFile({ dbPath: sourcePath, manifestStore, segmentStore });

  const outPath = await tmpFile('dumped.db');
  const result = await dumpStoreToSqliteFile({ manifestStore, segmentStore, dbPath: outPath });

  const source = await readFile(sourcePath);
  const dumped = await readFile(outPath);
  assert.deepEqual(dumped, source);
  assert.equal(result.bytes, source.length);
});

test('the dumped file is a queryable database with the same rows', async () => {
  const sourcePath = await makeDb();
  const store = createInMemoryObjectStore();
  const manifestStore = createManifestStore(store);
  const segmentStore = createSegmentStore(store);
  await seedStoreFromSqliteFile({ dbPath: sourcePath, manifestStore, segmentStore });

  const outPath = await tmpFile('dumped.db');
  await dumpStoreToSqliteFile({ manifestStore, segmentStore, dbPath: outPath });

  const db = new Database(outPath, { readonly: true });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM posts').get();
  db.close();
  assert.equal(n, 50);
});

test('dumping an empty store fails rather than writing a zero-byte file', async () => {
  const store = createInMemoryObjectStore();
  const outPath = await tmpFile('dumped.db');

  await assert.rejects(
    () =>
      dumpStoreToSqliteFile({
        manifestStore: createManifestStore(store),
        segmentStore: createSegmentStore(store),
        dbPath: outPath,
      }),
    /store is empty/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd phase2/packages/sqlite-s3 && node --test test/dump.test.js`
Expected: FAIL — `Cannot find module '../src/dump.js'`.

- [ ] **Step 3: Write `src/dump.js`**

```javascript
import { stat } from 'node:fs/promises';
import { restoreLocalDb } from './restore.js';

/**
 * Materialise the store's current state as a plain, single-file SQLite
 * database. This is the inverse of seedStoreFromSqliteFile and the store's
 * disaster-recovery path: without it there is no way to read the bucket's
 * contents outside a running Ghost.
 *
 * restoreLocalDb returns silently for an empty store (see restore.js:10-12,
 * where "no manifest and no segments" legitimately means "a fresh database").
 * That is right for a booting Ghost and wrong here — a dump that produces
 * nothing is a failure the caller must see.
 */
export async function dumpStoreToSqliteFile({ manifestStore, segmentStore, dbPath }) {
  const { manifest } = await manifestStore.read();
  const hasWalSegments = manifest?.walSegmentIds?.length > 0;
  if (!manifest || (!manifest.baseSegmentId && !hasWalSegments)) {
    throw new Error('refusing to dump: the store is empty (no manifest, or no segments)');
  }

  await restoreLocalDb({ manifest, segmentStore, dbPath });
  const { size } = await stat(dbPath);
  return { bytes: size };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd phase2/packages/sqlite-s3 && node --test test/dump.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the CLI**

Create `phase2/packages/sqlite-s3/bin/dump-to-sqlite.mjs`:

```javascript
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
    dbPath,
  });

  console.log(JSON.stringify({ ok: true, bucket, path: dbPath, bytes: result.bytes }));
}

main().catch((err) => {
  console.error(`dump failed: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 6: Export from the package index**

Add to `phase2/packages/sqlite-s3/src/index.js`:

```javascript
export { dumpStoreToSqliteFile } from './dump.js';
```

- [ ] **Step 7: Run the package's full suite**

Run: `cd phase2/packages/sqlite-s3 && node --test`
Expected: PASS, no failures.

- [ ] **Step 8: Commit**

```bash
git add phase2/packages/sqlite-s3/src/dump.js \
        phase2/packages/sqlite-s3/src/index.js \
        phase2/packages/sqlite-s3/bin/dump-to-sqlite.mjs \
        phase2/packages/sqlite-s3/test/dump.test.js
git commit -m "sqlite-s3: dump a store back to a plain SQLite file"
```

---

### Task 7: Database comparison with an explicit boot-mutation allowlist

The gate that answers "did the migrated database actually come across". It is not byte-wise: Ghost mutates state on boot even when it runs no schema migrations. The design point is an **explicit allowlist of what is permitted to differ** — a difference anywhere else fails the check, which makes "what legitimately changes on boot" a reviewable statement rather than a judgement call made under pressure.

Both sides run the same Ghost version by construction (the EC2 instance is upgraded to the target version before its database is taken), so the schema is identical and any structural difference is a real fault.

**Files:**
- Create: `phase2/packages/deploy-verify/src/db-compare.mjs`
- Modify: `phase2/packages/deploy-verify/package.json` (add `better-sqlite3`)
- Test: `phase2/packages/deploy-verify/test/db-compare.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks. Takes already-open `better-sqlite3` `Database` handles so tests never touch S3.
- Produces:
  - `BOOT_MUTATION_ALLOWLIST -> { tables: string[], settingsKeys: string[] }`
  - `CONTENT_TABLES -> string[]`
  - `tableRowCounts(db) -> Record<string, number>`
  - `contentChecksum(db, table) -> string`
  - `settingsMap(db) -> Record<string, string>`
  - `compareDatabases({ source, target, allowlist = BOOT_MUTATION_ALLOWLIST }) -> { ok: boolean, differences: Array<{ kind: string, name: string, detail: string }> }`

  Task 8's `bin/validate-migration.mjs` calls `compareDatabases` and prints `differences`.

- [ ] **Step 1: Add the `better-sqlite3` dependency**

In `phase2/packages/deploy-verify/package.json`, make `dependencies` read (matching the version `sqlite-s3` already pins):

```json
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "better-sqlite3": "^11.7.0"
  }
```

Run: `cd phase2/packages/deploy-verify && npm install`

- [ ] **Step 2: Write the failing tests**

Create `phase2/packages/deploy-verify/test/db-compare.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  compareDatabases,
  tableRowCounts,
  contentChecksum,
  settingsMap,
  BOOT_MUTATION_ALLOWLIST,
} from '../src/db-compare.mjs';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, status TEXT, published_at TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    CREATE TABLE settings (id TEXT PRIMARY KEY, key TEXT, value TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT);
  `);
  db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p1', 'Hello', 'published', '2026-01-01');
  db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p2', 'World', 'draft', null);
  db.prepare('INSERT INTO users VALUES (?, ?, ?)').run('u1', 'Owner', 'owner@example.com');
  db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('s1', 'title', 'My Blog');
  db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('s2', 'db_hash', 'aaa');
  return db;
}

test('tableRowCounts counts every user table and skips sqlite internals', () => {
  const counts = tableRowCounts(makeDb());
  assert.equal(counts.posts, 2);
  assert.equal(counts.users, 1);
  assert.equal(counts.sessions, 0);
  assert.equal(counts.sqlite_sequence, undefined);
});

test('contentChecksum is stable across two identical databases', () => {
  assert.equal(contentChecksum(makeDb(), 'posts'), contentChecksum(makeDb(), 'posts'));
});

test('contentChecksum changes when a row changes', () => {
  const a = makeDb();
  const b = makeDb();
  b.prepare('UPDATE posts SET title = ? WHERE id = ?').run('Changed', 'p1');
  assert.notEqual(contentChecksum(a, 'posts'), contentChecksum(b, 'posts'));
});

test('contentChecksum ignores row order', () => {
  const a = makeDb();
  const b = new Database(':memory:');
  b.exec('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, status TEXT, published_at TEXT)');
  b.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p2', 'World', 'draft', null);
  b.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p1', 'Hello', 'published', '2026-01-01');
  assert.equal(contentChecksum(a, 'posts'), contentChecksum(b, 'posts'));
});

test('settingsMap reads key/value pairs', () => {
  assert.deepEqual(settingsMap(makeDb()), { title: 'My Blog', db_hash: 'aaa' });
});

test('compareDatabases passes for two identical databases', () => {
  const result = compareDatabases({ source: makeDb(), target: makeDb() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.differences, []);
});

test('compareDatabases fails on a row-count difference in a non-allowlisted table', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('DELETE FROM posts WHERE id = ?').run('p2');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'row-count' && d.name === 'posts'));
});

test('compareDatabases allows row-count differences in allowlisted tables', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('INSERT INTO sessions VALUES (?, ?)').run('sess1', 'u1');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, true, JSON.stringify(result.differences));
});

test('compareDatabases fails on a content checksum difference', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('UPDATE posts SET title = ? WHERE id = ?').run('Tampered', 'p1');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'checksum' && d.name === 'posts'));
});

test('compareDatabases allows settings keys named in the allowlist', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('UPDATE settings SET value = ? WHERE key = ?').run('bbb', 'db_hash');

  const allowlist = { ...BOOT_MUTATION_ALLOWLIST, settingsKeys: ['db_hash'] };
  const result = compareDatabases({ source, target, allowlist });
  assert.equal(result.ok, true, JSON.stringify(result.differences));
});

test('compareDatabases fails on a settings key not named in the allowlist', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('UPDATE settings SET value = ? WHERE key = ?').run('Hijacked', 'title');

  const allowlist = { ...BOOT_MUTATION_ALLOWLIST, settingsKeys: ['db_hash'] };
  const result = compareDatabases({ source, target, allowlist });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'setting' && d.name === 'title'));
});

test('compareDatabases fails when a table exists on only one side', () => {
  const source = makeDb();
  const target = makeDb();
  target.exec('CREATE TABLE surprise (id TEXT PRIMARY KEY)');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'table-set' && d.name === 'surprise'));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd phase2/packages/deploy-verify && node --test test/db-compare.test.mjs`
Expected: FAIL — `Cannot find module '../src/db-compare.mjs'`.

- [ ] **Step 4: Write `src/db-compare.mjs`**

```javascript
import { createHash } from 'node:crypto';

/**
 * What Ghost is permitted to change between the source snapshot and the
 * post-boot database. Anything outside this list failing the comparison is
 * the entire point: it turns "what legitimately changes on boot" into a
 * reviewable statement rather than a judgement call made under pressure.
 *
 * Both sides run the same Ghost version by construction (the EC2 instance is
 * upgraded to the target version before its database is taken), so no schema
 * migration runs on first boot and any structural difference is a real fault.
 *
 * `settingsKeys` starts empty ON PURPOSE. Populate it from an OBSERVED boot,
 * never by guessing: run the comparison once, read the reported `setting`
 * differences, satisfy yourself each one is Ghost rewriting its own
 * bookkeeping, and only then add its key here with a note saying why.
 */
export const BOOT_MUTATION_ALLOWLIST = {
  tables: [
    'sessions', // login sessions; the deploy-verify integration creates one
    'jobs', // scheduled-job bookkeeping, rewritten on boot
    'actions', // the audit log, which records the boot itself
    'brute', // rate-limiter counters
    'integrations', // the deploy-verify integration is deliberately added
    'api_keys', // ...and its key
  ],
  settingsKeys: [],
};

/**
 * The tables whose contents are compared, not merely counted: the ones a
 * reader of the blog would notice being wrong. `settings` is deliberately not
 * here — it is compared key-by-key against allowlist.settingsKeys below,
 * which is finer-grained than a whole-table checksum.
 */
export const CONTENT_TABLES = [
  'posts',
  'posts_meta',
  'users',
  'roles',
  'tags',
  'posts_tags',
  'members',
  'newsletters',
];

function userTables(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => row.name);
}

export function tableRowCounts(db) {
  const counts = {};
  for (const table of userTables(db)) {
    // The table name comes from sqlite_master, never from user input. SQLite
    // does not allow a bound identifier, so interpolation is the only option
    // here; quoting it keeps unusual-but-legal table names working.
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  }
  return counts;
}

/**
 * An order-independent digest of a whole table: each row is serialised with
 * its column names, the rows are sorted, then hashed. Physical row order is a
 * detail a base-segment round-trip has no obligation to preserve, so an
 * ordering difference must not read as a content difference.
 */
export function contentChecksum(db, table) {
  const rows = db.prepare(`SELECT * FROM "${table}"`).all();
  const serialised = rows
    .map((row) =>
      Object.keys(row)
        .sort()
        .map((key) => `${key}=${row[key] === null ? '<null>' : String(row[key])}`)
        .join('|')
    )
    .sort();

  const hash = createHash('sha256');
  for (const line of serialised) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function settingsMap(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function compareDatabases({ source, target, allowlist = BOOT_MUTATION_ALLOWLIST }) {
  const differences = [];
  const allowedTables = new Set(allowlist.tables);
  const allowedSettings = new Set(allowlist.settingsKeys);

  const sourceTables = new Set(userTables(source));
  const targetTables = new Set(userTables(target));

  for (const name of sourceTables) {
    if (!targetTables.has(name)) {
      differences.push({ kind: 'table-set', name, detail: 'present in source, missing in target' });
    }
  }
  for (const name of targetTables) {
    if (!sourceTables.has(name)) {
      differences.push({ kind: 'table-set', name, detail: 'present in target, missing in source' });
    }
  }

  const sourceCounts = tableRowCounts(source);
  const targetCounts = tableRowCounts(target);
  for (const name of sourceTables) {
    if (!targetTables.has(name) || allowedTables.has(name)) continue;
    if (sourceCounts[name] !== targetCounts[name]) {
      differences.push({
        kind: 'row-count',
        name,
        detail: `source ${sourceCounts[name]}, target ${targetCounts[name]}`,
      });
    }
  }

  for (const name of CONTENT_TABLES) {
    if (!sourceTables.has(name) || !targetTables.has(name) || allowedTables.has(name)) continue;
    const a = contentChecksum(source, name);
    const b = contentChecksum(target, name);
    if (a !== b) {
      differences.push({
        kind: 'checksum',
        name,
        detail: `source ${a.slice(0, 12)}, target ${b.slice(0, 12)}`,
      });
    }
  }

  if (sourceTables.has('settings') && targetTables.has('settings')) {
    const a = settingsMap(source);
    const b = settingsMap(target);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (allowedSettings.has(key)) continue;
      if (a[key] !== b[key]) {
        differences.push({ kind: 'setting', name: key, detail: `source ${a[key]}, target ${b[key]}` });
      }
    }
  }

  return { ok: differences.length === 0, differences };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd phase2/packages/deploy-verify && node --test test/db-compare.test.mjs`
Expected: PASS (12 tests).

- [ ] **Step 6: Run the package's full suite**

Run: `cd phase2/packages/deploy-verify && node --test`
Expected: PASS, no failures.

- [ ] **Step 7: Commit**

```bash
git add phase2/packages/deploy-verify/src/db-compare.mjs \
        phase2/packages/deploy-verify/test/db-compare.test.mjs \
        phase2/packages/deploy-verify/package.json \
        phase2/packages/deploy-verify/package-lock.json
git commit -m "deploy-verify: compare a migrated database against its source"
```

---

### Task 8: Content check and the `validate-migration` CLI

The database comparison proves the bytes arrived. The content check proves Ghost is actually *serving* them: user and tag counts read back through the Admin API, and every image referenced by the most recent posts confirmed to exist.

Images need two checkers, because the same URL means different things at different points in the runbook. Before the cutover the rendered URL (`https://<site>/blog/content/images/…`) still resolves against the *Phase 1* origin, where those images exist on disk — an HTTP check there would pass even if the S3 sync had failed completely. So pre-cutover the check maps the URL path to an S3 key and does a `HeadObject` against the data bucket. After the cutover the HTTP check is the meaningful one, since it exercises the real CloudFront behaviour and the OAC.

**Files:**
- Create: `phase2/packages/deploy-verify/src/content-check.mjs`
- Modify: `phase2/packages/deploy-verify/src/admin-api-client.mjs`
- Create: `phase2/packages/deploy-verify/bin/validate-migration.mjs`
- Test: `phase2/packages/deploy-verify/test/content-check.test.mjs` (create), `phase2/packages/deploy-verify/test/admin-api-client.test.mjs` (extend)

**Interfaces:**
- Consumes: `generateAdminToken({ keyId, secretHex }, nowMs?) -> string` from `src/admin-token.mjs`; `compareDatabases({ source, target, allowlist })` and `BOOT_MUTATION_ALLOWLIST` from Task 7; `dumpStoreToSqliteFile` from Task 6 (invoked as the `sqlite-s3` CLI in the runbook, never imported across packages).
- Produces:
  - in `src/admin-api-client.mjs`: `getResourceTotal(baseUrl, token, resource, fetchImpl = fetch) -> number`, `listRecentPosts(baseUrl, token, limit, fetchImpl = fetch) -> Array<{ id, title, feature_image, html }>`
  - in `src/content-check.mjs`: `extractImageUrls(post) -> string[]`, `imageUrlToKey(url) -> string`, `makeS3ImageChecker({ bucket, s3Client }) -> (url) => Promise<boolean>`, `makeHttpImageChecker(fetchImpl = fetch) -> (url) => Promise<boolean>`, `checkContent({ adminBase, token, expected, imageChecker, postLimit = 25, fetchImpl = fetch }) -> { ok, differences, missingImages }`

- [ ] **Step 1: Write the failing tests for the two new Admin API calls**

Append to `phase2/packages/deploy-verify/test/admin-api-client.test.mjs` (the file already imports `test` and `assert`; extend its existing import of `../src/admin-api-client.mjs` to include the two new names rather than adding a second import statement):

```javascript
test('getResourceTotal reads the pagination total for a resource', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ posts: [], meta: { pagination: { total: 42 } } }),
    };
  };

  const total = await getResourceTotal('https://x/api/admin', 'tok', 'posts', fetchImpl);

  assert.equal(total, 42);
  assert.equal(calls[0].url, 'https://x/api/admin/posts/?limit=1');
  assert.equal(calls[0].options.headers.Authorization, 'Ghost tok');
});

test('getResourceTotal throws when the response has no pagination total', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ posts: [] }) });

  await assert.rejects(
    () => getResourceTotal('https://x/api/admin', 'tok', 'posts', fetchImpl),
    /no pagination total/
  );
});

test('listRecentPosts requests rendered html and returns the posts', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ posts: [{ id: 'p1', title: 'T', feature_image: null, html: '<p>x</p>' }] }),
    };
  };

  const posts = await listRecentPosts('https://x/api/admin', 'tok', 5, fetchImpl);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].html, '<p>x</p>');
  assert.equal(calls[0], 'https://x/api/admin/posts/?limit=5&formats=html&order=updated_at%20desc');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd phase2/packages/deploy-verify && node --test test/admin-api-client.test.mjs`
Expected: FAIL — `getResourceTotal` is not exported.

- [ ] **Step 3: Add the two functions to `src/admin-api-client.mjs`**

Append (they reuse the file's existing `assertOk` and `authHeaders` helpers):

```javascript
export async function getResourceTotal(baseUrl, token, resource, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/${resource}/?limit=1`, {
    headers: authHeaders(token),
  });
  await assertOk(response);
  const body = await response.json();
  const total = body?.meta?.pagination?.total;
  if (typeof total !== 'number') {
    throw new Error(`Ghost Admin API returned no pagination total for ${resource}`);
  }
  return total;
}

export async function listRecentPosts(baseUrl, token, limit, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${baseUrl}/posts/?limit=${limit}&formats=html&order=updated_at%20desc`,
    { headers: authHeaders(token) }
  );
  await assertOk(response);
  const { posts } = await response.json();
  return posts;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd phase2/packages/deploy-verify && node --test test/admin-api-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing content-check tests**

Create `phase2/packages/deploy-verify/test/content-check.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractImageUrls,
  imageUrlToKey,
  makeS3ImageChecker,
  makeHttpImageChecker,
  checkContent,
} from '../src/content-check.mjs';

test('extractImageUrls collects the feature image and every img src', () => {
  const post = {
    feature_image: 'https://site/blog/content/images/2026/01/hero.png',
    html: '<p>hi</p><img src="https://site/blog/content/images/2026/01/a.png"><img src=\'https://site/blog/content/images/b.png\' alt="x">',
  };

  assert.deepEqual(extractImageUrls(post), [
    'https://site/blog/content/images/2026/01/hero.png',
    'https://site/blog/content/images/2026/01/a.png',
    'https://site/blog/content/images/b.png',
  ]);
});

test('extractImageUrls tolerates a post with no images', () => {
  assert.deepEqual(extractImageUrls({ feature_image: null, html: '<p>text</p>' }), []);
});

test('extractImageUrls tolerates a post with no html', () => {
  assert.deepEqual(extractImageUrls({ feature_image: null, html: null }), []);
});

test('extractImageUrls de-duplicates repeats', () => {
  const post = {
    feature_image: 'https://site/blog/content/images/a.png',
    html: '<img src="https://site/blog/content/images/a.png">',
  };
  assert.deepEqual(extractImageUrls(post), ['https://site/blog/content/images/a.png']);
});

test('imageUrlToKey drops the origin and the leading slash', () => {
  assert.equal(
    imageUrlToKey('https://site/blog/content/images/2026/01/hero.png'),
    'blog/content/images/2026/01/hero.png'
  );
});

test('imageUrlToKey decodes percent-escapes so the key matches the stored object', () => {
  assert.equal(
    imageUrlToKey('https://site/blog/content/images/my%20photo.png'),
    'blog/content/images/my photo.png'
  );
});

test('makeS3ImageChecker heads the mapped key in the data bucket', async () => {
  const seen = [];
  const s3Client = {
    async send(command) {
      seen.push(command.input);
      return {};
    },
  };

  const check = makeS3ImageChecker({ bucket: 'data-bucket', s3Client });
  assert.equal(await check('https://site/blog/content/images/a.png'), true);
  assert.equal(seen[0].Bucket, 'data-bucket');
  assert.equal(seen[0].Key, 'blog/content/images/a.png');
});

test('makeS3ImageChecker reports false for a missing object', async () => {
  const s3Client = {
    async send() {
      const err = new Error('not found');
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    },
  };

  const check = makeS3ImageChecker({ bucket: 'data-bucket', s3Client });
  assert.equal(await check('https://site/blog/content/images/gone.png'), false);
});

test('makeHttpImageChecker reports true only on a 200', async () => {
  const ok = makeHttpImageChecker(async () => ({ status: 200 }));
  const missing = makeHttpImageChecker(async () => ({ status: 404 }));
  const broken = makeHttpImageChecker(async () => {
    throw new Error('ECONNREFUSED');
  });

  assert.equal(await ok('https://site/x.png'), true);
  assert.equal(await missing('https://site/x.png'), false);
  assert.equal(await broken('https://site/x.png'), false);
});

function fakeApi({ totals, posts }) {
  return async (url) => {
    if (url.includes('?limit=1')) {
      const resource = url.match(/admin\/(\w+)\//)[1];
      return {
        ok: true,
        status: 200,
        json: async () => ({ meta: { pagination: { total: totals[resource] } } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ posts }) };
  };
}

test('checkContent passes when counts match and every image resolves', async () => {
  const fetchImpl = fakeApi({
    totals: { users: 1, tags: 3 },
    posts: [{ id: 'p1', feature_image: 'https://site/blog/content/images/a.png', html: '' }],
  });

  const result = await checkContent({
    adminBase: 'https://site/blog/ghost/api/admin',
    token: 'tok',
    expected: { users: 1, tags: 3 },
    imageChecker: async () => true,
    fetchImpl,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.missingImages, []);
});

test('checkContent fails on a count mismatch', async () => {
  const fetchImpl = fakeApi({ totals: { users: 1, tags: 2 }, posts: [] });

  const result = await checkContent({
    adminBase: 'https://site/blog/ghost/api/admin',
    token: 'tok',
    expected: { users: 1, tags: 3 },
    imageChecker: async () => true,
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.differences, [{ resource: 'tags', expected: 3, actual: 2 }]);
});

test('checkContent fails and names every image that does not resolve', async () => {
  const fetchImpl = fakeApi({
    totals: { users: 1, tags: 0 },
    posts: [
      {
        id: 'p1',
        feature_image: 'https://site/blog/content/images/good.png',
        html: '<img src="https://site/blog/content/images/bad.png">',
      },
    ],
  });

  const result = await checkContent({
    adminBase: 'https://site/blog/ghost/api/admin',
    token: 'tok',
    expected: { users: 1, tags: 0 },
    imageChecker: async (url) => !url.endsWith('bad.png'),
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingImages, [
    { postId: 'p1', url: 'https://site/blog/content/images/bad.png' },
  ]);
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cd phase2/packages/deploy-verify && node --test test/content-check.test.mjs`
Expected: FAIL — `Cannot find module '../src/content-check.mjs'`.

- [ ] **Step 7: Write `src/content-check.mjs`**

```javascript
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { getResourceTotal, listRecentPosts } from './admin-api-client.mjs';

const IMG_SRC = /<img[^>]+src=["']([^"']+)["']/gi;

export function extractImageUrls(post) {
  const urls = [];
  if (post.feature_image) urls.push(post.feature_image);
  for (const match of String(post.html ?? '').matchAll(IMG_SRC)) {
    urls.push(match[1]);
  }
  return [...new Set(urls)];
}

/**
 * The rendered image URL and the S3 key differ only by the leading slash —
 * that 1:1 mapping is exactly why the launcher puts `blog/` into
 * staticFileURLPrefix (see ghost-sqlite-s3-launcher/src/storage-config.mjs).
 * URL paths are percent-encoded and S3 keys are not, so decode.
 */
export function imageUrlToKey(url) {
  return decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
}

/**
 * Pre-cutover image checker. The rendered URL still resolves against the
 * PHASE 1 origin at that point, where these images exist on disk — an HTTP
 * check would pass even if the S3 sync had failed entirely. Checking the
 * bucket directly is the only check that means anything before traffic moves.
 */
export function makeS3ImageChecker({ bucket, s3Client }) {
  return async (url) => {
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: imageUrlToKey(url) }));
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Post-cutover image checker: exercises the real CloudFront behaviour and the
 * OAC bucket policy, which the S3 checker cannot.
 */
export function makeHttpImageChecker(fetchImpl = fetch) {
  return async (url) => {
    try {
      const response = await fetchImpl(url, { method: 'GET' });
      return response.status === 200;
    } catch {
      return false;
    }
  };
}

export async function checkContent({
  adminBase,
  token,
  expected,
  imageChecker,
  postLimit = 25,
  fetchImpl = fetch,
}) {
  const differences = [];
  for (const resource of ['posts', 'users', 'tags']) {
    if (expected[resource] === undefined) continue;
    const actual = await getResourceTotal(adminBase, token, resource, fetchImpl);
    if (actual !== expected[resource]) {
      differences.push({ resource, expected: expected[resource], actual });
    }
  }

  const posts = await listRecentPosts(adminBase, token, postLimit, fetchImpl);
  const missingImages = [];
  for (const post of posts) {
    for (const url of extractImageUrls(post)) {
      if (!(await imageChecker(url))) {
        missingImages.push({ postId: post.id, url });
      }
    }
  }

  return { ok: differences.length === 0 && missingImages.length === 0, differences, missingImages };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd phase2/packages/deploy-verify && node --test test/content-check.test.mjs`
Expected: PASS (12 tests).

- [ ] **Step 9: Write the operator CLI**

Create `phase2/packages/deploy-verify/bin/validate-migration.mjs`:

```javascript
#!/usr/bin/env node
// The migration gate. Runs before any traffic moves, and again after.
//
//   GHOST_ADMIN_API_KEY=<id:secret> node bin/validate-migration.mjs \
//     --source-db ./.instance-backups/<ts>.db \
//     --target-db ./.instance-backups/<ts>-post-boot.db \
//     --public-url https://<lightsail service url> \
//     --bucket <data bucket> \
//     [--image-check s3|http]
//
// --image-check s3 (the default) heads the data bucket directly: before the
// cutover the rendered image URL still resolves against the PHASE 1 origin,
// so an HTTP check would pass even with a completely failed image sync. Use
// --image-check http for the post-cutover re-validation on the real domain.
//
// Exits non-zero on any difference. The visual checks are printed for a human
// at the end; they are not automated.
import Database from 'better-sqlite3';
import { S3Client } from '@aws-sdk/client-s3';
import { compareDatabases, BOOT_MUTATION_ALLOWLIST } from '../src/db-compare.mjs';
import { generateAdminToken } from '../src/admin-token.mjs';
import { makeS3ImageChecker, makeHttpImageChecker, checkContent } from '../src/content-check.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

async function main() {
  const {
    'source-db': sourceDbPath,
    'target-db': targetDbPath,
    'public-url': publicUrl,
    bucket,
    'image-check': imageCheck = 's3',
    region = 'us-east-1',
  } = parseArgs(process.argv.slice(2));

  if (!sourceDbPath || !targetDbPath || !publicUrl || !bucket) {
    console.error(
      'usage: validate-migration.mjs --source-db <file> --target-db <file> --public-url <url> --bucket <bucket> [--image-check s3|http]'
    );
    process.exit(1);
  }
  const adminApiKey = process.env.GHOST_ADMIN_API_KEY;
  if (!adminApiKey) {
    console.error('GHOST_ADMIN_API_KEY env var is required');
    process.exit(1);
  }

  const source = new Database(sourceDbPath, { readonly: true });
  const target = new Database(targetDbPath, { readonly: true });

  console.log('== database comparison ==');
  const dbResult = compareDatabases({ source, target, allowlist: BOOT_MUTATION_ALLOWLIST });
  if (dbResult.ok) {
    console.log('ok: no differences outside the boot-mutation allowlist');
  } else {
    for (const d of dbResult.differences) {
      console.log(`DIFF ${d.kind} ${d.name}: ${d.detail}`);
    }
  }

  // Post counts are covered by the database comparison above: the Admin API's
  // post total includes drafts, and matching it from SQL would mean
  // replicating Ghost's exact filter. Users and tags have no such ambiguity.
  const expected = {
    users: source.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    tags: source.prepare('SELECT COUNT(*) AS n FROM tags').get().n,
  };
  source.close();
  target.close();

  const base = publicUrl.replace(/\/$/, '');
  const [keyId, secretHex] = adminApiKey.split(':');
  const token = generateAdminToken({ keyId, secretHex });

  const imageChecker =
    imageCheck === 'http'
      ? makeHttpImageChecker()
      : makeS3ImageChecker({ bucket, s3Client: new S3Client({ region }) });

  console.log(`== content check (images via ${imageCheck}) ==`);
  const contentResult = await checkContent({
    adminBase: `${base}/blog/ghost/api/admin`,
    token,
    expected,
    imageChecker,
  });
  if (contentResult.ok) {
    console.log('ok: user/tag counts match, every image on the recent posts resolves');
  } else {
    for (const d of contentResult.differences) {
      console.log(`DIFF count ${d.resource}: expected ${d.expected}, got ${d.actual}`);
    }
    for (const m of contentResult.missingImages) {
      console.log(`MISSING image on post ${m.postId}: ${m.url}`);
    }
  }

  console.log('== visual check (human) ==');
  console.log(`  home:  ${base}/blog/`);
  console.log(`  admin: ${base}/blog/ghost/`);
  console.log('  open a recent post with images and confirm they render');

  if (!dbResult.ok || !contentResult.ok) {
    console.error('VALIDATION FAILED — do not move traffic');
    process.exit(1);
  }
  console.log('VALIDATION PASSED');
}

main().catch((err) => {
  console.error(`validation failed to run: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 10: Run the package's full suite**

Run: `cd phase2/packages/deploy-verify && node --test`
Expected: PASS, no failures.

- [ ] **Step 11: Commit**

```bash
git add phase2/packages/deploy-verify/src/content-check.mjs \
        phase2/packages/deploy-verify/src/admin-api-client.mjs \
        phase2/packages/deploy-verify/bin/validate-migration.mjs \
        phase2/packages/deploy-verify/test/content-check.test.mjs \
        phase2/packages/deploy-verify/test/admin-api-client.test.mjs
git commit -m "deploy-verify: content check and the migration validation gate"
```

---

### Task 9: The cutover runbook

Everything above is inert until an operator runs it in order. This task writes that order down, with its gates and its way back, so the cutover is executed from a document rather than from memory.

**Files:**
- Modify: `phase2/readme.md`
- Test: none (documentation); verify every command it names exists, and that no identifiers leaked

**Interfaces:**
- Consumes: every deliverable of Tasks 1-8.
- Produces: nothing consumed by code.

- [ ] **Step 1: Append the runbook section to `phase2/readme.md`**

Add, after the existing "Deploying" section:

````markdown
## Migrating from Phase 1 (the cutover)

Design: `docs/superpowers/specs/2026-09-09-phase2-migration-cutover-design.md`.
Exact resource identifiers (distribution ID, bucket names, instance and role
names) live in `.local-secrets.md`, never here.

Every step before step 7 is inert: no traffic has moved and Phase 1 is serving
its own untouched database throughout. **The accepted downtime window starts
at step 3** — anything written to Phase 1 after the final backup is lost.

### 0. One-time prerequisites

The image sync in step 3 runs on the instance under the instance role, so that
role needs `s3:PutObject` and `s3:ListBucket` on the data bucket's image
prefix. Attach it once (role and bucket names from `.local-secrets.md`):

```bash
aws iam put-role-policy \
  --role-name <the appserver instance's role> \
  --policy-name ghost-phase2-image-sync \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {"Effect": "Allow", "Action": ["s3:PutObject"],
       "Resource": "arn:aws:s3:::<data bucket>/blog/content/images/*"},
      {"Effect": "Allow", "Action": ["s3:ListBucket"],
       "Resource": "arn:aws:s3:::<data bucket>",
       "Condition": {"StringLike": {"s3:prefix": "blog/content/images/*"}}}
    ]
  }'
```

Then import the CloudFront distribution into Phase 2 state, once. The HCL in
`phase2/iac/cloudfront.tf` was written to match the live configuration exactly;
the empty plan is the gate:

```bash
cd phase2/iac
nix-shell -p opentofu --run 'tofu init -backend-config=backend.hcl'
# with an import block temporarily restored, pointing at the distribution ID
nix-shell -p opentofu --run 'tofu plan -var deploy_lightsail=true -var image_tag=deadbeef'
```

Proceed only when the distribution shows **no changes**. It carries
`prevent_destroy`, so `tofu destroy` on this directory will refuse while it is
in state — remove it deliberately if you ever really mean to.

### 1. Upgrade Phase 1 to the target version

The migrated database must land on a Ghost that runs **no schema migrations on
first boot**, so that any difference between source and result is a real fault
rather than an expected upgrade artifact. Upgrade Phase 1 first, on its own
infrastructure, where the upgrade is rehearsed and `scripts/ssm-rollback-ghost.sh`
exists.

```bash
scripts/ssm-backup-instance.sh
scripts/ssm-deploy-ghost-update.sh   # builds from stock upstream main
```

Pin the exact commit you built and use it for the Phase 2 image too. Verify the
upgraded Phase 1 site is healthy before continuing.

### 2. Apply the prereqs

```bash
cd phase2/iac
nix-shell -p opentofu --run 'tofu apply'
```

With no flags this brings up only the S3 data bucket and the ECR repository.

### 3. Final backup — the downtime window starts here

```bash
scripts/ssm-backup-instance.sh --vacuum-db --sync-images s3://<data bucket>/blog/content/images
```

Note the timestamp it prints: `.instance-backups/<ts>.db` is the source of
truth for everything below.

### 4. Seed the store

```bash
cd phase2/packages/sqlite-s3
node bin/seed-from-sqlite.mjs --db ../../../.instance-backups/<ts>.db --bucket <data bucket>
```

This fails if the store already holds data; it will never overwrite one.

### 5. Deploy Lightsail

```bash
git checkout <the pinned commit>
phase2/scripts/deploy.sh
```

`deploy.sh` passes `deploy_lightsail=true` and never touches
`deploy_cloudfront`: a routine deploy must not move traffic.

### 6. Validate — the hard gate

Dump what Ghost actually booted, then compare:

```bash
cd phase2/packages/sqlite-s3
node bin/dump-to-sqlite.mjs --bucket <data bucket> --out ../../../.instance-backups/<ts>-post-boot.db

cd ../deploy-verify
export GHOST_ADMIN_API_KEY="$(aws ssm get-parameter --name ghost_phase2_admin_api_key --with-decryption --region us-east-1 --query Parameter.Value --output text)"
node bin/validate-migration.mjs \
  --source-db ../../../.instance-backups/<ts>.db \
  --target-db ../../../.instance-backups/<ts>-post-boot.db \
  --public-url "$(cd ../../iac && nix-shell -p opentofu --run 'tofu output -raw public_url')" \
  --bucket <data bucket>
```

A red check stops the cutover. The first run will typically report `setting`
differences — Ghost rewriting its own bookkeeping on boot. Read each one,
satisfy yourself it is benign, then add its key to `settingsKeys` in
`phase2/packages/deploy-verify/src/db-compare.mjs` with a note saying why.
Never add a key you have not read.

### 7. Cut over

```bash
cd phase2/iac
nix-shell -p opentofu --run 'tofu apply -var deploy_lightsail=true -var deploy_cloudfront=true -var image_tag=<the deployed tag>'
```

The `/blog*` behaviours switch to the Lightsail origin and the image behaviour
is added. The distribution and DNS keep their identity throughout, so this
takes effect in minutes with no propagation wait.

### 8. Re-validate on the real domain

The same command as step 6, with `--image-check http` and the real site URL as
`--public-url`, so the check exercises CloudFront and the OAC rather than the
bucket directly.

### Rolling back

Before step 7 there is nothing to roll back: no traffic moved, Phase 1 is
untouched, fix and retry from the failed step.

After step 7:

```bash
cd phase2/iac
nix-shell -p opentofu --run 'tofu apply -var deploy_lightsail=true -var deploy_cloudfront=false -var image_tag=<tag>'
```

Behaviours return to the EC2 origin within minutes. The instance stays running
as the rollback target. **Anything written on Phase 2 after the cutover does
not exist on Phase 1**, so rolling back trades that content away — an accepted,
stated cost.
````

- [ ] **Step 2: Verify every command the runbook names actually exists**

```bash
ls scripts/ssm-backup-instance.sh scripts/ssm-deploy-ghost-update.sh scripts/ssm-rollback-ghost.sh
ls phase2/scripts/deploy.sh
ls phase2/packages/sqlite-s3/bin/seed-from-sqlite.mjs phase2/packages/sqlite-s3/bin/dump-to-sqlite.mjs
ls phase2/packages/deploy-verify/bin/validate-migration.mjs
grep -n 'image-check' phase2/packages/deploy-verify/bin/validate-migration.mjs
grep -n 'vacuum-db\|sync-images' scripts/ssm-backup-instance.sh
```

Expected: every path listed, both greps hit.

- [ ] **Step 3: Confirm no sensitive identifiers leaked into the runbook**

```bash
grep -nE '[0-9]{12}|E[A-Z0-9]{12,}|i-[0-9a-f]{8,}|vpc-|subnet-|sg-' phase2/readme.md
```

Expected: no output. Every identifier must be a `<placeholder>` pointing at `.local-secrets.md`.

- [ ] **Step 4: Commit**

```bash
git add phase2/readme.md
git commit -m "phase2/readme.md: document the phase 1 to phase 2 cutover runbook"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Feature flags (prereq / Lightsail / CloudFront staging, IAM under the Lightsail flag, ECR repo stays a prereq, cross-flag failure at plan time) | Task 2 |
| CloudFront ownership (import gated on an empty plan, `prevent_destroy`, behaviour flip) | Task 3 |
| Version alignment (EC2 upgraded first, stock `main`, one pinned commit for both sides) | Task 9, runbook step 1 — an operator sequence, no code deliverable |
| Backup: `VACUUM INTO`, images synced to their final location | Task 4 |
| Image key layout (`blog/content/images`, 1:1 path→key, no CloudFront Function) | Task 1 (prefix), Task 3 (behaviour), Task 4 (sync target), Task 8 (`imageUrlToKey`) |
| Seeding (`seed-from-sqlite.mjs`, `If-None-Match`, no `--force`) | Task 5 |
| `dump-to-sqlite.mjs` inverse / disaster recovery | Task 6 |
| Validation: row counts, content-table checksums, explicit allowlist | Task 7 |
| Validation: content check via the Admin API, feature images and `<img src>` | Task 8 |
| Visual check printed for a human | Task 8 (`validate-migration.mjs`) |
| Runbook, error handling, rollback | Task 9 |
| Testing: seeder round-trip | Task 6 |

**A deliberate refinement of the spec.** The spec says the content check
confirms every image "returns 200". Before the cutover that would be a false
pass — the rendered URL still resolves against the Phase 1 origin, where the
images exist on disk regardless of whether the S3 sync worked. Task 8 therefore
checks the data bucket directly (`HeadObject`) pre-cutover and keeps the HTTP
check for the post-cutover re-validation, selected with `--image-check`. Same
intent, actually load-bearing.

**Two consequences stated rather than hidden.** `settingsKeys` ships empty and
is populated from an observed boot during runbook step 6 — the spec asks for
exactly that ("enumerated from an observed boot rather than guessed"), which
means the first validation run is *expected* to report differences and the
operator's job is to read them, not to silence them. And the `posts` count is
compared through the database checksum rather than the Admin API total, because
the Admin API total includes drafts and matching it from SQL would mean
replicating Ghost's exact filter; users and tags have no such ambiguity and are
checked through the API.
