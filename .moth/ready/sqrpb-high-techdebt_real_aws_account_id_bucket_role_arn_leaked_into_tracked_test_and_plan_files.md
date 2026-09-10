Project convention (CLAUDE.md) is zero AWS resource IDs/credentials in
tracked files, routed through .local-secrets.md instead --
variables.tf/iam.tf/cloudfront.tf all follow this scrupulously. Violations
found:
- phase2/packages/deploy-verify/test/s3-object-delete.test.mjs: the real
  live bucket name "ghost-phase2-data-699571927575" appears 5 times
- phase2/packages/deploy-verify/test/previous-deployment.test.mjs: the real
  ECR repo URL "699571927575.dkr.ecr.us-east-1.amazonaws.com/ghost-phase2"
- docs/superpowers/plans/2026-09-08-phase2-deploy-observability-plan.md:
  6 occurrences, including the ECR repo
- docs/superpowers/plans/2026-09-08-phase2-docker-iac-plan.md: the real
  role ARN arn:aws:iam::699571927575:role/ghost-phase2-app-runtime

The sibling test ghost-sqlite-s3-launcher/test/aws-credentials.test.mjs
correctly uses the placeholder account id 123456789012, so the fix is
mechanical and the convention is already established elsewhere.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: replace the real account id/bucket/ARN in the two test
files with placeholder values (matching the aws-credentials.test.mjs
pattern). The two docs/superpowers/plans/*.md files are historical planning
docs -- discuss whether to redact those too or accept them as already-
published history.
