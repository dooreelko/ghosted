phase2/readme.md's Upgrade process section says "forces one more restart
(via the redeploy toggle, see Design above)" -- the Design section contains
no mention of redeploy. The toggle is documented only in
phase2/iac/variables.tf.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: either add a line about the redeploy toggle to Design, or
fix the cross-reference to point at variables.tf / wherever it's actually
documented.
