Build Ghost from source (Ghost/ is a git submodule, tracked, pointed at a fork) instead of
the stock Ghost-CLI npm install, so we can carry local patches to Ghost core.

Trigger: social web (moth syigu) needs a patch to isSocialWebEnabled()
(ghost/core/core/server/services/settings-helpers/settings-helpers.js) to
drop its unconditional subdirectory check -- confirmed in Ghost's own
source there's no config-driven way around it, and hand-patching the
npm-installed copy on the instance would get silently wiped by `ghost
update`.

Requirements (from user): versioned, repeatable, tracked via moth tasks.
Not a one-off hand-edit -- a real build/deploy pipeline other future Ghost
source changes can reuse.

Open (to brainstorm/spec): how patches are tracked (fork branch vs patch
files), build location (local/CI, per earlier discussion -- build locally,
ship the artifact over SSM, not built on the 1GB instance), versioning
scheme, how it replaces the Ghost-CLI-managed install without breaking
`ghost update`/`ghost status` tooling going forward.


## Decision

Fork (dooreelko/Ghost, submodule at Ghost/) with a long-lived `local-patches`
branch, upstream releases merged in (not rebased — keeps the submodule
pointer forward-only). Build via Ghost's own `pnpm --filter ghost run
archive` (the same tarball layout `ghost install|update --archive` already
accepts) with a locally-suffixed version. Shipped to the instance with
scripts/ssm-scp.sh (chunked over SSM, no SSH exists). Deployed via
Ghost-CLI's --archive path.

First concrete patch: replace isSocialWebEnabled()'s static subdirectory
check with a live self-probe against the site's own /.well-known/webfinger
(see moth syigu's decision section for why the static check exists and why a probe
is safer than a blind bypass).

Full technical spec: docs/superpowers/specs/2026-08-27-ghost-build-pipeline-design.md


## Deployed 2026-08-28

Instance now runs the custom build (6.57.1-local.2) with the webfinger
self-probe patch. One production incident along the way: first attempt
crash-looped and ghost-cli's own auto-rollback also failed, ~8 min outage,
recovered via manual symlink rollback (no DB changes) -- root cause was a
missing build step (pnpm build:tsc) before packing, not the patch content.
Fixed by replicating the real build sequence from Ghost's own CI
(.github/workflows/ci.yml, job_pack), verified locally (module resolution,
full prod dep install, boot.js require chain) before the successful
redeploy. Admin UI build is copied same-host from the known-good version
after each deploy rather than built (not part of this patch).

Toolkit that came out of this (all in scripts/, all committed): ssm-scp.sh
(generic push/pull), ssm-backup-instance.sh, ssm-install-ghost-cli-sudoers.sh,
ssm-fix-theme-permissions.sh, ssm-deploy-ghost-update.sh,
ssm-rollback-ghost.sh, ssm-copy-admin-build.sh. Matches the user's stated
goal of having automated setup/backup/update/rollback+restore scripts for
future feature work, not just this one patch.

Still pending: user to confirm the admin UI actually renders/logs in
correctly in a real browser (only HTTP-200-with-content verified
programmatically so far). Not marking this issue done until that lands.

Also raised, deferred: an S3 bucket for large instance file transfers
(current chunked-over-SSM approach works but is slow/limited for anything
much bigger than the tarballs handled so far -- the 19MB admin build was
sidestepped rather than transferred). Needs its own IAM change, not yet
designed.


## Verified 2026-08-28

Confirmed live in browser: admin dashboard renders fully (analytics,
members, posts data all correct) on the deployed custom build. Toggling
Social Web still correctly refuses ("You need to configure a supported
custom domain") - expected, since syigu's CloudFront root .well-known
routing doesn't exist yet. This confirms the probe patch behaves exactly
as designed: fail-safe until the actual prerequisite is in place, not
broken. qadpt's job (build/deploy pipeline + the patch itself) is done;
unblocking the toggle is syigu's remaining work.
