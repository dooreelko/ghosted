#!/usr/bin/env bash
set -euo pipefail

BUCKET_NAME="${1:?usage: create-bucket.sh <bucket-name> <region>}"
REGION="${2:?usage: create-bucket.sh <bucket-name> <region>}"

if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION"
else
  aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi

aws s3api put-bucket-tagging --bucket "$BUCKET_NAME" --tagging \
  'TagSet=[{Key=purpose,Value=sqlite-s3-smoke-test},{Key=throwaway,Value=true}]'

echo "Created throwaway bucket: $BUCKET_NAME (region $REGION)"
echo "Remember to delete it after the smoke test:"
echo "  aws s3 rb s3://$BUCKET_NAME --force"
