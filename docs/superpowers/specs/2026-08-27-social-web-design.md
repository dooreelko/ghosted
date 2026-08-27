# Social Web (ActivityPub + Bridgy Fed) — Design

Moth task: `syigu` (Social Web)

## Goal

New posts on the Ghost blog (`https://the-well-architected-cloud.com/blog`)
automatically become visible to followers on Mastodon and Bluesky, with no
manual crossposting step and no new secrets to manage.

## Approach

Use Ghost 6's built-in ActivityPub / "Social Web" feature (Settings →
Network → "Distribute posts to the social web") rather than a custom
webhook-driven crossposter. This gives the site a new ActivityPub actor
(`@index@the-well-architected-cloud.com`) that:

- Mastodon (and any ActivityPub-compatible server) can follow directly.
- Bluesky can follow via Bridgy Fed's bridge, surfacing the site as
  `@the-well-architected-cloud.com.ap.brid.gy` on Bluesky.

Publishing a post is unchanged — no new publish-time action, no API tokens,
no polling job. This was chosen over a custom crossposter (which would post
under the existing `@sascha_fedorenko@hachyderm.io` / `bsky.social` handles)
because it needs zero application code and zero secrets, at the cost of
posts appearing under a new site identity rather than the existing personal
accounts. Linking the existing accounts to the new identity (follow/boost)
is explicitly **out of scope** — manual follow-up, not part of this task.

## Components touched

### CloudFront

Three ActivityPub-related paths must reach the Ghost origin, using the same
caching-disabled / `AllViewer` treatment as the existing `/blog/ghost/*` and
`/blog/members/*` behaviors:

- `/blog/.ghost/activitypub/*`
- `/blog/.well-known/webfinger`
- `/blog/.well-known/nodeinfo`

**Open question to resolve during implementation:** ActivityPub actor
discovery (webfinger/nodeinfo) is conventionally rooted at the domain root
(`/.well-known/...`), not scoped under `/blog`. Since CloudFront's *default*
behavior already serves the existing static site from S3 at the root, root-level
`/.well-known/webfinger` and `/.well-known/nodeinfo` requests need dedicated
CloudFront behaviors carved out ahead of the default S3 behavior, routed to
the same VPC origin as the rest of `/blog/*`. Confirm the exact host/path
Ghost's ActivityPub actor expects (root vs. `/blog`-scoped) before adding
behaviors — check Ghost admin's Social Web panel output and/or
`ghost.the-well-architected-cloud.com`-style config once "Distribute posts
to the social web" is enabled.

### nginx (on-instance)

New `location` blocks proxying the same three paths to the local
ActivityPub service, forwarding `X-Forwarded-For`, `X-Forwarded-Proto`, and
`Host`, matching the existing pattern used for the main Ghost proxy.
Confirm the ActivityPub service's actual local port via `ghost start`
output on the instance (commonly `2369` alongside Ghost's own `2368`, per
self-hosted Ghost 6 documentation, but not yet verified against this specific
install).

### Ghost admin config

Enable Settings → Network → "Distribute posts to the social web". Confirm
the resulting actor handle and site domain match expectations.

### Bridgy Fed

One-time opt-in on the Bluesky side to bridge `@the-well-architected-cloud.com`
into Bluesky as `@the-well-architected-cloud.com.ap.brid.gy`. No Ghost-side
credential involved.

## Security

No security group changes — CloudFront already fronts the domain publicly;
this only adds cache behaviors on the existing CloudFront → VPC-origin →
nginx → Ghost path. No new secrets: per this repo's `.local-secrets.md`
convention, nothing here requires a credential, since there's no
Mastodon/Bluesky API token in this design.

## Testing

1. `curl https://the-well-architected-cloud.com/.well-known/webfinger?resource=acct:index@the-well-architected-cloud.com`
   resolves the actor.
2. From a Mastodon account, search for and follow the site's actor; confirm
   a newly published post appears in that account's timeline.
3. Confirm Bridgy Fed bridging surfaces the same post on Bluesky.

## Out of scope

- Linking/cross-following the existing `@sascha_fedorenko@hachyderm.io` and
  `bsky.social` accounts to the new `@index@...` identity.
- Any custom crossposting code, API credentials, or polling job.
