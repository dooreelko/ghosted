# Phase 2 Migration & Cutover — Design

> Moth ticket: `i8hlt` (Wrapup, subtask of `hi3zi`)

## Purpose

`i8hlt`'s remaining half: move the live blog off the Phase 1 EC2 instance
onto the Phase 2 Lightsail/S3 setup. That means content and images
migrated, the S3-backed SQLite store seeded from a real database, the
result validated before any traffic moves, and CloudFront repointed —
with a way back at every step.

The deploy/verify/rollback pipeline (`phase2/scripts/deploy.sh`) is
already built and is a prerequisite here, not part of this design; see
`2026-09-08-phase2-deploy-observability-design.md`.

## Architecture

Four pieces, each independently useful:

1. **Feature-flagged IaC** — `phase2/iac/` grows two booleans so the
   infrastructure can be brought up in stages instead of all at once.
2. **Backup** — an extension of the existing `ssm-backup-instance.sh`
   that captures a clean database snapshot and, for the first time,
   images.
3. **Seeding** — a tool that turns a plain SQLite file into the initial
   state of the S3-backed store, plus its inverse for reading one back
   out.
4. **Validation** — a database comparison and an API/content check that
   together answer "did the migrated site actually come up with the same
   content", run as a gate before traffic moves.

### Feature flags

Two variables in `phase2/iac/`, both defaulting `false`, gating resources
by `count`:

| State | What exists |
|---|---|
| no flags | S3 data bucket, ECR repository |
| `deploy_lightsail=true` | + app-runtime IAM role/trust/policy, ECR pull policy, container service, deployment |
| `deploy_cloudfront=true` | + blog behaviours repointed at Lightsail, image behaviour added |

**IAM belongs to the Lightsail flag, not the prereqs.** The app-runtime
role's trust policy names the container service's own `principal_arn`, and
`assume_role_policy` is a required attribute that cannot be filled in
later — the role is unexpressible without the service, and meaningless
before something can assume it. The ECR *repository* stays a prereq (the
image is pushed before Lightsail exists) while its Lightsail pull policy
moves under the flag, since it names Lightsail's puller principal.
- Rejected: IAM as a prereq (the original sketch) — would need a
  placeholder trust policy, either invalid or a security regression.

`deploy_cloudfront` without `deploy_lightsail` fails at plan time: there
would be no origin to point at.

### CloudFront ownership

The distribution is a Phase 1 resource, created by hand, and it serves the
marketing root from S3 as well as `/blog` from the EC2 VPC origin. Phase 2's
IaC does not know it exists.

**Decision: import it into Phase 2 state, gated on an empty plan.** Write
the HCL, iterate until `tofu plan` reports *no changes*, and only then wire
the flag. The empty-plan gate is the safety mechanism — it means the live
configuration is never guessed at. The resource carries `prevent_destroy`,
because `tofu destroy` on `phase2/iac/` was routine at the end of `hnj9a`
and this distribution serves the entire site.
- Rejected: leaving CloudFront out of IaC and switching via a script —
  smallest blast radius and closest to how Phase 1 is operated, but gives
  up the declarative flag and leaves the cutover state untracked.
- Rejected: a second, Phase 2-owned distribution cut over via DNS —
  cleanest end state, but the root site's origin, behaviours and
  certificate would all have to be reproduced for no current benefit, and
  DNS propagation makes rollback slower than a behaviour flip.

Because the distribution and DNS keep their identity throughout, cutover
and rollback are both a behaviour change — minutes, with no propagation
wait.

### Version alignment

The migrated database must land on a Ghost that runs **no schema
migrations on first boot**, so that any difference between source and
result is a real fault rather than an expected upgrade artifact.

**Decision: upgrade the EC2 instance first, then take its database.**
Phase 1 is upgraded to the target version on its own infrastructure —
where the upgrade is a known, rehearsed operation with an existing
rollback script — and verified healthy. Only then is its database
snapshotted and carried across. Both sides then run the same version by
construction.
- Rejected: building Phase 2 at Phase 1's current version instead
  (pinning down rather than upgrading up) — leaves the upgrade as
  unfinished business immediately after a cutover.
- Rejected: folding the upgrade into the cutover (boot the seeded
  database on a newer Ghost and let it migrate) — makes the schema
  legitimately differ, so validation can only compare at content level,
  and any fault means debugging new infrastructure and a version jump at
  once.

**Both sides build from stock upstream `main`.** The fork's `fork_main`
branch is byte-identical to upstream — all Phase 2 wiring lives in the
launcher, no Ghost source is patched. The `local-patches` branch (Phase 1's
current build: an `isSocialWebEnabled()` change) is **retired**: that patch
is not currently effective, so there is nothing to preserve. The exact
commit is pinned at cutover time and used for *both* the EC2 upgrade
artifact and the Phase 2 image.
- Consequence, accepted: `main` currently carries a prerelease version
  number. Reintroducing any Ghost source patch is `syigu`'s business, not
  this ticket's.
- Rejected: merging upstream into `local-patches` and building both sides
  from it — would preserve a patch that is not doing anything, at the cost
  of a conflict-heavy merge (upstream reformatted the codebase in the
  intervening releases) and a permanently diverged branch to maintain.

### Backup

Extends `scripts/ssm-backup-instance.sh`, split by size and by risk:

- **Database: `VACUUM INTO` on the instance, not a file copy.** Ghost is
  running; copying a live SQLite file yields a torn snapshot plus a
  separate WAL. `VACUUM INTO` is safe against a live database and produces
  a single clean file with the WAL already folded in — exactly the shape
  the seeder needs. Returned over the existing SSM pull, which is fine at
  this size.
