migration.md step 0 and the cloudfront.tf comment both list four values
with no default that phase1.auto.tfvars must supply. variables.tf actually
declares five with no default: vpc_origin_id, appserver_private_dns,
marketing_root_oac_id, marketing_root_origin_domain, and
site_acm_certificate_arn. marketing_root_origin_domain is the one omitted
from both places. Anyone rebuilding phase1.auto.tfvars from the docs alone
gets a plan that fails.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: add the missing variable to migration.md step 0's list and
to the cloudfront.tf comment.
