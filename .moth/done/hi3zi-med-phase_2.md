the point of the second phase is to convert the current vm-based setup into a managed-containerised one without increasing costs
since it's a scaling configuration even if with a single node, we'll need to externalize file system and the db, the nodes must become stateless

we'll be also introducing iac (opentofu) for the deployment, so a cleanup is due. each phase, scripts and docs  should be in a dedicated directory

## Decisions

Folder reorg: Phase 1 files live in `phase1/`, Phase 2 in `phase2/`
(`phase2/readme.md` is the fuller technical spec/cost-comparison; this
entry stays the decision record).

**Compute: Lightsail Containers (Micro tier).**
- Rejected: Fargate — needs a load balancer (CloudFront's VPC origin
  requires a fixed IP/LB target; a Fargate task has neither) at ~$16.50/mo,
  erasing its cost parity with the alternatives below.
- Rejected: ECS-on-EC2 / plain Docker+systemd on the existing EC2 instance
  — despite being cheaper (no LB or managed-DB cost forced), in favor of
  Lightsail's bundled load-balancing/HTTPS and a fully managed platform
  (no OS to patch).
- Accepted tradeoff: Lightsail container endpoints are public HTTPS, not
  VPC-private, unlike Phase 1's "no public inbound except via CloudFront"
  principle. Judged acceptable because that principle exists to reduce a
  long-lived EC2 instance's attack surface, which doesn't apply to a
  managed container platform with no OS to patch.

**DB: SQLite, backed by S3 via a Node.js reimplementation of an
append-only-segments-plus-versioned-manifest design** (shipped with or as
part of the Ghost setup), not a managed DB service.
- Rejected: adopting the third-party `chrisk60331/distributed-sqllite`
  repo directly — reimplementing in Node.js instead so it integrates with
  Ghost's actual data layer (Knex → `sqlite3`/`better-sqlite3`).
- Rejected: RDS or Lightsail's managed DB (~$14-26/mo) — Lightsail has no
  persistent-volume option at all, and the minimum that works (SQLite) was
  preferred over paying for a full managed DB.
- Exact integration shape (custom SQLite VFS vs. a Knex-layer shim vs.
  something else), and whether this actually plugs into Ghost's data
  layer at all: **not spiked separately — discovered during
  implementation.** Accepted as a risk carried into the build. If it
  doesn't pan out, falls back to a managed DB service (~$26/mo vs
  ~$11-12/mo).
- Image storage: **same S3 bucket as the SQLite data**, not separate.

**Credential path from the container into our AWS account: cross-account
`AssumeRole`, no `ExternalId`.** An IAM role in our account trusts the
Lightsail container service's own `principalArn` (one per service, shared
by every container/replica in it) as Principal — a live OpenTofu resource
reference, never a hardcoded account ID or secret. Covers both the SMTP
credential (read from SSM) and the S3-backed-SQLite data (read/write S3).
- Rejected: baking a static IAM access key into the image/deployment env
  — real secrets-hygiene risk (visible in deployment history).
  Rejected: granting the container's ambient default identity direct
  resource access (a Lightsail bucket grant, or a plain S3 bucket policy)
  instead of an `AssumeRole` hop — both denied by AWS; that shared
  execution role is scoped to essentially just `sts:AssumeRole`, so the
  role hop is the sanctioned path, not a workaround.
- Rejected: an `sts:ExternalId` condition on the trust policy — only
  earns its keep when trusting a whole account root; the per-service
  `principalArn` is already unique and is the access boundary by itself.

**Docker image: fork `Ghost/`** (already a submodule, reused from
`qadpt`'s build pipeline) and build a custom SQLite-capable image.
- Rejected: adopting upstream's MySQL-only compose packaging as-is —
  moot anyway since it's a custom fork build.

**Migration/cutover: one-time backup-and-restore, downtime acceptable.**
- Rejected: a live-sync/zero-downtime cutover — not needed for a personal
  blog at this scale.
- `ssm-backup-instance.sh` currently excludes `content/images/`
  (deliberately, per its own comment) — needs extending before it's
  usable for the actual cutover; the live instance has real content there
  (76 files, 15MB) that the current backup doesn't capture.
- Image transfer via **S3, not `ssm-scp.sh`'s chunked-base64 approach**
  (that approach caps out around a few MB) — resolves the standing
  "S3 bucket for large instance file transfers" gap by folding it into
  this phase rather than designing it standalone; reuses the same S3
  bucket already planned for S3-backed SQLite (one bucket, one IAM
  change on the instance role).

**OpenTofu: flat, local state backend; one file per main component**
(`s3.tf`, `lightsail.tf`, `iam.tf`, etc.), not one monolithic file or a
submodule per component.

Full cost comparison, all research/verification detail (including the
hands-on Lightsail tests), and sourcing are in `phase2/readme.md`.


## Subtasks

- `vt4m9` (Sqlite S3): implement SQLite-over-S3, plug into Ghost, smoke
  test locally with Docker.
- `hnj9a` (Docker Iac): adapt Docker image, IaC for Lightsail & co under
  `phase2/iac/` — including the cross-account IAM role/trust policy.
- `i8hlt` (Wrapup): migration/cutover (extend `ssm-backup-instance.sh`,
  backup-and-restore, CloudFront origin switch) and real-environment
  validation against the deployed Lightsail setup, not just the local
  smoke test — covers the credential-path wiring between `vt4m9` and
  `hnj9a` too, since it spans both (IaC creates the role, app code calls
  `AssumeRole`).


----- AI agent updates -------

## All three subtasks complete; production-serving since 2026-09-10

`vt4m9`, `hnj9a`, and `i8hlt` are all `done`. The Lightsail/S3-backed-SQLite
setup this ticket describes is live and serving real traffic at
the-well-architected-cloud.com/blog, replacing the Phase 1 VM. Full
architecture, cost, and decision record: `phase2/readme.md`. The one-time
cutover runbook that was actually executed: `phase2/migration.md`.

**The accepted risk this ticket carried** — whether the S3-backed SQLite
reimplementation actually plugs into Ghost's Knex/`sqlite3` data layer,
"not spiked separately — discovered during implementation" — resolved in
production's favor. It does plug in cleanly (a `knex.Client` subclass
intercepting commit/restore around a normal local SQLite file); the
managed-DB fallback was never needed.

**What running it in production actually surfaced, tracked as separate
tickets rather than reopening this one:**
- `zwx7x` (done): a checkpoint/compaction race in the S3-backed store that
  let segments accumulate unboundedly under continuous writes (measured:
  572MB of garbage against a 3.4MB database after 16 hours of otherwise-idle
  uptime). Fixed with a bounded-retry checkpoint, reader leases, and a
  reclamation sweep.
- `rk2qo` (done): boot-time CloudWatch metrics + alarms added as a direct
  follow-up, since Lightsail's own logs/metrics couldn't have caught
  `zwx7x`'s failure mode (a slow leak with no restart) on their own.
- **24 `techdebt`-prefixed tickets** (filed 2026-09-10, all `ready`): a
  broad post-hoc gap review of the whole phase2 setup (code, IaC, docs,
  scripts) turned up 3 `crit`, 9 `high`, and 12 `low` findings — mostly in
  `phase2/scripts/upgrade.sh`'s untested failure-recovery path (a real
  production-data-destroying script that has never been exercised against
  an actual failure), plus doc/reality drift and a few hygiene issues.
  None of these are blockers to the setup running correctly today; they're
  the debt incurred getting here.
