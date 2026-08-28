enable integration into social web 
the domain is https://the-well-architected-cloud.com

the goal maximum is to have automatic publishing to mastodon and bluesky when a new post is ready

ideally using an existing bsky handle https://bsky.app/profile/well-architected.bsky.social and mastodon https://hachyderm.io/@sascha_fedorenko

## Decision

Use Ghost 6's built-in ActivityPub/"Social Web" feature (native), not a custom
webhook-driven crossposter that posts under the existing Mastodon/Bluesky handles.

Why: zero new secrets, zero application code to write/maintain. Trade-off accepted:
posts appear under a new site identity (an ActivityPub actor tied to the domain),
not the existing personal accounts. Bluesky reachability comes via Bridgy Fed
bridging that new identity — no Bluesky API credential needed either.

Explicitly out of scope: linking/cross-following the existing personal Mastodon
and Bluesky accounts to the new site identity. Manual follow-up, not part of
this task.

## What implementing this involves

- Enable the feature in Ghost admin.
- CloudFront needs new routes added for ActivityPub's discovery/inbox paths,
  including some that conventionally live at the domain root rather than under
  the existing `/blog` path prefix — will need a bit of care given the existing
  default (root) behavior already serves the static site from S3.
- nginx on the instance needs proxy rules added for those same paths.
- One-time opt-in on the Bluesky side (Bridgy Fed) to bridge the new identity.
- No AWS security group changes, no new credentials in `.local-secrets.md`.

Full technical spec (routes, ports, verification commands) lives in
`docs/superpowers/specs/2026-08-27-social-web-design.md` — this entry is the
decision record, not the implementation detail.


## Update 2026-08-27: blocker found, plan revised

Ghost refuses to enable Social Web at all when the site is hosted under a
path (`/blog`), confirmed both live (toggle blocked with "You need to
configure a supported custom domain") and in Ghost's own source
(`isSocialWebEnabled()` in `settings-helpers.js` unconditionally returns
false when `urlUtils.getSubdir()` is truthy — no config escape hatch).

The check is a blunt proxy for a real constraint: WebFinger discovery
(RFC 7033) must resolve at the bare domain root, which this site's default
CloudFront behavior currently gives to the existing S3 static site, not
Ghost. The plan's original CloudFront work (root-level `/.well-known/*`
routes to Ghost, carved out ahead of the S3 default behavior) already
satisfies that real constraint — Ghost's check just can't know that.

Decision: patch the check out (`isSocialWebEnabled()`), rather than switch
to a custom-crossposter/API-token approach or abandon the feature. Since
this means running a locally-built Ghost instead of the stock Ghost-CLI
npm install (a hand-patch of the installed copy would get silently wiped
by `ghost update`), and since more Ghost source changes are anticipated,
the build/deploy pipeline itself is tracked as its own task: moth `qadpt`
(Ghost Custom Build Deploy Pipeline). This task depends on `qadpt` landing
first; the CloudFront/root-webfinger work from the original decision above
still applies once the patched build is deployed.


## Update 2026-08-28: second blocker found, second dependency spun off

qadpt's build pipeline and webfinger self-probe patch deployed and verified
working (admin renders, toggle correctly fails-safe). But confirmed via
`.well-known/webfinger` returning Express's generic "Cannot GET" 404 (not
a Ghost-specific response) that self-hosted Ghost has no local ActivityPub
server at all -- no systemd unit, no package, nothing on a second port.
ghost/core's own activity-pub-service.ts only talks to
`.ghost/activitypub/v1/...`, which is Ghost(Pro)'s managed cloud
infrastructure. nginx confirmed to already proxy everything for this
domain regardless of path (`server_name _`, single `location /`), so no
nginx change is needed either way -- CloudFront routing was never the
actual blocker.

Spun off as its own task: moth `gfoig` (TryGhost ActivityPub self-hosted
server) -- deploying the standalone TryGhost/ActivityPub server is real
infra work (new process, port, likely its own DB, resource question on a
1GB instance, CloudFront routes) deserving its own spec, not something to
decide inline here. `syigu` now depends on `gfoig` landing before the
CloudFront/webfinger work from the original decision above can actually
be exercised.


## Shelved 2026-08-28

Native Social Web requires gfoig (self-hosted ActivityPub server), which
was shelved after research showed it's genuinely Ghost(Pro)'s multi-tenant
SaaS backend, not a lightweight self-hostable component -- see gfoig for
the full reasoning. Shelving this too rather than leaving it blocked on
something that isn't going to land.

If revisited, the custom-crossposter option from the original brainstorm
(webhook on publish -> post via Mastodon/Bluesky APIs under the existing
hachyderm.io/bsky.social accounts) is the live alternative -- no
subdirectory restriction, no separate service, at the cost of API tokens.

What's still live and worth keeping regardless of this feature's fate:
qadpt's build/deploy pipeline (reusable for any future Ghost source
patch) and the webfinger self-probe patch itself (harmless, fail-safe,
deployed and verified).
