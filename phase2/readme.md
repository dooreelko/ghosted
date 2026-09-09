# Phase 2: managed, containerized, stateless

Goal: convert the Phase 1 VM-based Ghost install into a managed-container
setup without increasing cost, with nodes made stateless (filesystem and DB
externalized) so the deployment can scale beyond a single node later even
though it stays single-node for now. Also introduces OpenTofu as IaC and
reorganizes phase-specific scripts/docs into per-phase directories (this
directory; Phase 1's equivalent is `phase1/`).

## Design

- **Compute: Lightsail Containers** (Micro tier). Bundled load balancing +
  HTTPS, fully managed platform, no OS to patch.
- **DB: SQLite, backed by S3** via a Node.js reimplementation of an
  append-only-segments-plus-versioned-manifest design, shipped with or as
  part of the Ghost setup — not a managed DB service.
- **Docker image**: fork `Ghost/` (already a submodule, reused from
  `qadpt`'s build pipeline), build a custom SQLite-capable image.
- **Image storage**: same S3 bucket as the S3-backed SQLite data.
- **Credential path** from the container into our AWS account:
  cross-account `AssumeRole`, no `ExternalId`. An IAM role in our account
  trusts the Lightsail container service's own `principalArn` (one per
  service, shared by every container/replica in it) as Principal — a live
  OpenTofu resource reference, never a hardcoded account ID or secret.
  Covers both the SMTP-credential read (SSM) and S3-backed-SQLite access
  (S3) via one `AssumeRole` call at container startup. No static
  credential of any kind is baked into the image or deployment config.
- **Migration/cutover**: one-time backup-and-restore, downtime acceptable
  — no live-sync. Back up the Phase 1 VM (config, SQLite db,
  `content/images/`), restore into the new Lightsail/S3-backed setup, cut
  CloudFront over. Image transfer via **S3, not `ssm-scp.sh`'s
  chunked-base64 approach** (that approach caps out around a few MB; 15MB
  of images is a bad fit) — the instance's IAM role gets `s3:PutObject`
  on the same S3 bucket already used for S3-backed SQLite/image storage
  (one bucket, one IAM change), tars and uploads `content/images/`
  directly, pulled down locally with `aws s3 cp`. This also resolves the
  standing "S3 bucket for large instance file transfers" gap noted in
  `docs/ghost.md`. `ssm-backup-instance.sh` needs extending to capture
  `content/images/` (currently deliberately excludes it) before this is
  usable for the actual cutover.
- **IaC**: OpenTofu, flat local state (no S3/remote backend), one file
  per main component (`s3.tf`, `lightsail.tf`, `iam.tf`, etc.).

**Accepted risk, not resolved**: whether the S3-backed SQLite
reimplementation actually plugs into Ghost's Knex/sqlite3 data layer is
**not spiked separately — discovered during implementation**. If it
doesn't pan out, the fallback is a managed DB service, raising the total
from ~$11-12/mo to ~$26/mo (see Cost comparison below). Exact integration
shape (custom SQLite VFS vs. a Knex-layer shim vs. something else) will be
decided then too.

## Deploying

One command, run manually (no CI/cron trigger): `phase2/scripts/deploy.sh`,
from the repo root, with real AWS credentials for the account that owns
`phase2/iac/`'s resources. On a fresh checkout, initialize the IaC
directory first — state lives in a versioned S3 bucket, wired through a
partial backend config: `cd phase2/iac && tofu init -backend-config=backend.hcl`
(that file is gitignored because the bucket name embeds the account ID;
recreate it from `.local-secrets.md`). `phase2/iac/phase1.auto.tfvars` must
also exist — every `tofu` invocation in `phase2/iac/` (including this
script's own `tofu apply` and `build.sh`'s `tofu output`) fails outright
without it; see `.local-secrets.md` under "Phase 2 CloudFront import (moth
i8hlt)" for the values and step 0 of the cutover section below for how it's
built. It builds & pushes a new image (git short-SHA
tag), applies it via OpenTofu, then independently verifies the live
deployment (an HTTP smoke test plus a Ghost Admin API create/read/delete
roundtrip that exercises the real SQLite-over-S3 write path and the
S3-backed image-upload path) — see
`docs/superpowers/specs/2026-09-08-phase2-deploy-observability-design.md`
for why a second, independent check is needed on top of Lightsail's own
health check, and the full failure-mode/rollback design.

**Outcomes:**
- Both `tofu apply` and verification succeed: the new tag is live, script
  exits 0.
