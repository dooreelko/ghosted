Deploy TryGhost/ActivityPub (the standalone ActivityPub server project, not
bundled with self-hosted Ghost core) alongside the existing Ghost instance,
so Social Web (moth syigu) can actually work.

Trigger: confirmed on the instance that self-hosted Ghost 6.57.1 has no
local ActivityPub server at all -- no systemd unit, no installed package,
nothing listening on a second port. ghost/core's own activity-pub-service.ts
only manages webhooks pointing at `.ghost/activitypub/v1/...`, which is
Ghost(Pro)'s managed cloud infrastructure, not something self-hosted
installs get for free. The webfinger self-probe patch (moth qadpt) and
its build pipeline are still correct and needed -- they're just not
sufficient on their own; there's genuinely no server behind the endpoint
they're checking for, yet.

Scope (to research/spec/plan properly, not decided yet):
- What TryGhost/ActivityPub actually needs to run: its own process, port,
  likely its own SQLite DB (separate from Ghost's), config linking it to
  this Ghost install.
- How it fits this instance's constraints: 1GB RAM t3.micro (already
  needed a swap file for Ghost alone -- a second Node service is a real
  resource question), SSM-only management (no SSH), CloudFront-fronted
  (new routes needed for whatever paths this service needs at the domain
  root, on top of what qadpt/syigu already identified for webfinger/
  nodeinfo).
- Whether/how it needs a systemd unit, following the same pattern as the
  existing ghost_the-well-architected-cloud-com.service.
- Depends on qadpt (build/deploy tooling, already exists and is reusable)
  and blocks syigu (Social Web can't actually work without this).


## Shelved 2026-08-28

Researched TryGhost/ActivityPub's actual architecture before spec'ing
further: it's genuinely Ghost(Pro)'s own multi-tenant SaaS backend for the
fediverse (their own ADRs describe it as "our multitenant ActivityPub
service", built around self-DDoS/NAT-exhaustion concerns that only exist
at many-thousand-tenant scale), requires MySQL + Google PubSub + Jaeger in
its dev stack, no official self-hosting requirements published, community
estimate 4-8GB RAM / 2-4 vCPUs for production, and its own event-driven
federation architecture (ADR-0013) is still `Proposed`, not `Approved` --
actively under internal refactoring.

Running this for one personal blog means running a slice of someone else's
SaaS backend, sized and operated for their scale, mid-refactor. User
decided this isn't worth it. Shelved, not deleted -- the research here
stands if priorities change. Social Web itself (moth syigu) shelved
alongside it.
