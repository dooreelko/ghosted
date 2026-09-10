# Migrating from Phase 1 to Phase 2 (the cutover)

This is the one-time runbook that moved the live site from Phase 1 (a VM
running Ghost natively) to Phase 2 (Lightsail Containers + S3-backed
SQLite), executed 2026-09-10. It's kept for the record and for anyone
repeating a similar migration later — it is **not** part of Phase 2's
ongoing architecture. If you were starting Phase 2 from scratch today with
no Phase 1 to migrate from, none of this applies; see
[`readme.md`](readme.md) for the architecture and design decisions that
actually matter day to day.

Design: `docs/superpowers/specs/2026-09-09-phase2-migration-cutover-design.md`.
Exact resource identifiers (distribution ID, bucket names, instance and role
names) live in `.local-secrets.md`, never here.

Every step before step 7 is inert: no traffic has moved and Phase 1 is serving
its own untouched database throughout. **The accepted downtime window starts
at step 3** — anything written to Phase 1 after the final backup is lost.

Every command block below is written to run from the repository root; where a
block changes directory, the next block that needs the root starts with an
explicit `cd` back rather than assuming it.

## 0. One-time prerequisites

**`phase2/iac/phase1.auto.tfvars` must exist first.** It's gitignored and
auto-loaded by OpenTofu, and it carries four values with no default —
without it, no `tofu plan` or `apply` in `phase2/iac/` runs at all: the
Phase 1 CloudFront VPC origin's id, the appserver's private DNS name, the
marketing-root S3 origin's OAC id, and the site's ACM certificate ARN. All
four are recorded in `.local-secrets.md` under "Phase 2 CloudFront import
(moth i8hlt)".

The instance-role grant that step 3's image sync needs is **not** here: it
reads the bucket name out of `tofu output`, so it can only run once step 2
has created the bucket. It lives in step 3, where it is used.

Then import the CloudFront distribution into Phase 2 state, once. The HCL in
`phase2/iac/cloudfront.tf` was written to match the live configuration exactly:

```bash
cd phase2/iac
nix-shell -p opentofu --run 'tofu init -backend-config=backend.hcl'
```

**Before running plan, temporarily add an `import` block to
`phase2/iac/cloudfront.tf`**, targeting `aws_cloudfront_distribution.site`
with the live distribution's ID (from `.local-secrets.md`) as its `id`.
Pasted verbatim as a shell comment it is inert — `tofu plan` would run
without it and hand back a plan with no import in it, a wrong gate that
raises no error, so it has to actually be written into the file:

```bash
nix-shell -p opentofu --run 'tofu plan -var deploy_lightsail=true -var image_tag=deadbeef'
```

The gate is the distribution showing **zero changes** — the S3 bucket and
ECR repo legitimately show as pending creates at this point, since nothing
but the distribution has been applied yet; only the distribution's own diff
needs to be empty. Once the plan confirms the import is clean, delete the
`import` block again — it's a one-time bootstrap, not something that stays
in the HCL.

## 1. Upgrade Phase 1 to the target version

The migrated database must land on a Ghost that runs **no schema migrations on
first boot**, so that any difference between source and result is a real fault
rather than an expected upgrade artifact. Upgrade Phase 1 first, on its own
infrastructure, where the upgrade is rehearsed and rollback is at hand.

**Both sides of the cutover must end up on the same Ghost version** — see step
5 for what that means concretely on the Phase 2 side. The reliable way to get
there is to pin an exact build rather than taking whatever the npm registry
currently considers stable: push a tarball and deploy it directly.

```bash
cd "$(git rev-parse --show-toplevel)"
phase1/scripts/ssm-backup-instance.sh
phase1/scripts/ssm-scp.sh push <local-tarball> <remote-path>
phase1/scripts/ssm-deploy-ghost-update.sh <remote-path>
phase1/scripts/ssm-copy-admin-build.sh <from-version> <to-version>
```

`ssm-deploy-ghost-update.sh` installs an archive already sitting on the
instance via ghost-cli's `--zip` path — it builds nothing itself, so the
tarball has to be pushed first. That push is chunked base64 with a small
per-chunk cap, so it's slow for a large tarball. `ssm-copy-admin-build.sh`
is needed afterward because the admin UI isn't part of that build.

Alternatively, to move onto stock Ghost without pinning a specific version,
use the mainstream-update route instead:

```bash
cd "$(git rev-parse --show-toplevel)"
phase1/scripts/ssm-backup-instance.sh
phase1/scripts/ssm-switch-to-mainstream-ghost.sh
```

