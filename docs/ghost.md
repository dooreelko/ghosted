# Ghost: deployed systems and endpoints

Living reference for everything currently running for the Ghost blog, kept
accurate as the architecture evolves — written to support future
architectural decomposition work, not as a one-time snapshot. Exact AWS
resource IDs are intentionally omitted (public repo); see `.local-secrets.md`
for those, referenced here by role/name.

## Systems

| System | What | Where |
|---|---|---|
| EC2 instance | Single `t3.micro`, Ubuntu 26.04, no public inbound except via CloudFront's VPC origin | tagged `app:ghost-classic` / `Name:appserver` |
| Ghost | Stock Ghost-CLI npm install — see below | `/var/www/ghost`, managed by Ghost-CLI |
| nginx | Local reverse proxy, `:8000 → 127.0.0.1:2368` | systemd, config at `/etc/nginx/sites-enabled/` |
| SQLite | Ghost's database (posts, members, settings) | `/var/www/ghost/content/data/` |
| CloudFront | Public entry point for the whole domain (blog + pre-existing static site) | one distribution, two origins |
| S3 | Existing static site (default/root CloudFront behavior) | pre-existing, not part of the Ghost work |
| SSM Session Manager | **Only** management path to the instance — no SSH, no bastion, no public IP for admin | `aws ssm start-session` / `scripts/ssm-*.sh` |
| Elastic IP | Instance's outbound path (Proton SMTP + SSM control-plane are both IPv4-only) | see `phase1.md` "Design deviations" |

## Ghost build

Instance runs **stock Ghost from the npm registry**, deployed via
ghost-cli's own `ghost update --force`
(`scripts/ssm-switch-to-mainstream-ghost.sh`). Deployed version as of this
writing: `6.62.0`.

Previously (2026-08-28 to 2026-09-03) the instance ran a custom fork build
(`dooreelko/Ghost`, this repo's `Ghost/` submodule) carrying a local
webfinger self-probe patch, built and deployed per moth `qadpt`. That patch
was for `syigu` (Social Web); the plan changed and `syigu` will not use the
custom build, so the instance was switched back to stock via
`scripts/ssm-switch-to-mainstream-ghost.sh` on 2026-09-03. Ghost-CLI's
update pruned the old `6.57.1-local.2` version dir during the switch — the
only way back to the custom build now is a fresh rebuild from the fork, or
the pre-switch instance backup in `.instance-backups/`. The fork submodule
and build scripts (`scripts/ssm-deploy-ghost-update.sh`,
`scripts/ssm-copy-admin-build.sh`) are unused going forward unless a future
patch need reopens moth `qadpt`.

## nginx — actual config (verified live 2026-08-28)

```nginx
server {
    listen 8000;
    listen [::]:8000;
    server_name _;
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:2368;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

**Catch-all** — `server_name _`, single `location /`. Every request
CloudFront forwards to this origin, on any path, reaches Ghost on 2368
unmodified. This means new CloudFront path patterns pointed at this origin
need **no nginx change** — routing is entirely CloudFront's job. (This
surprised an earlier planning pass, which assumed nginx would need new
`location` blocks for ActivityPub paths — it doesn't, given this config.)

## CloudFront — actual cache behaviors (verified live 2026-08-28)

One distribution serves the whole domain. Default (root) behavior → S3
(pre-existing static site). Four behaviors route `/blog` traffic to the
Ghost origin, evaluated in this priority order:

| Path pattern | Purpose | Cache policy | Origin request policy |
|---|---|---|---|
| `/blog/ghost/*` | Ghost admin | managed `CachingDisabled` | managed `AllViewer` |
| `/blog/members/*` | Member auth | managed `CachingDisabled` | managed `AllViewer` |
| `/blog/*` | Public pages | custom `ghost-classic-blog-short-ttl` (60s) | managed `AllViewer` |
| `/blog` (exact) | Same as above — CloudFront treats `/blog` and `/blog/*` as distinct patterns | custom `ghost-classic-blog-short-ttl` (60s) | managed `AllViewer` |

All four target the same VPC origin (the EC2 instance, private-backbone
connection, HTTP to nginx's `:8000`). TLS terminates at CloudFront using
the domain's existing ACM cert; CloudFront↔origin is plain HTTP (justified
— private VPC-origin link, never exposed to the internet).

**Not yet routed:** `/.well-known/webfinger`, `/.well-known/nodeinfo`, and
whatever paths `gfoig` (self-hosted ActivityPub server) ends up needing —
these must live at the **domain root**, which currently falls through to
the default (S3) behavior. Adding them is the remaining infra work for
`syigu` (Social Web), blocked on `gfoig`.

## Endpoints reachable today

| URL | Serves |
|---|---|
| `https://the-well-architected-cloud.com/` | S3 static site (unrelated to Ghost) |
| `https://the-well-architected-cloud.com/blog/` | Ghost public blog |
| `https://the-well-architected-cloud.com/blog/ghost/` | Ghost admin |
| `https://the-well-architected-cloud.com/blog/members/*` | Ghost member auth |

## Known gaps / in-progress

- `syigu` (Social Web): probe patch deployed and correctly fail-safe (no
  route to check yet), blocked on `gfoig`.
- `gfoig` (TryGhost ActivityPub self-hosted server): not started. Self-hosted
  Ghost has **no local ActivityPub server at all** — `ghost/core`'s
  `activity-pub-service.ts` only talks to `.ghost/activitypub/v1/...`, which
  is Ghost(Pro)'s managed cloud infrastructure, not something self-hosted
  installs get automatically.
- Considered, not yet designed: an S3 bucket for large instance file
  transfers (current chunked-over-SSM approach in `scripts/ssm-scp.sh` works
  but is slow for anything much bigger than a few MB — needs an IAM change).