- `tofu apply` itself fails (Lightsail rejects the new version): the
  previous deployment is untouched and still serving; script reports and
  exits non-zero, no rollback needed.
- `tofu apply` succeeds but verification fails: script looks up the
  previous deployment's tag from Lightsail's own history and redeploys it,
  then exits non-zero reporting which tag ended up live.
- First-ever deploy with no previous tag to fall back to, or a rollback
  attempt that itself fails: script exits non-zero with an explicit
  message — never guesses further, never auto-retries.

**One-time setup, before the first deploy verification can pass:** a
dedicated Ghost Admin API "Custom Integration" must be created manually
through the live admin panel, and its `id:secret` stored as an SSM
SecureString named `ghost_phase2_admin_api_key` (same pattern as the
mail credential) — `deploy.sh` reads it with its own AWS identity, the
container itself never receives it. See the design doc's "Admin API key
provisioning" section for detail.

**Not automated by this script:** mail delivery is not verified per-deploy
(accepted gap, see design doc); the migration/cutover work (backup-and-
restore, CloudFront origin switch) is separate, still-open scope (moth
`i8hlt`), not part of `deploy.sh`.

## Migrating from Phase 1 (the cutover)

Design: `docs/superpowers/specs/2026-09-09-phase2-migration-cutover-design.md`.
Exact resource identifiers (distribution ID, bucket names, instance and role
names) live in `.local-secrets.md`, never here.

Every step before step 7 is inert: no traffic has moved and Phase 1 is serving
its own untouched database throughout. **The accepted downtime window starts
at step 3** — anything written to Phase 1 after the final backup is lost.

Every command block below is written to run from the repository root; where a
block changes directory, the next block that needs the root starts with an
explicit `cd` back rather than assuming it.

### 0. One-time prerequisites

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

