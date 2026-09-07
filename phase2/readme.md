# Phase 2: managed, containerized, stateless

Goal: convert the Phase 1 VM-based Ghost install into a managed-container
setup without increasing cost, with nodes made stateless (filesystem and DB
externalized) so the deployment can scale beyond a single node later even
though it stays single-node for now. Also introduces OpenTofu as IaC and
reorganizes phase-specific scripts/docs into per-phase directories (this
directory; Phase 1's equivalent is `phase1/`).

## Cost comparison

Compute + storage + DB only — CloudFront, Route53, and mail are unchanged
by this phase and are excluded. Content+DB size assumed ~2GB (personal
blog, low image volume).

Baseline (Phase 1, current): t3.micro on-demand ~$7.60/mo + 8GB gp3 EBS
~$0.64/mo ≈ **$8.24/mo**.

Live investigation (SSM into the running instance, 2026-09-07) found Ghost
itself uses ~230MB resident (peak 318MB, plus it actively swaps — 603MB of
the 1GB swap file in use at check time). The RAM pressure driving the need
for a 1GB swap file is mostly *not* Ghost — it's Ubuntu server's baseline
daemon set stacked alongside it (`systemd-journald` 111MB, `fwupd` 31MB,
`snapd` 23MB, SSM agent workers ~35MB, plus ModemManager/multipathd/
udisksd/chronyd/rsyslogd/polkitd). None of that exists inside a container,
so a containerized Ghost's real requirement is closer to 0.5GB than 1GB.

| Option | Compute | Storage | DB | Total/mo | Fit |
|---|---|---|---|---|---|
| **ECS on EC2** | t3.micro $7.60 (same box, repurposed as ECS container instance) | EBS $0.64 + EFS (2GB, One Zone) $0.32 | $0 — SQLite file lives on EFS, single writer (one Ghost task) | **~$8.56** | Cheapest option, no LB needed, no forced DB service — because the instance keeps a stable private IP CloudFront's VPC origin can target directly |
| **Fargate** | 0.25 vCPU / 0.5GB (revised down once the RAM investigation showed Ghost fits under 512MB without the VM's OS-daemon overhead): $8.99, **plus an NLB, ~$16.50/mo** — required because a Fargate task has no fixed IP, and CloudFront's VPC origin needs one (an ALB/NLB, specifically); see Networking and the CloudFront-connectivity question below | EFS (2GB) $0.32 | $0 — SQLite-on-EFS, same as ECS-on-EC2 | **~$25.81** | The NLB erases essentially all of Fargate's cost advantage — no longer close to ECS-on-EC2 |
| **Lightsail Containers** | Micro $10/mo — **bundled load balancing + HTTPS included**, no separate LB charge (that $18/mo add-on is only for standalone Lightsail instances, not container services) | none — Lightsail containers categorically cannot attach a disk or EFS (confirmed platform limit, not tier-dependent); ephemeral 20GiB/node only | See below — S3-backed SQLite (reimplemented), not a managed DB service | **~$11-12/mo** if the S3-backed-SQLite approach works out (compute $10 + ~$1-2 S3 for DB+images); **~$26/mo** if it doesn't and a real managed DB (Lightsail DB or RDS) is needed instead | No VPC-private origin (public HTTPS endpoint) — a real security-posture difference from Phase 1's "no public inbound except via CloudFront" principle, but judged acceptable: that principle exists to reduce a long-lived EC2 instance's attack surface, which doesn't apply the same way to a managed container platform with no OS to patch |

Compute: **Lightsail Containers**, pursued despite the non-VPC-private
posture (see Decisions below) — Fargate's apparent cost parity with
ECS-on-EC2 didn't hold up once the load-balancer requirement was
accounted for, and Lightsail's bundled LB/HTTPS avoids that cost
entirely. Its own forced-managed-DB cost is what the S3-backed SQLite
work below is trying to avoid.

Note for the record: ECS-on-EC2 (and, more starkly, plain `docker run` +
systemd on the same EC2 instance) would also hit the ~$8.24-8.56/mo floor
with no LB and no forced DB, by virtue of keeping a stable private IP
CloudFront's VPC origin can target directly. Not chosen — Lightsail was.

### Custom S3-backed SQLite (reimplementation, not adopting a third party)

[chrisk60331/distributed-sqllite](https://github.com/chrisk60331/distributed-sqllite)
demonstrates the approach that would remove Lightsail's forced-managed-DB
cost (and could drop the EFS line from Fargate too): SQLite backed by S3
via append-only segments + versioned manifests, snapshot isolation with
CAS-based optimistic concurrency (not WAL-shipping like Litestream, not
Raft consensus like rqlite/dqlite) — genuinely multi-writer-capable, and
S3 is its only AWS dependency.

Decision: **don't adopt that repo directly — reimplement the same idea in
Node.js**, shipped with or as part of the Ghost setup, so it integrates
with Ghost's actual data layer (Knex → `sqlite3`/`better-sqlite3`) instead
of depending on an external, unverified, small third-party project.
Exact integration shape (custom SQLite VFS vs. a Knex-layer shim vs.
something else) not yet decided — "we'll see."

**Open feasibility question, unresolved**: whether this can present as a
normal SQLite file/connection to Ghost's existing data layer with no
Ghost-side code changes, or whether it requires forking/patching Ghost's
DB client. This is now the load-bearing question for whether Lightsail's
~$11-12/mo figure is real or whether it falls back to ~$26/mo.

### Cheapest viable RDS configuration

The `~$23.29/mo` row above is already the floor for a real single-AZ RDS
instance — `db.t4g.micro` (Graviton) is the cheapest current-generation
class, cheaper than `db.t3.micro`; 20GB is RDS's minimum allocated storage
for MySQL (can't go lower); single-AZ/no read replica/no enhanced
monitoring/no Performance Insights all already assumed. Two levers left,
neither free:

- **RDS Free Tier**: 750 hrs/mo of `db.t4g.micro` + 20GB storage free for
  12 months on an eligible account — would drop this to ~$0/mo for that
  window, but only applies if this AWS account hasn't already used its
  RDS free tier (unverified here).
- **1-year no-upfront Reserved Instance**: cuts compute ~28% to $8.47/mo,
  total **~$20.08/mo** — cheapest non-free-tier option, at the cost of a
  1-year commitment (works against Fargate's whole pitch of no standing
  commitment).

Everything else that's "cheaper than RDS" stops being RDS: Aurora
Serverless v2's minimum (0.5 ACU, ~$43.80/mo) is *more* expensive than a
provisioned `db.t4g.micro`, not less, so it isn't a path to a lower floor.

Sources: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing),
[AWS EFS pricing](https://aws.amazon.com/efs/pricing/),
[AWS RDS for MySQL pricing](https://aws.amazon.com/rds/mysql/pricing/).

## Networking: IPv6 for AWS traffic, IPv4 only for Proton

**Superseded by the Lightsail decision above** — this investigation
assumed a VPC-based compute option (ECS-on-EC2 or Fargate). Lightsail
Containers don't use ECR pulls or EFS mounts the way this section
describes, and Lightsail's own networking/IPv6 story hasn't been
investigated yet — how the container reaches Proton over IPv4 for SMTP is
an open question, not the "reuse the existing Elastic IP" answer below.
Kept for the record since it may become relevant again if Lightsail's
S3-backed-SQLite approach doesn't pan out and the fallback reopens
ECS-on-EC2/Fargate.

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
  Phase 1's Elastic IP today, so this isn't a new cost line vs baseline —
  it carries forward, already reflected in the comparison above.

## Ghost's own Docker packaging (reference, not adopted as-is)

`docs.ghost.org/install/docker` and `github.com/TryGhost/ghost-docker` both
target **docker-compose**, not ECS/Fargate/Lightsail directly, and assume
**MySQL** (no SQLite in that packaging) plus Caddy for TLS termination and
optional Tinybird for analytics. Translating to any of the 3 options above
means: compose env vars → task-definition/container env vars, the
bind-mounted content volume → an EFS mount, and dropping Caddy entirely
(CloudFront already terminates TLS at the edge). Whether to also adopt
MySQL (via RDS) instead of keeping SQLite-on-EFS is a separate decision —
not yet made; SQLite-on-EFS is assumed above as the lower-cost default.

## Decisions made

- **Compute: Lightsail Containers** (Micro tier). Rejected Fargate — its
  cost parity with ECS-on-EC2 depended on skipping the load-balancer
  requirement, which doesn't hold up (a Fargate task has no fixed IP,
  and CloudFront's VPC origin needs one — see Networking below — so an
  NLB, ~$16.50/mo, is required and erases the advantage). Rejected
  ECS-on-EC2/plain-Docker despite their lower cost floor, in favor of
  Lightsail's bundled load-balancing/HTTPS and managed platform.
- **Lightsail's public-endpoint (non-VPC-private) posture: accepted.**
  The private-VPC requirement's purpose was reducing a long-lived EC2
  instance's attack surface; that doesn't apply the same way to a
  managed container platform with no OS to patch.
- **DB direction: S3-backed SQLite, reimplemented in Node.js** (not
  adopting the third-party `chrisk60331/distributed-sqllite` repo
  directly), shipped with or as part of the Ghost setup — see below.
  Chosen over a managed DB service (RDS/Lightsail DB) because Lightsail
  has no persistent-volume option at all, and "minimum that works" was
  preferred over paying for a full managed DB.

## Open questions / not yet decided

- **S3-backed SQLite feasibility** — does Ghost's Knex/sqlite3 data layer
  work against a Node.js reimplementation of the S3-backed approach
  without Ghost-side code changes, or does it need forking/patching
  Ghost's DB client? Exact integration shape (custom SQLite VFS vs. a
  Knex-layer shim vs. something else) also not yet decided. This is the
  load-bearing question for the whole DB approach — if it doesn't pan
  out, the fallback is a managed DB service, which raises the total from
  ~$11-12/mo to ~$26/mo.
- Docker image: official Ghost docker packaging assumes MySQL — does it
  support SQLite via config/env vars at all, or does this need a custom
  Dockerfile/entrypoint (reusing `qadpt`'s existing build pipeline)?
- Lightsail's own networking/IPv4 story for reaching Proton SMTP —
  unlike the ECS-on-EC2/Fargate answer above (reuse the existing Elastic
  IP), Lightsail containers don't sit in the same VPC by default, so
  this needs its own investigation, not a carried-forward answer.
- Secrets handling: SSM Parameter Store injection currently happens via a
  shell script on the VM; confirm Lightsail's equivalent (env vars from
  SSM Parameter Store are supported in container service deployments)
  covers the same SMTP-credential handling with no new secret-handling
  gap.
- Image storage: Ghost's S3-compatible storage adapter for uploads, and
  whether it shares the same bucket as the S3-backed SQLite data or uses
  a separate one.
- How the existing VM's `/var/www/ghost/content` (images, SQLite db file)
  gets migrated into the new setup — one-time cutover step.
- OpenTofu module layout and what state backend to use (note: OpenTofu's
  Lightsail provider support is thinner than its ECS/EC2 support —
  worth confirming coverage for container service + bucket resources
  before committing further).
- Exact migration path/cutover plan from the Phase 1 VM to Lightsail.
