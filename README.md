# reGhost

After it was pointed out that substack is happy to host and monetize [nazi content](https://www.theguardian.com/media/2026/feb/07/revealed-how-substack-makes-money-from-hosting-nazi-newsletters), I got finally motivated to seek an alternative.

And since I'm a cloud architect, this will become a little project of creating a VM-based instance of [Ghost](https://ghost.org/) and optimizing it cost-wise as much as possible all the while improving its architecture. Yak shaving? Maybe, but that's not the point.

Common for all phases is that the blog should be accessible via https://the-well-architected-cloud.com/blog

## Phase 1. VM

A naive single-VM implementation to establish a cost baseline.

## Phase 2. Containers

Containerize the application (aka improve resilience) without increasing costs (ideally decreasing).

## Phase 3. Magic

Make the application fully cloud-native, aka only running parts pf the application that are needed at the moment and only for as long as they are needed.

## Repos & branching

This repo (`ghosted`) holds phase-specific infra/docs (`phase1/`, `phase2/`,
...) plus internal packages (e.g. `phase2/packages/sqlite-s3`). The `Ghost`
directory is a git submodule pointing at a fork of
[TryGhost/Ghost](https://github.com/TryGhost/Ghost), used because the build
pipeline needs a custom image, not because Ghost's source is patched for the
S3-backed-SQLite work — that integration happens purely at runtime (see
`phase2/packages/ghost-sqlite-s3-launcher`).

Branches in the Ghost fork:

- **`main`** — a pure 1:1 mirror of `upstream/main`. Only ever
  fast-forwarded (`git merge --ff-only`) from upstream, never diverges,
  never force-pushed.
- **`fork_main`** — `main` merged in regularly; where the sqlite-s3
  launcher/config integration is actually exercised and smoke-tested. This
  is the branch any Phase 2 deployment builds from.
- **Feature/patch branches** (e.g. `local-patches`) — branch off `main`
  and get PR'd upstream directly via `gh pr create` against
  `TryGhost/Ghost`, independent of `fork_main`.

`scripts/sync-ghost.sh` (in this repo) automates the routine sync: fast-
forward `main` from upstream, merge it into `fork_main`, bump the
sqlite-s3 git-dependency ref if needed, then run the sqlite-s3 smoke test
against `fork_main`. Manual trigger only, no CI/cron yet.

