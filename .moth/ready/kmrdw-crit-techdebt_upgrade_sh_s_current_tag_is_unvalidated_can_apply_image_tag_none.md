upgrade.sh queries the ACTIVE deployment's image tag via
`--query "deployments[?state=='ACTIVE']...image | [0]" --output text`. If no
deployment is ACTIVE at that exact moment (a deploy in flight, service still
DEPLOYING), the AWS CLI prints the literal string "None", and
"${None##*:}" is still "None" -- which then gets applied as
-var image_tag=None on the RECOVERY step, pushing a nonexistent image
reference to Lightsail as the fix for a broken deploy.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: validate CURRENT_TAG is non-empty and not "None" before
using it; fail loudly and leave the backup in place rather than applying
a bogus tag.
