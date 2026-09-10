iam.tf's PublishBootMetrics statement comment says
cloudwatch:PutMetricData "does not support resource-level scoping (AWS
limitation...) -- Resource must be \"*\"", which is true for the Resource
element, but omits that the cloudwatch:namespace condition key exists and
would scope the grant to just GhostPhase2/SqliteS3. Everything else in
iam.tf is tightly scoped (the KMS-by-alias lookup is a nice touch), so this
is the one loose grant in an otherwise careful file.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: add a StringEquals condition on cloudwatch:namespace to the
PublishBootMetrics statement.
