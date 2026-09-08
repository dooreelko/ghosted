subtask of hi3zi

## Decisions

**Sync mechanism, not source patching**: `phase2/packages/sqlite-s3/smoke/preload.mjs`
already proved sqlite-s3 wires into Ghost purely at runtime — a Node
`--import` preload script that monkeypatches `@tryghost/database-info`'s
SQLite detection and overrides Ghost's config (`database:client` set to
the `SqliteS3Client` class) before Ghost boots. Ghost's own source is
never diffed or patched. The regular-integration pipeline therefore
doesn't need to rebase/reapply any Ghost-side patch — "integration"
reduces to keeping a Ghost checkout and the sqlite-s3 package paired and
verified together.
- Rejected: a dedicated "wiring patch" branch in the Ghost fork that
  gets rebased onto upstream each run — moot once the zero-diff preload
  mechanism was confirmed working (see smoke test).

**Branch model in the Ghost fork**: `main` stays a pure 1:1 mirror of
`upstream/main` (TryGhost/Ghost), synced with `git merge --ff-only`
only — never diverges, never force-pushed. A separate `fork_main`
branch carries `main` merged in regularly and is where the sqlite-s3
launcher/config integration is actually exercised and smoke-tested.
Feature/patch branches (e.g. the existing `local-patches` branch) branch
off `main` and get PR'd upstream directly via `gh pr create` against
`TryGhost/Ghost`, independent of `fork_main`.
- Rejected: syncing via rebase — would rewrite `main`'s history and
  force `local-patches`-style branches to rebase too; merge is safe for
  a branch pushed to `origin` and upstream Ghost's history doesn't need
  linearizing.
- Rejected: routing the routine upstream sync itself through a `gh pr
  create` review step — `gh` is used for the outbound direction
  (feature branches -> TryGhost/Ghost PRs), not for the routine sync
  into the fork, which pushes directly.

**Distribution: sqlite-s3 as a git dependency**, not a private npm
registry and not a file: link. Ghost's own `package.json` is never
touched (see above); instead a new small launcher package depends on
`@ghost-phase2/sqlite-s3` via a git dependency (this repo, tag or
commit), so npm/pnpm install pulls sqlite-s3's built source straight
from git with no registry/publish step to maintain.
- Rejected: private npm registry (GitHub Packages) — extra auth/publish
  machinery not justified for a single internal consumer.
- Rejected: `file:` dependency — fine for local dev/smoke iteration
  (which is what the current smoke test does via bind mount) but not a
  real answer for "regularly integrate," since it only works from
  inside this monorepo's checkout layout.

**New launcher package** (`phase2/packages/ghost-sqlite-s3-launcher`)
generalizes the existing `smoke/preload.mjs`: same monkeypatch/config-
override mechanism, but takes the Ghost checkout path and sqlite-s3/S3
config from environment instead of the smoke test's hardcoded
`../../../../` relative path, so it can run against any `fork_main`
checkout, not just this monorepo's bind-mounted layout. This is the
component that actually performs the "integration" — Ghost's tree
(`main` and `fork_main` alike) is never modified.

**Sync script** (this repo, e.g. `scripts/sync-ghost.sh`), triggered
manually only (no CI/cron yet): fetch upstream + origin, fast-forward
`main` onto `upstream/main` and push, merge `main` into `fork_main` and
push, verify/bump the sqlite-s3 git-dependency ref if it changed, then
run the existing sqlite-s3 smoke test
(`phase2/packages/sqlite-s3/smoke/run-smoke-test.sh`) against
`fork_main` + current sqlite-s3. On smoke-test failure, the script stops
and reports rather than auto-reverting anything. Idempotent and safe to
re-run for either trigger (new upstream Ghost commits, or a new
sqlite-s3 commit in this repo).
- Rejected: automated CI/cron trigger and auto-merge-on-green — out of
  scope for now; may be added later once the manual flow is proven.

----- AI agent updates -------

## Implementation abstract

**Branch model, live**: `Ghost/` fork's `main` fast-forwarded to
`upstream/main` (was 36 commits behind) and pushed to `origin`.
`fork_main` created off the updated `main` and pushed — currently
identical to `main` since this is the first sync. Checkout left on
`fork_main` going forward, matching the decision that it's the branch
integration work happens against.

**Launcher package, live**: `phase2/packages/ghost-sqlite-s3-launcher`
holds a `src/preload.mjs` derived from the smoke test's preload script,
generalized to read a Ghost-checkout root, S3 bucket/region, and
checkpoint tuning from environment variables instead of a hardcoded
relative path, and to import `@ghost-phase2/sqlite-s3` as a real
dependency (resolved via node_modules) rather than a relative source
import. Its `package.json` depends on `@ghost-phase2/sqlite-s3` via a
git dependency using npm's `#<commit>:<subdirectory>` syntax, pinned to
this repo's own commit (self-referential: this repo hosts both the
launcher and the sqlite-s3 package it depends on).

**Sync script, live**: `scripts/sync-ghost.sh` performs the steps
described above end-to-end — fetch, ff-only main, merge into
fork_main, push both, then compares this repo's current HEAD against
the launcher's pinned sqlite-s3 commit and rewrites the pin in place
(via `sed`) when the `phase2/packages/sqlite-s3` tree differs between
those two commits, leaving the resulting `package.json` change
uncommitted for review before the next run. Finally shells out to the
existing (interactive) smoke test — unchanged, not automated further —
against whatever is now checked out in `Ghost/` (i.e. `fork_main`
post-sync).

**README, live**: top-level `README.md` gained a "Repos & branching"
section describing the submodule/fork relationship and the three
branch roles (`main`/`fork_main`/feature branches), pointing at
`scripts/sync-ghost.sh` as the automation entry point.

**Not run this session**: the smoke test itself (needs a live S3
bucket + AWS credentials + manual post-creation step) — the pipeline's
git/branch/package mechanics were exercised directly instead.


**Smoke-test run attempted, live**: ran `scripts/sync-ghost.sh`
end-to-end (main ff'd, fork_main synced, launcher pin checked) with
real AWS credentials present. The smoke test's own manual gate
("create a post, press enter") blocked the unattended run and the
script exited non-zero there — leaked a throwaway bucket and a running
container, cleaned up by hand. In response, the sync script now tears
down the smoke containers and deletes the bucket after a *successful*
run (only when it created the bucket itself) — on failure both are
left in place for debugging, per the existing "stop and report, never
auto-revert" stance. The smoke test's manual post-creation step itself
stays as-is (not automated) — out of scope for this ticket.


**Sync script now also runs the e2e suite, live**: sqlite-s3's e2e
Cucumber suite (`npm run test:e2e`) is fully automated — real S3, own
throwaway bucket created/torn down inside its own hooks — unlike the
smoke test's manual "create a post" gate. Added to `scripts/sync-ghost.sh`
ahead of the smoke test, as the unattended-safe verification step; the
smoke test remains the attended-only, bimodal step after it. Ran it
standalone against real AWS this session: 2/2 scenarios passed, its
bucket self-cleaned (confirmed via `aws s3 ls`).
