# Social Web (ActivityPub + Bridgy Fed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New posts on `https://the-well-architected-cloud.com/blog` automatically reach Mastodon and Bluesky followers, using Ghost 6's built-in ActivityPub feature (no custom code, no new secrets).

**Architecture:** Enable Ghost's native Social Web setting, then extend the existing CloudFront → VPC-origin → nginx → Ghost path (documented in `phase1.md`) with three ActivityPub-specific routes. Bluesky reachability comes from a one-time Bridgy Fed opt-in, not any code change.

**Tech Stack:** Ghost 6 (built-in ActivityPub service), nginx (reverse proxy on the instance), AWS CloudFront (cache behaviors), AWS CLI (`aws cloudfront`), SSM Session Manager (only access path to the instance — no SSH).

**Spec:** `docs/superpowers/specs/2026-08-27-social-web-design.md`

## Global Constraints

- No AWS resource IDs, credential names, or account IDs in this file or any
  other tracked file — look them up in `.local-secrets.md` (gitignored) by
  the header `## Ghost On A Stick (moth task jpjiy)`, and refer to them here
  by role only.
- Instance access is **exclusively** via `aws ssm start-session --target
  <instance-id>` — no SSH, no bastion.
- No AWS security group changes (CloudFront already fronts the domain
  publicly on the existing paths).
- No new secrets in SSM Parameter Store or `.local-secrets.md` — this
  feature needs no API token for Mastodon or Bluesky.
- Every new CloudFront behavior must use the managed **CachingDisabled**
  cache policy and the managed **AllViewer** origin request policy, matching
  the existing `/blog/ghost/*` and `/blog/members/*` behaviors (per
  `phase1.md`).

---

### Task 1: Enable Social Web in Ghost and discover the actor's routing shape

Ghost's ActivityPub actor discovery convention (webfinger/nodeinfo at the
domain root) may not match how this site is currently addressed (everything
else lives under `/blog`). This task establishes ground truth before any
infra change is made, so Task 3 isn't guessing at paths.

**Files:** none (admin UI + read-only instance inspection)

**Interfaces:**
- Produces: the confirmed local port the ActivityPub service listens on
  (call it `$AP_PORT` in later tasks), and the confirmed path shape Ghost
  expects for webfinger/nodeinfo/inbox (call it `$AP_ROOT`, either domain
  root or `/blog`-scoped) — write both down, later tasks depend on them.

- [ ] **Step 1: Log into Ghost admin and enable the feature**

Open `https://the-well-architected-cloud.com/blog/ghost/#/settings/network`
(adjust the path if Ghost 6's admin nav has it elsewhere — look for
"Distribute posts to the social web" / "Social Web") and toggle it on. Note
the actor handle Ghost displays (expected shape: `@index@the-well-architected-cloud.com`).

- [ ] **Step 2: Open an SSM session to the instance**

```bash
aws ssm start-session --target <instance-id from .local-secrets.md>
```

- [ ] **Step 3: Find the ActivityPub service's local port and Ghost's config**

```bash
sudo -u ghost ghost status                 # confirm Ghost 6.x is running, note the content dir
cat /var/www/ghost/content/config.production.json | grep -i -A3 activitypub
sudo ss -ltnp | grep -E ':(2368|2369)'     # confirm what's actually listening
```

Record whichever port shows up alongside 2368 as `$AP_PORT`. If nothing
listens on a second port, check `ghost log` output for how the ActivityPub
service is wired (Ghost 6 self-hosted may run it in-process rather than as
a separate listener — if so, `$AP_PORT` is the same as Ghost's own port,
2368, and no separate proxy target is needed beyond what nginx already
proxies).

- [ ] **Step 4: Confirm the expected path shape**

```bash
curl -s http://127.0.0.1:2368/.well-known/webfinger'?resource=acct:index@the-well-architected-cloud.com'
curl -s http://127.0.0.1:2368/blog/.well-known/webfinger'?resource=acct:index@the-well-architected-cloud.com'
```

Whichever returns a JSON JRD document (not a 404) tells you `$AP_ROOT`:
domain root or `/blog`-scoped. Record it — Tasks 2 and 3 both branch on
this.

- [ ] **Step 5: Exit the SSM session**

