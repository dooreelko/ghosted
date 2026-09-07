the point of the second phase is to convert the current vm-based setup into a managed-containerised one without increasing costs
since it's a scaling configuration even if with a single node, we'll need to externalize file system and the db, the nodes must become stateless

we'll be also introducing iac (opentofu) for the deployment, so a cleanup is due. each phase, scripts and docs  should be in a dedicated directory

## Decisions (2026-09-07)

Folder reorg done: Phase 1 files moved to `phase1/` (`readme.md`, drawio,
png). Phase 2 design doc at `phase2/readme.md` — decision record here,
full cost comparison/networking/DB detail there.

Live RAM investigation (SSM into the running instance) found Ghost itself
uses ~230-320MB resident, not 1GB — the 1GB swap requirement on the VM is
mostly Ubuntu server's baseline daemon overhead (journald, snapd, fwupd,
ModemManager, etc.), which doesn't exist in a container.

Compute: **Lightsail Containers** (Micro tier), not ECS-on-EC2 or Fargate.
Fargate was ruled out — needs an NLB (~$16.50/mo) for CloudFront to reach
a Fargate task's non-fixed IP, which erases its cost advantage. Lightsail
bundles load balancing + HTTPS into its flat price, avoiding that cost.
Accepted tradeoff: Lightsail has no VPC-private origin (public HTTPS
endpoint), unlike Phase 1's "no public inbound except via CloudFront"
principle — judged acceptable since that principle exists to reduce a
long-lived EC2 instance's attack surface, which doesn't apply to a
managed container platform with no OS to patch.

DB: Lightsail Containers cannot attach any persistent volume (confirmed
platform limit, not tier-dependent) — SQLite-on-EFS (the ECS/Fargate
answer) isn't available here. Direction chosen: reimplement an S3-backed
SQLite approach in Node.js (inspired by, not adopting,
github.com/chrisk60331/distributed-sqllite — append-only segments +
versioned manifests on S3, CAS-based optimistic concurrency), shipped
with or as part of the Ghost setup. A managed DB service (RDS/Lightsail
DB, ~$14-15/mo floor) is the fallback if this doesn't pan out.

Full cost comparison, RDS floor analysis, IPv6/networking investigation
(mostly superseded by the Lightsail choice), and open questions (S3-backed
SQLite feasibility being the load-bearing one) are in `phase2/readme.md`.
