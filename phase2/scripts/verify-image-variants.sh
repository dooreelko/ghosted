#!/usr/bin/env bash
# Post-deploy check for the image size-variant fallback (moth a1jxt, building
# on rw2qy/f34h6): a never-generated size variant must reach a 200 through
# CloudFront without ever redirecting to itself -- for a client that follows
# redirects, and across the separate cache entries CloudFront keeps per
# Accept-Encoding (the gap that let rw2qy's curl-only check pass).
#
# Needs size variants that have never been requested: requesting a variant
# generates it for good, so each run needs fresh ones (pick theme sizes not
# yet used for the image, or upload a new image). The script refuses to run
# if any of them already exists in S3.
#
# Usage: verify-image-variants.sh <image-path> <fresh-size-1> <fresh-size-2> <existing-size>
#   e.g. verify-image-variants.sh 2026/09/flappy.png w300 w720 w960
# Env: SITE_URL (default https://the-well-architected-cloud.com/blog),
#      BUCKET (default: resolved from OpenTofu state, like deorphan.sh).
set -euo pipefail

if [ $# -ne 4 ]; then
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
IMAGE="$1"
FRESH_A="$2"
FRESH_B="$3"
EXISTING="$4"

SITE_URL="${SITE_URL:-https://the-well-architected-cloud.com/blog}"
SITE_URL="${SITE_URL%/}"
SITE_PATH="$(echo "$SITE_URL" | sed -E 's#^https?://[^/]+##')"
KEY_PREFIX="${SITE_PATH#/}/content/images"
KEY_PREFIX="${KEY_PREFIX#/}"
IMAGES_URL="$SITE_URL/content/images"
ORIGINAL_PATH="$SITE_PATH/content/images/$IMAGE"

REPO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
IAC_DIR="$REPO_ROOT/phase2/iac"
tofu_() { nix-shell -p opentofu --run "cd '$IAC_DIR' && tofu $*"; }
BUCKET="${BUCKET:-$(tofu_ "output -raw bucket_name")}"
BUCKET_REGION="$(aws s3api get-bucket-location --bucket "$BUCKET" --query LocationConstraint --output text)"
[ "$BUCKET_REGION" = "None" ] && BUCKET_REGION=us-east-1

FAILED=0
pass() { echo "  PASS  $*"; }
fail() {
  echo "  FAIL  $*"
  FAILED=1
}

s3_has() {
  aws s3api head-object --region "$BUCKET_REGION" --bucket "$BUCKET" --key "$1" >/dev/null 2>&1
}

# Prints "<status> <location> <cache-control>" for one non-following request.
probe() {
  local url="$1"
  shift
  curl -sS -o /dev/null -D - --max-redirs 0 "$@" "$url" |
    tr -d '\r' |
    awk 'tolower($1) ~ /^http\// { status = $2 }
         tolower($1) == "location:" { loc = $2 }
         tolower($1) == "cache-control:" { $1 = ""; sub(/^ /, ""); cc = $0 }
         END { printf "%s %s %s\n", status, (loc == "" ? "-" : loc), (cc == "" ? "-" : cc) }'
}

variant_url() { echo "$IMAGES_URL/size/$1/$IMAGE"; }
variant_path() { echo "$SITE_PATH/content/images/size/$1/$IMAGE"; }
variant_key() { echo "$KEY_PREFIX/size/$1/$IMAGE"; }

echo "== Preconditions"
if ! s3_has "$KEY_PREFIX/$IMAGE"; then
  echo "  original $KEY_PREFIX/$IMAGE not found in the bucket" >&2
  exit 1
fi
for size in "$FRESH_A" "$FRESH_B"; do
  if s3_has "$(variant_key "$size")"; then
    echo "  $size variant already exists in S3 -- not fresh, pick another size or image" >&2
    exit 1
  fi
done
pass "original present, $FRESH_A and $FRESH_B variants not generated yet"

echo "== First request for a fresh variant ($FRESH_A), redirects not followed"
read -r status loc cc < <(probe "$(variant_url "$FRESH_A")")
if [ "$status" = 302 ] && [ "$loc" = "$ORIGINAL_PATH" ] && [[ "$cc" == *no-store* ]]; then
  pass "302 -> original, Cache-Control: $cc"
else
  fail "expected 302 -> $ORIGINAL_PATH with no-store, got $status -> $loc ($cc)"
fi

echo "== Immediate repeat ($FRESH_A)"
read -r status loc cc < <(probe "$(variant_url "$FRESH_A")")
if [ "$status" = 200 ]; then
  pass "200"
elif [ "$status" = 302 ] && [ "$loc" = "$ORIGINAL_PATH" ]; then
  pass "302 -> original (still inside CloudFront's 1s MinTTL window)"
else
  fail "expected 200 or 302 -> original, got $status -> $loc"
fi
if [ "$loc" = "$(variant_path "$FRESH_A")" ] || [ "$loc" = "$(variant_url "$FRESH_A")" ]; then
  fail "redirects to itself"
fi

echo "== Browser-like follow, one cache entry per Accept-Encoding ($FRESH_B)"
for ae in "br, gzip, deflate" "gzip" ""; do
  args=(-sS -o /dev/null -L --max-redirs 3 -w '%{http_code} %{num_redirects} %{content_type}')
  [ -n "$ae" ] && args+=(-H "Accept-Encoding: $ae")
  if ! read -r code hops ctype < <(curl "${args[@]}" "$(variant_url "$FRESH_B")" 2>/dev/null || echo "loop - -"); then
    code=error
  fi
  label="Accept-Encoding: ${ae:-<none>}"
  if [ "$code" = 200 ] && [ "$hops" -le 1 ] && [[ "$ctype" == image/* ]]; then
    pass "$label -> 200 $ctype after $hops redirect(s)"
  else
    fail "$label -> $code after $hops redirect(s) ($ctype)"
  fi
done

echo "== Generated variants landed in S3"
for size in "$FRESH_A" "$FRESH_B"; do
  if s3_has "$(variant_key "$size")"; then pass "$size present"; else fail "$size missing"; fi
done

echo "== Regression: existing variant ($EXISTING)"
read -r status loc cc < <(probe "$(variant_url "$EXISTING")")
if [ "$status" = 200 ]; then pass "200"; else fail "expected 200, got $status -> $loc"; fi

echo "== Regression: missing original 404s instead of redirecting to itself"
missing="$IMAGES_URL/$(dirname "$IMAGE")/a1jxt-missing-$RANDOM$RANDOM.png"
read -r status loc cc < <(probe "$missing")
if [ "$status" = 404 ]; then pass "404"; else fail "expected 404, got $status -> $loc"; fi

echo "== Regression: size the theme doesn't allow still goes to the original"
read -r status loc cc < <(probe "$(variant_url w7)")
if [ "$status" = 302 ] && [ "$loc" = "$ORIGINAL_PATH" ]; then
  pass "302 -> original"
else
  fail "expected 302 -> $ORIGINAL_PATH, got $status -> $loc"
fi

echo
if [ "$FAILED" = 0 ]; then
  echo "All checks passed."
else
  echo "Some checks FAILED."
  exit 1
fi
