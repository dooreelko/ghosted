#!/usr/bin/env bash
# Grants the Phase 1 appserver's instance role permission to sync Ghost's
# uploaded images into the Phase 2 data bucket (moth i8hlt, cutover step 0).
#
# Scoped deliberately narrow: PutObject only under the image prefix, and
# ListBucket only for that same prefix. The bucket also holds the SQLite
# store's segments and manifest, and the instance has no business reading or
# writing those -- it is the source of a one-way migration, not a
# participant in the store.
#
# Idempotent: put-role-policy replaces an inline policy of the same name, so
# re-running is safe and is the way to narrow the policy later.
#
# The role name is an argument rather than a constant because it is a Phase 1
# resource identifier, which must not live in a tracked file (see CLAUDE.md,
# Sensitive data). Its value is in .local-secrets.md under the Phase 1
# heading, as "IAM instance role". The bucket is not hardcoded either -- it
# is read from OpenTofu's own output, so this cannot drift from what the IaC
# actually created.
#
# Usage: scripts/attach-image-sync-policy.sh <instance-role-name>

set -euo pipefail

ROLE="${1:-}"
if [[ -z "$ROLE" ]]; then
  echo "usage: $0 <instance-role-name>" >&2
  echo "  the appserver's IAM instance role; value in .local-secrets.md" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IAC_DIR="$REPO_ROOT/phase2/iac"

echo "Reading the data bucket name from OpenTofu state..."
BUCKET="$(nix-shell -p opentofu --run "cd '$IAC_DIR' && tofu output -raw bucket_name")"
if [[ -z "$BUCKET" ]]; then
  echo "error: tofu output -raw bucket_name was empty -- has the prereq apply run?" >&2
  exit 1
fi

POLICY_DOC="$(
  cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/blog/content/images/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": {"StringLike": {"s3:prefix": "blog/content/images/*"}}
    }
  ]
}
JSON
)"

echo "Attaching inline policy ghost-phase2-image-sync to role $ROLE..."
aws iam put-role-policy \
  --role-name "$ROLE" \
  --policy-name ghost-phase2-image-sync \
  --policy-document "$POLICY_DOC"

echo "Attached. Inline policies now on $ROLE:"
aws iam list-role-policies --role-name "$ROLE"
