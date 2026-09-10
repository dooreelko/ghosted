deploy.sh exits 1 for two different outcomes: (a) tofu apply itself failed
(nothing deployed, store untouched) and (b) apply succeeded but
verification failed after the new version booted (store may be migrated).
upgrade.sh only sees the exit code, re-runs verify.mjs, and on ANY failure
proceeds to the destructive empty+reseed -- including case (a), where nothing
is wrong with the data at all. A transient verify failure (network blip,
expired admin key, CloudFront hiccup) at that moment triggers a full
destructive wipe of a perfectly healthy production database for no reason.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: have deploy.sh exit with distinct codes (e.g. 2 = apply
failed/nothing deployed, 3 = verified-failed-and-rolled-back) and gate
upgrade.sh's destructive restore on the latter only.