- **Images: synced from the instance straight to the data bucket**, using
  the `s3:PutObject` grant on the instance role that `hi3zi` already
  decided on. They land at their *final live location* (under the prefix
  fixed below), so the image migration is that one sync — no staging copy,
  resumable, idempotent.
- Config and nginx keep their current SSM path.
- Rejected: the chunked-base64 transfer (`ssm-scp.sh`) for images — caps
  out around a few MB against ~15MB of content, as `hi3zi` already found.
- Rejected: tarring images and unpacking them into S3 — a staging step
  that buys nothing over a direct sync.

**Image key layout.** Ghost's `S3Storage.buildKey` joins
`staticFileURLPrefix` with the relative path, so the per-image portion of
the key mirrors Phase 1's on-disk layout and existing post HTML keeps
resolving unchanged.

The one adjustment is the prefix. Requests arrive as
`/blog/content/images/…`, and CloudFront's `OriginPath` prepends rather
than strips, so a key of `content/images/…` could not be reached without
rewriting the URI. Setting `staticFileURLPrefix` to `blog/content/images`
with `cdnUrl` at the domain root makes the path→key mapping 1:1: the
rendered URL is unchanged, and the key gains a leading `blog/`. The image
sync therefore targets that same prefix, so the migrated files sit exactly
where Ghost will later write new ones.
- Rejected: a CloudFront Function rewriting the URI — an extra moving part
  and an extra failure mode to serve the same mapping.

### Seeding

`bin/seed-from-sqlite.mjs`, in the `sqlite-s3` package (it writes that
package's own on-disk format): read the `.db`, take the page size from the
SQLite header, store the file as a base segment, and write the initial
manifest pointing at it with an empty WAL list.

**The manifest write is conditional on the manifest not existing.** The
store's own conditional-write support (`expectedEtag: null` →
`If-None-Match`) means seeding a bucket that already holds data fails
outright rather than overwriting it. There is deliberately no `--force`:
clearing a store should be a separate, explicit act.

**`bin/dump-to-sqlite.mjs`** is the inverse — runs the existing restore
path and writes a plain `.db`. Needed by validation, and it doubles as the
store's disaster-recovery tool; without it there is no way to get a
readable database back out of the bucket.

### Validation

Runs against the Lightsail URL *before* any traffic moves, as a hard gate.

**Database comparison** (in the `deploy-verify` package, so the logic is
unit-testable) between the backed-up source and the dumped post-boot
database. Not byte-wise — Ghost mutates state on boot even with no
migrations. Instead: row counts for every table, plus a checksum over
stable columns for the content tables (`posts`, `posts_meta`, `users`,
`roles`, `tags`, `posts_tags`, `members`, `newsletters`).

The design point is an **explicit allowlist of what is permitted to
differ** — the tables `sessions`, `jobs`, `actions`, `brute`, and
`integrations`/`api_keys` (the deploy-verify integration is deliberately
added), plus a named set of individual `settings` keys that Ghost rewrites
on boot, enumerated from an observed boot rather than guessed. A
difference in any table outside that list, or any settings key not named
in it, fails the check. This
makes "what legitimately changes on boot" a reviewable statement rather
than a judgement call made under pressure.

**Content check**, reusing `deploy-verify`'s existing Admin API client:
assert post/user/tag counts against the source database, then walk the
most recent posts and confirm every `feature_image` and every `<img src>`
in the rendered HTML returns 200. This is the only check that catches a
broken image path.

**Visual check** stays human: the script prints the URLs to eyeball (home,
a recent post with images, admin login).

## Runbook

Each step is reversible until the last, and Phase 1 keeps serving its own
untouched database throughout.

1. Back up EC2; upgrade it to the pinned stock `main` commit; verify
   healthy.
2. Apply prereqs (S3 + ECR).
3. Final backup: `VACUUM INTO` for the database, sync for images. **The
   accepted downtime window starts here** — anything written to Phase 1
   after this point is lost.
4. Seed the store from that database.
5. `deploy_lightsail=true`; build the image from the same pinned commit;
   deploy.
6. Validate against the Lightsail URL. **Hard gate** — a red check stops
   the cutover.
7. `deploy_cloudfront=true` — behaviours switch.
8. Re-validate on the real domain.

## Error handling

- Any failure before step 7 is inert: no traffic has moved, Phase 1 is
  untouched, and the fix is to correct and retry from the failed step.
- Rollback after step 7 is flipping `deploy_cloudfront` back to false and
  applying: behaviours return to the EC2 origin. Because the distribution
  and DNS never change identity, this takes effect in minutes.
- The EC2 instance stays running as the rollback target. Content written
  on Phase 2 after cutover does not exist on Phase 1, so rollback trades
  that content away — an accepted, stated cost, not a silent one.
- Seeding against a non-empty store fails rather than overwriting.

## Testing

- The database comparison and the content check are unit tested against
  fixtures, in the package where their logic lives.
- The seeder and its inverse get a round-trip test: seed a store from a
  known database, dump it back, assert equality.
- The backup extension, the IaC flags, and the CloudFront import are
  verified by being run for real — the import specifically by its
  empty-plan gate, which is a stronger check than any test could be.
- A full rehearsal against a scratch bucket before the real cutover is
  available and recommended, but the runbook's own gates are the primary
  protection.

## Out of scope

- Decommissioning the EC2 instance — it stays as the rollback target;
  retiring it is separate work.
- Reintroducing any Ghost source patch (moth `syigu`).
- Steady-state monitoring of the migrated site.
- Any change to Route53 or the certificate.