```bash
exit
```

No commit — this task only produces the two recorded values (`$AP_PORT`,
`$AP_ROOT`) used by Tasks 2–3.

---

### Task 2: Add nginx proxy rules for the ActivityPub paths

**Files:**
- Modify: the nginx site config on the instance — `phase1.md` doesn't name
  the exact filename, so Step 1 below discovers it live via
  `/etc/nginx/sites-enabled/` rather than guessing.

**Interfaces:**
- Consumes: `$AP_PORT`, `$AP_ROOT` from Task 1.
- Produces: nginx forwards `$AP_ROOT/.ghost/activitypub/*`,
  `$AP_ROOT/.well-known/webfinger`, `$AP_ROOT/.well-known/nodeinfo` to
  `127.0.0.1:$AP_PORT`, matching headers already used for the main Ghost
  proxy block (`X-Forwarded-For`, `X-Forwarded-Proto`, `Host`).

- [ ] **Step 1: Open an SSM session and locate the nginx config**

```bash
aws ssm start-session --target <instance-id from .local-secrets.md>
sudo ls /etc/nginx/sites-enabled/
sudo cat /etc/nginx/sites-enabled/<the-one-file-there>
```

Confirm the structure of the existing `location / { proxy_pass ... }`
block — the new blocks below must forward the same three headers it does.

- [ ] **Step 2: Add the new location blocks**

Using `sudo -e /etc/nginx/sites-enabled/<file>` (or `sudo vi`), add, inside
the existing `server {}` block, alongside the existing `location /`:

```nginx
location ~ ^AP_ROOT_PLACEHOLDER/\.ghost/activitypub/ {
    proxy_pass http://127.0.0.1:AP_PORT_PLACEHOLDER;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}

location = AP_ROOT_PLACEHOLDER/.well-known/webfinger {
    proxy_pass http://127.0.0.1:AP_PORT_PLACEHOLDER;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}

location = AP_ROOT_PLACEHOLDER/.well-known/nodeinfo {
    proxy_pass http://127.0.0.1:AP_PORT_PLACEHOLDER;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}
```

Replace `AP_ROOT_PLACEHOLDER` with the empty string or `/blog` (per Task
1's finding — if root-scoped, drop the prefix from the regex/path
entirely) and `AP_PORT_PLACEHOLDER` with `$AP_PORT` from Task 1. If Task 1
found the ActivityPub service is in-process on Ghost's own port, these
blocks can likely be dropped entirely (the existing `location /` already
proxies everything to that port) — confirm with Step 3 below before adding
blocks that would just duplicate existing behavior.

- [ ] **Step 3: Test and reload nginx**

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Expected: `syntax is ok` / `test is successful`, reload with no error.

- [ ] **Step 4: Verify locally on the instance**

```bash
curl -s http://127.0.0.1:8000/<AP_ROOT>/.well-known/webfinger'?resource=acct:index@the-well-architected-cloud.com'
```//port 8000 is nginx's listen port per phase1.md
Expected: same JRD JSON document Task 1 found directly against Ghost.

- [ ] **Step 5: Exit SSM, commit if the config file is tracked anywhere**

This repo doesn't track instance config (per `phase1.md`, install was
manual) — nothing to commit. Note the final nginx diff in
`.local-secrets.md` under the `Ghost On A Stick` section only if it adds
new operational detail worth remembering (e.g. the confirmed `$AP_PORT`),
skip otherwise.

---

### Task 3: Add CloudFront cache behaviors for the ActivityPub paths

**Files:** none (AWS CloudFront distribution config, not repo-tracked)

**Interfaces:**
- Consumes: `$AP_ROOT` from Task 1; the distribution ID, VPC-origin id, and
  the managed policy IDs (from `.local-secrets.md` / AWS managed policies,
  not this repo).
- Produces: CloudFront forwards the three ActivityPub paths to the same VPC
  origin already serving `/blog/*`.

- [ ] **Step 1: Fetch the current distribution config**

```bash
DIST_ID=<CloudFront distribution ID from .local-secrets.md>
aws cloudfront get-distribution-config --id "$DIST_ID" > /tmp/dist.json
ETAG=$(jq -r .ETag /tmp/dist.json)
jq .DistributionConfig /tmp/dist.json > /tmp/dist-config.json
```

