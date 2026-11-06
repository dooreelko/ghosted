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
