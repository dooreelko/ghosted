migration.md step 1 ("Upgrade Phase 1 to the target version") documents
upgrading the Phase 1 instance to the target version before taking the
final backup. Moth i8hlt's "Decisions forced by executing the cutover"
records the opposite as what actually happened: "Version alignment is
achieved by pinning the new system DOWN to the old one's version, not by
upgrading the old one first... Rejected: upgrading the source first (the
earlier decision)." Since migration.md presents itself as the record of
what was executed on 2026-09-10, it currently misrepresents it. The same
stale assumption is baked into deploy-verify/src/db-compare.mjs's own
comment ("the EC2 instance is upgraded to the target version before its
database is taken").

Related omissions from migration.md, all recorded as forced decisions in
the moth ticket but missing from the runbook: the admin-integration-must-
be-created-on-the-source-before-step-3 ordering (step 6 assumes the SSM
parameter simply exists), the volatileColumns allowlist (step 6 only
mentions settingsKeys), the Host-header decision, and a pointer to
empty-store.sh at step 4 where seeding refuses to overwrite.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: rewrite migration.md step 1 (and the db-compare.mjs comment)
to match what the moth record says was actually decided and executed;
fold in the related omissions above. Historical-accuracy fix, not a design
change -- migration.md is a completed runbook, not living architecture.