### 1. Upgrade Phase 1 to the target version

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
scripts/ssm-backup-instance.sh
scripts/ssm-scp.sh push <local-tarball> <remote-path>
scripts/ssm-deploy-ghost-update.sh <remote-path>
scripts/ssm-copy-admin-build.sh <from-version> <to-version>
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
scripts/ssm-backup-instance.sh
scripts/ssm-switch-to-mainstream-ghost.sh
```

`ssm-switch-to-mainstream-ghost.sh` moves the instance off the retired
custom-fork build and onto stock Ghost via `ghost update --force` (npm
registry, ghost-cli's own update path, no `--zip`) — this migration's
decision that the local patch is retired and both sides run stock. It
requires the scoped sudoers rule from `scripts/ssm-install-ghost-cli-sudoers.sh`
to already be installed (`ghost update` shells out to `sudo` internally). If
it needs rolling back, ghost-cli keeps the previous version directory: use
`ghost rollback` (as `ghostadmin`) or `scripts/ssm-rollback-ghost.sh <version>`.
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

### 2. Apply the prereqs

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

### 3. Final backup — the downtime window starts here

The sync half runs on the instance under the instance role, so that role
needs `s3:PutObject` and a prefix-scoped `s3:ListBucket` on the bucket step 2
just created. Attach it once — the role name is in `.local-secrets.md` under
the Phase 1 heading, as "IAM instance role":

```bash
cd "$(git rev-parse --show-toplevel)"
scripts/attach-image-sync-policy.sh <the appserver instance's role>
```

The grant is deliberately narrow: the same bucket holds the SQLite store's
segments and manifest, and the instance is the source of a one-way migration,
not a participant in the store. Re-running it is safe, and is how you would
narrow the policy later.

Then take the backup itself:

```bash
scripts/ssm-backup-instance.sh --vacuum-db --sync-images s3://<data bucket>/blog/content/images
```

The database half needs no `sqlite3` on the instance — it runs `VACUUM INTO`
through Ghost's own vendored `better-sqlite3` (`scripts/remote-vacuum.js`),
asserts `integrity_check` is `ok`, and pulls the snapshot gzipped, since
every byte of that transfer costs an SSM round trip.

Note the timestamp it prints: `.instance-backups/<ts>.db` is the source of
truth for everything below.

### 4. Seed the store

```bash
cd phase2/packages/sqlite-s3
node bin/seed-from-sqlite.mjs --db ../../../.instance-backups/<ts>.db --bucket <data bucket>
```

This fails if the store already holds data; it will never overwrite one.

### 5. Deploy Lightsail

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

Read the printed counts, not just the pass/fail line — the content check
reports how many posts and images it actually checked, plus a list of any
images it skipped as not-ours (externally hosted). "Checked 0 images" is the
shape of a gate that passed without verifying anything; this failure mode was
found and fixed twice while building this tooling, so treat a suspiciously
low count as a failure even when the script says PASSED.

### 7. Cut over

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
OAC, that most often needs a second look.

### 8. Invalidate `/blog*` and wait for it to complete

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

### 9. Re-validate on the real domain

The same command as step 6, with `--image-check http` and the real site URL as
`--public-url`, so the check exercises CloudFront and the OAC rather than the
bucket directly. Re-running the database comparison here repeats a result you
already have from step 6 (nothing about the CloudFront cutover changes what
Ghost booted from the store) — this step's actual value is the HTTP image
check and the visual check, now that both are finally exercising the real
CloudFront path instead of the bucket or the Lightsail service URL directly.

### Rolling back

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

### Tearing down `phase2/iac/` afterward

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

## Cost (this design)

**~$11-12/mo** — Lightsail Micro compute $10 (bundled load balancing +
HTTPS) + ~$1-2 S3 for the SQLite data and images, if the S3-backed-SQLite
approach works out. **~$26/mo** if it doesn't and a managed DB (RDS or
Lightsail DB) is needed instead — see the accepted risk above. Phase 1
baseline for comparison: ~$8.24/mo. Full option-by-option comparison
(Fargate, ECS-on-EC2, RDS floor) is in Cost comparison below.

## Decisions and rejected alternatives

- **Compute: Lightsail Containers**, not Fargate or ECS-on-EC2/plain
  Docker. Fargate's apparent cost parity with ECS-on-EC2 depended on
  skipping the load-balancer requirement (a Fargate task has no fixed IP,
  and CloudFront's VPC origin needs one) — accounting for the ~$16.50/mo
  NLB that requires erases the advantage. ECS-on-EC2/plain-Docker would
  have been cheaper (no LB or managed-DB cost forced, since a stable EC2
  private IP is something CloudFront's VPC origin can target directly),
  but Lightsail's bundled load-balancing/HTTPS and fully managed platform
  were preferred anyway.
- **Lightsail's public-endpoint (non-VPC-private) posture: accepted.**
  Phase 1's "no public inbound except via CloudFront" principle exists to
  reduce a long-lived EC2 instance's attack surface, which doesn't apply
  the same way to a managed container platform with no OS to patch.
- **DB: S3-backed SQLite reimplemented in Node.js**, not adopting the
  third-party [chrisk60331/distributed-sqllite](https://github.com/chrisk60331/distributed-sqllite)
  repo directly (reimplementing instead so it integrates with Ghost's
  actual data layer), and not RDS or Lightsail's managed DB (~$14-26/mo)
  — Lightsail has no persistent-volume option at all, and the minimum
  that works was preferred over paying for a full managed DB.
- **Credential path: cross-account `AssumeRole`, no `ExternalId`.**
  Rejected baking a static IAM access key into the image/deployment env
  (real secrets-hygiene risk — visible in deployment history). Rejected
  granting the container's ambient default identity direct resource
  access (a Lightsail bucket grant, or a plain S3 bucket policy) instead
  of an `AssumeRole` hop — both denied by AWS; that shared execution role
  is scoped to essentially just `sts:AssumeRole`, confirming the role hop
  is the sanctioned path, not a workaround. Rejected an `sts:ExternalId`
  condition on the trust policy — only earns its keep when trusting a
  whole account root; the per-service `principalArn` is already unique
  and is the access boundary by itself.
- **Docker image: fork, not upstream's compose packaging.** Moot to debate
  whether upstream nominally supports SQLite via config, since it's a
  custom fork build either way.
- **Migration: one-time backup-and-restore, not live-sync.** Not needed
  for a personal blog at this scale.

## Cost comparison

Compute + storage + DB only — CloudFront, Route53, and mail are unchanged
by this phase and are excluded. Content+DB size assumed ~2GB (personal
blog, low image volume; confirmed live content is 15MB/76 files, well
under this).

Baseline (Phase 1, current): t3.micro on-demand ~$7.60/mo + 8GB gp3 EBS
~$0.64/mo ≈ **$8.24/mo**.

| Option | Compute | Storage | DB | Total/mo | Fit |
|---|---|---|---|---|---|
| **ECS on EC2** (not chosen) | t3.micro $7.60 (same box, repurposed as ECS container instance) | EBS $0.64 + EFS (2GB, One Zone) $0.32 | $0 — SQLite file lives on EFS, single writer (one Ghost task) | **~$8.56** | Cheapest option, no LB needed, no forced DB service — because the instance keeps a stable private IP CloudFront's VPC origin can target directly |
| **Fargate** (rejected) | 0.25 vCPU / 0.5GB: $8.99, **plus an NLB, ~$16.50/mo** — required because a Fargate task has no fixed IP, and CloudFront's VPC origin needs one | EFS (2GB) $0.32 | $0 — SQLite-on-EFS | **~$25.81** | The NLB erases essentially all of Fargate's cost advantage |
| **Lightsail Containers** (chosen) | Micro $10/mo — bundled load balancing + HTTPS included, no separate LB charge | none — Lightsail containers categorically cannot attach a disk or EFS (confirmed platform limit); ephemeral 20GiB/node only | S3-backed SQLite (reimplemented), not a managed DB service | **~$11-12/mo** if S3-backed-SQLite works out (compute $10 + ~$1-2 S3 for DB+images); **~$26/mo** if it doesn't and a managed DB is needed instead | No VPC-private origin — accepted tradeoff, see Decisions |
| **Fargate + RDS MySQL** (reference only) | ~$8.99 | EFS (2GB) $0.32 | RDS `db.t4g.micro`, single-AZ, on-demand: $11.68 compute + $2.30 storage (20GB minimum) ≈ $13.98 | **~$23.29** | Real shared, multi-writer-capable DB — not needed at single-node scale |

Cheapest viable RDS floor (for reference, not chosen): the `~$23.29/mo`
row above is already the floor for a real single-AZ RDS instance —
`db.t4g.micro` (Graviton) is the cheapest current-generation class, 20GB
is RDS's minimum allocated storage for MySQL, single-AZ/no read
replica/no enhanced monitoring already assumed. A 1-year no-upfront
Reserved Instance would cut it to ~$20.08/mo (a standing commitment);
RDS Free Tier could drop it to ~$0/mo for 12 months if unused on this
account (unverified). Aurora Serverless v2's minimum (~$43.80/mo) is
*more* expensive than provisioned `db.t4g.micro`, not a path to a lower
floor.

Sources: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing),
[AWS EFS pricing](https://aws.amazon.com/efs/pricing/),
[AWS RDS for MySQL pricing](https://aws.amazon.com/rds/mysql/pricing/).

---

## Discussion: RAM investigation

Live investigation (SSM into the running instance, 2026-09-07) found
Ghost itself uses ~230MB resident (peak 318MB, plus it actively swaps —
603MB of the 1GB swap file in use at check time). The RAM pressure
driving the need for a 1GB swap file is mostly *not* Ghost — it's Ubuntu
server's baseline daemon set stacked alongside it (`systemd-journald`
111MB, `fwupd` 31MB, `snapd` 23MB, SSM agent workers ~35MB, plus
ModemManager/multipathd/udisksd/chronyd/rsyslogd/polkitd). None of that
exists inside a container, so a containerized Ghost's real requirement is
closer to 0.5GB than 1GB — this is what let Fargate's compute estimate
come down from an initial 0.5GB/1GB guess to 0.25 vCPU/0.5GB.

## Discussion: networking (mostly superseded by the Lightsail choice)

This investigation assumed a VPC-based compute option (ECS-on-EC2 or
Fargate) and predates the Lightsail decision. Lightsail Containers don't
use ECR pulls or EFS mounts the way this section describes. Kept for the
record since it may become relevant again if Lightsail's S3-backed-SQLite
approach doesn't pan out and the fallback reopens ECS-on-EC2/Fargate.

Investigated whether ECR image pulls and EFS mounts support IPv6, since
Proton SMTP (like SES) is IPv4-only and Phase 1's Elastic IP exists solely
to serve that one dependency:

- **ECR**: dual-stack endpoints (API + Docker/OCI pull) support IPv6 at no
  extra cost; PrivateLink-over-IPv6 into a VPC was a gap until Nov 2025,
  now resolved. ([release notes](https://aws.amazon.com/about-aws/whats-new/2025/11/ecr-dual-stack-endpoints-privatelink))
- **EFS**: mount targets can be IPv4, dual-stack, or IPv6-only per subnet;
  needs `amazon-efs-utils` ≥ 2.3 on the client for IPv6 mounting.
  ([announcement](https://aws.amazon.com/about-aws/whats-new/2025/06/amazon-efs-internet-protocol-version-6))

So the likely setup, same shape for either compute option: a **dual-stack
subnet**, IPv6 for ECR pulls and EFS mounts, IPv4 kept only for the one
thing that needs it (Proton SMTP) — no NAT gateway in either case, matching
Phase 1's existing "no NAT, Elastic IP covers the one IPv4-only dependency"
pattern:

- **ECS on EC2**: no change needed — same instance, same Elastic IP + IGW
  route already serving Proton. Add IPv6 to the subnet/ENI for ECR/EFS
  traffic. Zero new cost.
- **Fargate**: task's ENI (awsvpc mode) needs a public IPv4 in a public
  subnet with an IGW route (`assignPublicIp=ENABLED`, or an EIP) for the
  Proton SMTP leg only — direct IGW egress, not NAT. ECR pulls and the EFS
  mount use IPv6 on the same dual-stack subnet. The public IPv4 hourly
  charge (~$3.60/mo since AWS's 2024 pricing change) already applies to
  Phase 1's Elastic IP today, so this isn't a new cost line vs baseline.

For Lightsail specifically: outbound IPv4 was confirmed working with zero
setup in the hands-on test below. How the container reaches Proton is
otherwise unresearched beyond that.

## Discussion: Ghost's own Docker packaging (reference, not adopted as-is)

`docs.ghost.org/install/docker` and `github.com/TryGhost/ghost-docker` both
target **docker-compose**, not ECS/Fargate/Lightsail directly, and assume
**MySQL** (no SQLite in that packaging) plus Caddy for TLS termination and
optional Tinybird for analytics. Translating to any of the compute options
above would have meant: compose env vars → task-definition/container env
vars, the bind-mounted content volume → an EFS mount, and dropping Caddy
entirely (CloudFront already terminates TLS at the edge). Moot now that
the Docker image is a custom fork build regardless.

## Discussion: hands-on Lightsail tests (2026-09-07)

Created and destroyed several real, throwaway Lightsail resources
(container services, buckets, IAM roles) to validate the design rather
than guess:

**Outbound IPv4**: confirmed working with zero setup. A test container
reached `checkip.amazonaws.com` over IPv4 and got a real public address
back — no NAT/VPC config needed.

**Credential path — three iterations**:

1. First, confirmed Lightsail containers run on Fargate under the hood
   (`AWS_EXECUTION_ENV=AWS_ECS_FARGATE`) and get auto-injected credentials
   via `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, but the assumed role
   lives in an **AWS-managed backend account** (confirmed via
   `sts get-caller-identity`: a distinct AWS-owned account, not this
   project's own account) with zero permissions to our resources by default
   (`ssm:GetParameter` → `AccessDeniedException`). The resource-access
   route was tried too — Lightsail buckets can be granted to Lightsail
   **instances**, but `set-resource-access-for-bucket` explicitly rejects
   container services. The only documented credential path for container
   services is the ECR-image-puller role, scoped to pulling private
   images only.
2. Tested the confused-deputy pattern: an IAM role in our own account,
   trust policy naming the container service's `principalArn` as
   Principal plus an `sts:ExternalId` condition, `ssm:GetParameter`
   granted, container calls `sts.assume_role(RoleArn=...,
   ExternalId=...)` using its auto-injected default credentials. **It
   worked** — real parameter value came back.
3. Tried to remove the `ExternalId` requirement by testing whether the
   ambient default identity could instead read directly from a resource
   grant (a Lightsail bucket's access grant, then a plain S3 bucket
   policy naming the `principalArn` directly, no `AssumeRole` hop at
   all) — **both denied**, the S3 bucket policy attempt with a generic
   `AccessDenied` (no policy-detail message, unlike the earlier SSM
   denial) — consistent with AWS deliberately scoping that shared
   execution role down to essentially just `sts:AssumeRole`. Also
   confirmed `principalArn` is one-per-*service* (not per-container or
   per-scaled-node — every container and every replica in one Lightsail
   container service shares the same `principalArn`), which is already
   unique enough to be the access boundary without `ExternalId`.

All test resources (container services, buckets, bucket access keys, IAM
roles, SSM parameters) were deleted after each test. One classifier
incident along the way: an early test tried baking a Lightsail bucket
access key directly into a deployment's environment variables to check
whether that could sidestep `AssumeRole` entirely — blocked by the
permission classifier (secret-in-deployment pattern), which is
functionally the same objection as the "don't bake static credentials
into the image" decision above, arrived at independently by the
classifier before the design decision was finalized.