`ssm-switch-to-mainstream-ghost.sh` moves the instance off the retired
custom-fork build and onto stock Ghost via `ghost update --force` (npm
registry, ghost-cli's own update path, no `--zip`) — this migration's
decision that the local patch is retired and both sides run stock. It
requires the scoped sudoers rule from `phase1/scripts/ssm-install-ghost-cli-sudoers.sh`
to already be installed (`ghost update` shells out to `sudo` internally). If
it needs rolling back, ghost-cli keeps the previous version directory: use
`ghost rollback` (as `ghostadmin`) or `phase1/scripts/ssm-rollback-ghost.sh <version>`.
This route takes whatever the registry currently resolves to, which is not
guaranteed to line up with any commit of the `Ghost/` submodule — the pinned
route above exists specifically so that agreement is a deliberate choice
instead of a coincidence.

Whichever route you took, read the version the instance actually landed on —
ghost-cli reports it, and the live version directory's name under
`/var/www/ghost/versions/` confirms it. There's no mechanism here that pins
this for you; it's a manual check at cutover time. The evidence it
worked is step 6's database comparison: a version skew shows up there as
schema-level table or checksum differences, not as a clean gate.

Verify the upgraded Phase 1 site is healthy before continuing.

## 2. Apply the prereqs

`deploy_lightsail` defaults to `false`. On a first run from empty state
that only means the plan is purely additive (S3 data bucket, ECR
repository) and nothing below applies. But if the container service has
already been brought up before (a prior deploy, a prior cutover rehearsal),
a bare `tofu apply` here **proposes destroying it**:
`aws_lightsail_container_service.ghost`, its deployment version,
`aws_iam_role.app_runtime`, its policy, and
`aws_ecr_repository_policy.lightsail_pull` — because none of those are
gated to stay up by anything other than the flag you didn't pass. Always
plan first and read it before applying:

```bash
cd phase2/iac
nix-shell -p opentofu --run 'tofu plan'
```

If the plan proposes destroying any of the five resources above, stop —
that is this apply about to tear down a live Lightsail service, not a
routine no-op. Re-run with `-var deploy_lightsail=true` instead, or
confirm with whoever owns the environment that the destroy is intended,
before proceeding:

```bash
nix-shell -p opentofu --run 'tofu apply'
```

With no flags (and nothing already up) this brings up only the S3 data
bucket and the ECR repository.

## 3. Final backup — the downtime window starts here

The sync half runs on the instance under the instance role, so that role
needs `s3:PutObject` and a prefix-scoped `s3:ListBucket` on the bucket step 2
just created. Attach it once — the role name is in `.local-secrets.md` under
the Phase 1 heading, as "IAM instance role":

```bash
cd "$(git rev-parse --show-toplevel)"
phase1/scripts/attach-image-sync-policy.sh <the appserver instance's role>
```

The grant is deliberately narrow: the same bucket holds the SQLite store's
segments and manifest, and the instance is the source of a one-way migration,
not a participant in the store. Re-running it is safe, and is how you would
narrow the policy later.

Then take the backup itself:

```bash
phase1/scripts/ssm-backup-instance.sh --vacuum-db --sync-images s3://<data bucket>/blog/content/images
```

The database half needs no `sqlite3` on the instance — it runs `VACUUM INTO`
through Ghost's own vendored `better-sqlite3` (`phase1/scripts/remote-vacuum.js`),
asserts `integrity_check` is `ok`, and pulls the snapshot gzipped, since
every byte of that transfer costs an SSM round trip.

Note the timestamp it prints: `.instance-backups/<ts>.db` is the source of
truth for everything below.

## 4. Seed the store

```bash
cd phase2/packages/sqlite-s3
node bin/seed-from-sqlite.mjs --db ../../../.instance-backups/<ts>.db --bucket <data bucket>
```

This fails if the store already holds data; it will never overwrite one.

## 5. Deploy Lightsail

`build.sh` builds the image from the `Ghost/` submodule at whatever commit
it is currently checked out to — **that submodule pointer, not this repo's
own commit, is what determines the Phase 2 Ghost version.** Checking out a
commit of this outer repo does not by itself move `Ghost/`; match the
version the instance landed on in step 1 by checking the submodule out at
the corresponding tag and updating it explicitly:

```bash
cd "$(git rev-parse --show-toplevel)"
cd Ghost && git checkout <tag matching the version step 1 landed on> && cd ..
git submodule update
phase2/scripts/deploy.sh
```

As in step 1, there's no mechanism here that pins this for you automatically
— it's a manual check, and step 6's database comparison is the evidence it
worked (a version skew shows up there as schema-level table or checksum
differences, not as a clean gate).

`deploy.sh` passes `deploy_lightsail=true` and `deploy_cloudfront=true`: once
the cutover below has happened, `deploy_cloudfront=true` is the live,
permanent state and every subsequent routine deploy must keep matching it
(see `readme.md`'s Design section) — but for THIS deploy, before step 7's
cutover, the CloudFront distribution hasn't been told to point at Lightsail
yet regardless of the flag, so no traffic moves until step 7 runs the
distribution/bucket-policy apply explicitly.

## 6. Validate — the hard gate

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

Read the printed counts, not just the pass/fail line — the content check
reports how many posts and images it actually checked, plus a list of any
images it skipped as not-ours (externally hosted). "Checked 0 images" is the
shape of a gate that passed without verifying anything; this failure mode was
found and fixed twice while building this tooling, so treat a suspiciously
low count as a failure even when the script says PASSED.

## 7. Cut over

```bash
cd "$(git rev-parse --show-toplevel)"
cd phase2/iac
nix-shell -p opentofu --run 'tofu apply -var deploy_lightsail=true -var deploy_cloudfront=true -var image_tag=<the deployed tag>'
```

The `/blog*` behaviours switch to the Lightsail origin and the image behaviour
is added. The distribution and DNS keep their identity throughout, so this
takes effect in minutes with no propagation wait.

If the first images you check in step 9 come back `403`, check whether the
bucket policy was actually applied before concluding the OAC is
misconfigured — the distribution update and the bucket policy are separate
API calls within the one `apply` above, and it's the bucket policy, not the
OAC, that most often needs a second look. (This is not hypothetical: a later
`tofu apply` run from a branch that had never passed `deploy_cloudfront=true`
briefly deleted this exact bucket policy in production and broke every image
on the site — see `readme.md`'s Design section and moth `i8hlt` for the
full incident. `deploy_cloudfront=true` must be passed on every apply from
this point on, not just during the cutover itself.)

## 8. Invalidate `/blog*` and wait for it to complete

The `blog/*` behaviours keep their existing cache policy across the origin
switch in step 7 — CloudFront does not invalidate cached objects just
because a behaviour's origin changed. Every `/blog/content/images/*` path
was, until step 7, being served and cached from the EC2 origin, where those
images exist on disk. Left uninvalidated, step 9's `--image-check http` run
can get `200`s straight out of Phase-1-populated cache entries while the S3
origin, the OAC, and the bucket policy are all broken underneath — and the
visual check can be looking at Phase 1's cached HTML, not anything Phase 2
actually served. This is the only gate in the whole runbook that runs after
traffic has moved, so a false pass here is a false pass with nothing left to
catch it.

```bash
cd "$(git rev-parse --show-toplevel)"
aws cloudfront create-invalidation \
  --distribution-id <distribution id, from .local-secrets.md> \
  --paths '/blog*'
```

Note the returned invalidation ID, then poll until its `Status` is
`Completed` before moving on:

```bash
aws cloudfront get-invalidation \
  --distribution-id <distribution id, from .local-secrets.md> \
  --id <invalidation id> \
  --query 'Invalidation.Status' --output text
```

**A `200` observed on any `/blog*` path before this invalidation reaches
`Completed` proves nothing** — it may simply be the old cache entry still
being served. Do not proceed to step 9 until the status polls `Completed`.

## 9. Re-validate on the real domain

The same command as step 6, with `--image-check http` and the real site URL as
`--public-url`, so the check exercises CloudFront and the OAC rather than the
bucket directly. Re-running the database comparison here repeats a result you
already have from step 6 (nothing about the CloudFront cutover changes what
Ghost booted from the store) — this step's actual value is the HTTP image
check and the visual check, now that both are finally exercising the real
CloudFront path instead of the bucket or the Lightsail service URL directly.

## Rolling back

Before step 7 there is nothing to roll back: no traffic moved, Phase 1 is
untouched, fix and retry from the failed step.

After step 7:

```bash
cd "$(git rev-parse --show-toplevel)"
cd phase2/iac
nix-shell -p opentofu --run 'tofu apply -var deploy_lightsail=true -var deploy_cloudfront=false -var image_tag=<tag>'
```

Behaviours return to the EC2 origin within minutes. The instance stays running
as the rollback target. **Anything written on Phase 2 after the cutover does
not exist on Phase 1**, so rolling back trades that content away — an accepted,
stated cost.

## Tearing down `phase2/iac/` afterward

The CloudFront distribution carries `prevent_destroy`. A plain
`tofu destroy` in `phase2/iac/` therefore fails outright on that resource —
and because the failure happens mid-plan, nothing else gets destroyed
either, not just the distribution. If you're tearing down everything else
(the pattern was routine at the end of the previous phase), remove the
distribution from state first so it's left untouched and out of Phase 2's
management, then destroy the rest:

```bash
cd "$(git rev-parse --show-toplevel)"
cd phase2/iac
nix-shell -p opentofu --run 'tofu state rm aws_cloudfront_distribution.site'
nix-shell -p opentofu --run 'tofu destroy'
```
