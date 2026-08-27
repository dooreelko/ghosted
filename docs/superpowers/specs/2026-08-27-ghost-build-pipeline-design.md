# Ghost Custom Build & Deploy Pipeline — Design

Moth task: `qadpt` (Ghost Custom Build Deploy Pipeline)

## Goal

A versioned, repeatable way to run a locally-patched Ghost on the instance,
instead of the stock Ghost-CLI npm install — triggered by `syigu` (Social
Web) needing a source change Ghost's own config has no escape hatch for,
and expected to carry further local patches over time.

## Why not hand-patch the installed copy

The instance's `/var/www/ghost` is Ghost-CLI-managed; a manual edit there
gets silently wiped on the next `ghost update`, and isn't tracked or
reviewable anywhere. The user wants patches versioned and repeatable, with
moth tracking each one — this is infrastructure for that, not a one-off.

## Components

### Fork and patch tracking

`Ghost/` is a git submodule of this repo, pointed at `dooreelko/Ghost`
(already set up). A long-lived `local-patches` branch on that fork holds
our diffs on top of stock Ghost. Adopting a newer upstream Ghost release
means merging that upstream tag into `local-patches` (merge, not rebase —
the submodule pointer only ever moves forward to a real commit; a rebase
would force-push and orphan whatever commit the submodule pins). The
submodule's pinned commit in this repo is itself the version record of
"which patches, on top of which upstream release" are currently deployed.

### Build

Ghost's own release tooling already produces exactly the artifact we need:
`pnpm --filter ghost run archive` (`ghost/core/scripts/pack.mjs`) builds
`ghost-<version>-npm.tgz` — the same layout `ghost install|update --archive
<file>` consumes. Ghost's shipping docs describe this as supported for
testing CI builds, not the normal release path, but it's the sanctioned
mechanism rather than something invented for this project. Before packing,
bump `ghost/core/package.json`'s version with a local suffix (e.g.
`6.x.y-local.1`) so a custom build is never confused with a real upstream
release and each one is distinguishable. Built locally (or in CI later),
never on the instance — the `t3.micro`'s 1GB RAM already needed a swap file
for the original stock install (see `phase1.md`).

### Transfer + deploy

The instance has no SSH (management is SSM-only, per `phase1.md`). Shipping
the built tarball uses `scripts/ssm-scp.sh push` — chunked base64 over `aws
ssm send-command`, the same mechanism `scripts/ssm-backup-instance.sh`
already uses to pull files off the instance. On the instance, Ghost-CLI's
`--archive` install path swaps the tarball in (exact subcommand/flags to be
confirmed against the installed Ghost-CLI version during implementation —
Ghost's shipping docs point at `--archive` without pinning an exact CLI
version's syntax).

### First concrete patch: `isSocialWebEnabled()`

Ghost core unconditionally disables Social Web when the site's configured
URL has a path component (`ghost/core/core/server/services/settings-helpers/settings-helpers.js`,
`isSocialWebEnabled()` — a hard `if (subdirectory) return false`, no config
override). This guards a real constraint — WebFinger discovery (RFC 7033)
must resolve at the bare domain root — but does so with a static heuristic
that can't know when an operator has actually carved out root-level
ActivityPub routing (which `syigu`'s CloudFront work does).

The patch replaces that static check with a live self-probe: Ghost fetches
its own `https://<site-hostname>/.well-known/webfinger` and only allows the
feature to enable if that resolves correctly. Correctly permits our setup
once the CloudFront root routes exist; still refuses for anyone who hasn't
done that plumbing, which is the point of the original guard.

## Out of scope

- The `syigu` CloudFront/nginx work itself (still specified in
  `docs/superpowers/specs/2026-08-27-social-web-design.md`) — this pipeline
  is a prerequisite for it, not a replacement.
- Automating the fork's merge-upstream step — done by hand as needed, not
  on a schedule.
- Deciding what other Ghost patches come later — this pipeline is built
  general enough to carry them, but none beyond the `isSocialWebEnabled()`
  change are scoped here.