- [ ] **Step 2: Locate the existing `/blog/ghost/*` behavior as a template**

```bash
jq '.CacheBehaviors.Items[] | select(.PathPattern == "/blog/ghost/*")' /tmp/dist-config.json
```

Confirm which `TargetOriginId`, `CachePolicyId` (managed CachingDisabled),
and `OriginRequestPolicyId` (managed AllViewer) it uses — the new
behaviors reuse the same three values.

- [ ] **Step 3: Add the new behaviors**

If `$AP_ROOT` (from Task 1) is domain-root-scoped, add these three
`PathPattern`s: `/.ghost/activitypub/*`, `/.well-known/webfinger`,
`/.well-known/nodeinfo`. If `$AP_ROOT` is `/blog`-scoped, add
`/blog/.ghost/activitypub/*` instead of the first (the other two are
inherently root-level per the webfinger/nodeinfo spec regardless of
`$AP_ROOT` — re-check Task 1 Step 4's actual result before assuming).

```bash
TEMPLATE=$(jq '.CacheBehaviors.Items[] | select(.PathPattern == "/blog/ghost/*")' /tmp/dist-config.json)

jq --argjson tmpl "$TEMPLATE" '
  .CacheBehaviors.Items += [
    ($tmpl | .PathPattern = "/.ghost/activitypub/*"),
    ($tmpl | .PathPattern = "/.well-known/webfinger"),
    ($tmpl | .PathPattern = "/.well-known/nodeinfo")
  ]
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length)
' /tmp/dist-config.json > /tmp/dist-config-new.json
```

(Adjust the `PathPattern` values per Task 1's finding before running this.)

- [ ] **Step 4: Push the updated config**

```bash
aws cloudfront update-distribution \
  --id "$DIST_ID" \
  --if-match "$ETAG" \
  --distribution-config file:///tmp/dist-config-new.json
```

- [ ] **Step 5: Wait for deployment and verify**

```bash
aws cloudfront wait distribution-deployed --id "$DIST_ID"
curl -s 'https://the-well-architected-cloud.com/.well-known/webfinger?resource=acct:index@the-well-architected-cloud.com'
```

(Adjust the URL path per `$AP_ROOT`.) Expected: the same JRD JSON document
verified locally in Task 2 Step 4, now reachable over the public domain.

- [ ] **Step 6: Clean up temp files**

```bash
rm -f /tmp/dist.json /tmp/dist-config.json /tmp/dist-config-new.json
```

No repo commit — this task only changes AWS-side config, not tracked
files.

---

### Task 4: Bridgy Fed opt-in and end-to-end verification

**Files:** none

**Interfaces:** none (final verification task, consumes nothing new)

- [ ] **Step 1: Verify Mastodon discovery**

From any Mastodon account (e.g. `hachyderm.io`), search for
`@index@the-well-architected-cloud.com` and follow it.

- [ ] **Step 2: Publish a test post and confirm delivery**

Publish (or use an existing) post on the blog, then confirm it appears in
the following Mastodon account's timeline within a few minutes.

- [ ] **Step 3: Opt into Bridgy Fed bridging for Bluesky**

Follow Bridgy Fed's fediverse-to-Bluesky bridging steps (per
`docs/superpowers/specs/2026-08-27-social-web-design.md`) — this is a
one-time action on the Bluesky/Bridgy Fed side, not a Ghost or AWS change.

- [ ] **Step 4: Confirm the same post surfaces on Bluesky**

Check `@the-well-architected-cloud.com.ap.brid.gy` on Bluesky for the
bridged post.

- [ ] **Step 5: Record final state**

Update `.local-secrets.md` under `Ghost On A Stick` with the confirmed
`$AP_PORT` / `$AP_ROOT` values and the fact that ActivityPub behaviors were
added to the distribution (no new IDs are created by this change — the new
behaviors live inside the existing distribution's config). Run `moth show
syigu` and, once verification above passes, move the issue to done with
`moth done syigu` (per this repo's moth workflow) — do this only after the
user confirms end-to-end delivery worked, not automatically.

No code commit for this task (operational/config only).
