## Problem

Phase 3 splits a deploy in two: OpenTofu creates the functions from a placeholder
package and ignores their code and entry point afterwards; a separate script pushes
the built package to chosen functions. So a code-only change never shows in a plan,
a new function exists but answers 501 until the script runs, and a partial deploy
(one function at a time) is possible, which invites mismatch between functions.
The owner's rule: no partial deploys, tofu does the whole deploy, and a plan shows no
changes when there are no code changes.

## Decision (2026-11-06)

**OpenTofu owns code and entry point of every function.** The built package is
uploaded to the deploy bucket under a content-addressed name and every function
references it, with its hash, so a plan changes exactly when the built package does.
The build stays a separate step before the plan (producing an artifact is not a
deploy). The per-function deploy script is removed.

Why: one mechanism, one source of truth, no drift between functions, no placeholder
code path, and rollback is a re-apply of an older build.

## Consequences

- The first plan after the switch updates every existing function once (their live
  code is whatever the script last pushed); after that, no changes until the build
  changes.
- The package must exist at plan time when functions are enabled.
- Old packages keep expiring from the deploy bucket by lifecycle rule.

## Out of scope

- Building the package inside OpenTofu or CI.
- Staged / canary rollouts, function versions and aliases.
- The Lightsail (phase 2) deploy.



----- AI agent updates -------

## Decision record 2 (2026-11-06)

**The package's Node major must match the functions' runtime.** Native modules are per
Node ABI, so the build step (not tofu) has to be run for the runtime the IaC declares;
a package built for another major fails its own trace tests, which is the early
warning. The IaC refuses to plan when the package file is missing (so a plan never
silently uses stale code), but cannot check its Node major.

**The placeholder package is removed** along with the per-function deploy script; the
functions stage's apply script now only plans and applies, with the build as its
documented prerequisite.

**Known follow-up (not done here):** variable defaults for the cutover, admin client
and container flags do not match live state, so a plain plan (or the stage script,
which passes only the functions flag) shows unrelated destroys. The live flags must
be passed explicitly until the defaults are made to match, which the "no planned
changes without code changes" rule needs. Noted rather than changed: it alters what a
bare apply does to live traffic.


## Decision record 3 (2026-11-06)

**Defaults describe the full Phase 3 rollout; every deploy is the whole deploy.**
Resolves the follow-up above: functions, the Phase 3 edge and the hosted admin client
default on; the container service defaults off (it is gone). A plan with no flags
passed shows only real changes. Why: partial deploys and flag juggling were what made
plans show unrelated destroys; one state, one command. Rejected: keeping defaults as
a staged-rollout ladder and passing live flags per deploy.

**The container image tag is meaningless now** and keeps a deliberately non-real
default instead of a required value (its validation is dropped). The single deploy
script replaces the stage-one script and takes no arguments.

Not changed: the Phase 2 module and its scripts (separate state, still flag-driven),
and the one-shot adoption script, which is historical.


## Decision record 4 (2026-11-06)

**The container service is removed from the Phase 3 configuration** (service,
deployment, runtime role, its three alarms, the pre-flip edge branches that pointed at
it) together with the flags that only existed for it (container, redeploy, image tag,
the cutover-era CloudFront switch, the hosted-admin-client switch, whose "off" state
only existed to route to the container). Phase 2 keeps its own copy in its own state.

**Phase 2's data bucket and image repository are kept but no longer managed here:**
forgotten from Phase 3's state, never destroyed (they live on, owned by Phase 2's
state). Rejected: leaving them managed here (two states owning one resource) and
deleting them (Phase 2 still uses both).

The one-shot state-adoption script is removed (its job is done and it depended on the
removed flags). Kept: the cutover flag for the edge.
