# Phase 1: Ghost on a VM

A single EC2 instance running [Ghost](https://ghost.org/) natively (no containers), reachable only through CloudFront, administered only through SSM — no SSH, no public IP exposed for management, no bastion.

Exact AWS resource IDs are intentionally omitted from this document (it's tracked in a public repo); resources are referenced by role, name, or tag instead.

## Architecture

```
                          ┌─────────────────────────────┐
viewer ──HTTPS──▶  CloudFront distribution               │
                   (the-well-architected-cloud.com)       │
                   ├─ default behavior ──▶ S3 (existing site)
                   ├─ /blog/ghost/*  ──┐                  │
                   ├─ /blog/members/*──┼─▶ VPC origin ─────┼──HTTP:8000──▶ nginx ──▶ Ghost (127.0.0.1:2368)
                   ├─ /blog*          ─┘   (private link)  │              (adds X-Forwarded-Proto: https)
                   └─ /blog (exact)  ──────┘               │
                          └─────────────────────────────┘
                                                             VPC (private subnet, no inbound from the internet)
                                                             ├─ Elastic IP (permanent; carries both outbound SMTP
                                                             │  to Proton and SSM's control-plane traffic)
                                                             └─ Security group: inbound :8000 only from
                                                                CloudFront's VPC-origin service SG;
                                                                no other inbound rule
```

### Compute

A single `t3.micro` instance, Ubuntu 26.04 LTS, running:

- **Ghost 6.x**, installed via Ghost-CLI, using **SQLite** instead of the officially-recommended MySQL (deviation from `docs.ghost.org/install/ubuntu`'s default, made to fit the instance's 1GB RAM without an extra database process). A 1GB swap file was added for install-time headroom.
- **nginx**, as a local reverse proxy in front of Ghost (`0.0.0.0:8000 → 127.0.0.1:2368`). This wasn't part of the original design — it exists specifically because CloudFront strips/reserves the `X-Forwarded-Proto` header for custom and VPC origins (confirmed by packet capture; also confirmed CloudFront Functions are explicitly disallowed from setting that header), so without a local proxy Ghost couldn't tell it was being served over HTTPS and looped on its own canonical-URL redirect. nginx injects the header itself.
- Ghost itself runs as a dedicated, unprivileged system user under `systemd` (`Restart=always`), separate from the sudo-capable admin account used for installation.

### Network access (no SSH)

- The instance has **no SSH access at all** — management is exclusively via `aws ssm start-session`, over the public internet (see below) rather than via SSM VPC interface endpoints.
- The instance's security group allows inbound `:8000` **only** from CloudFront's own service-managed security group (auto-created when the CloudFront VPC origin was set up) — not from `0.0.0.0/0`. There is no other inbound rule.
- The instance has an **Elastic IP**, which carries all outbound traffic: SMTP to Proton, and SSM's control-plane traffic. This wasn't the original plan (see "Design deviations" below) — it was added because Proton's SMTP host, like every mail provider's SMTP/API endpoint checked including Amazon SES, is IPv4-only. Once it existed, it made SSM VPC interface endpoints redundant, since SSM traffic can use the same standing public route instead of a separate private-backbone-only path — so those endpoints were removed and won't be recreated as long as this Elastic IP stays attached. Inbound exposure is unaffected by any of this, since it's governed entirely by the security group, not by whether the instance is addressable.

### CloudFront

- The blog is added to the **existing** CloudFront distribution for `the-well-architected-cloud.com` (which already served the static site from S3 at the root) rather than a new distribution — one cert, one DNS record, one place to look.
- The instance is wired up as a second **origin** using CloudFront's **VPC origin** feature: CloudFront reaches the instance over AWS's private backbone, never the public internet, using the instance's private IP. No load balancer in front of it — direct to the instance.
- Four cache behaviors route `/blog` traffic to the new origin, evaluated in this order:
  1. `/blog/ghost/*` — admin — **caching disabled**
  2. `/blog/members/*` — member auth — **caching disabled**
  3. `/blog/*` — public pages — **60-second TTL** (a deliberate, cheap safety net against a traffic spike overwhelming the small instance; the cost difference between this and no caching at all is negligible at this traffic scale)
  4. `/blog` (exact, no trailing slash) — same short-TTL treatment as #3, needed because CloudFront path patterns don't treat `/blog` and `/blog/*` as equivalent
- All four use the `AllViewer` managed origin request policy (forwards all headers/cookies/query strings to the origin) so Ghost's admin/member/API behavior works correctly.
- TLS terminates at CloudFront using the domain's existing ACM certificate; the CloudFront↔origin hop is plain HTTP (justified — it's a private VPC-origin connection, not exposed to the internet).

### Mail

- Ghost sends transactional/member email via **Proton's native SMTP submission** (not Proton Mail Bridge, which would require a second always-running process on the instance).
- The domain's mail DNS (MX, three DKIM CNAMEs, DMARC, Proton verification TXT) was already fully configured in Route53 before this project — nothing new was added there.
- The SMTP credential lives in **SSM Parameter Store** as a `SecureString`; the instance's IAM role has a narrowly-scoped inline policy granting `ssm:GetParameter` + `kms:Decrypt` on that one parameter's ARN only (not a blanket Parameter Store read policy). The credential is injected into Ghost's config via a short script that only ever holds it in an environment variable, never as a process argument or in a log.

### Secrets handling (repo-wide convention, not specific to this document)

Since this repository is public, no AWS resource ID, credential name, or account ID appears in tracked files (including this one). They're kept in a gitignored `.local-secrets.md` at the repo root instead, referenced by the tasks that need them.

## Design deviations from the original brief

Two decisions changed mid-implementation, once real constraints surfaced that weren't visible during planning:

1. **nginx was added**, reversing an earlier "no reverse proxy" decision, because CloudFront's handling of `X-Forwarded-Proto` for VPC/custom origins made a direct CloudFront→Ghost connection produce an infinite redirect loop. A Lambda@Edge function was also built as an alternative fix (Lambda@Edge, unlike CloudFront Functions, is allowed to set that header) but wasn't kept, in favor of nginx.
2. **The instance gained a public IPv4 address (Elastic IP)**, reversing an earlier IPv6-only-egress design (which used a free egress-only internet gateway to avoid NAT Gateway costs). That path turned out to be a dead end: Proton's SMTP host has no IPv6 DNS record, and neither does Amazon SES's SMTP or HTTPS API (checked as an alternative) — every viable mail path needs IPv4. Since inbound exposure is governed entirely by the security group (already locked to CloudFront-only on :8000, nothing else open) regardless of whether the instance is publicly addressable, a plain Elastic IP was simpler and cheaper than a NAT Gateway or a self-managed NAT instance.
3. **The three SSM VPC interface endpoints (`ssm`, `ssmmessages`, `ec2messages`), used during the build, were removed once the instance was fully installed and verified working.** The Elastic IP added in (2) is a permanent, standing part of this architecture (required for as long as Proton SMTP is used), so it gives SSM a permanent public egress path — the endpoints' original justification ("no other route to the internet exists") no longer holds and isn't coming back on its own. SSM control-plane traffic (Session Manager and Run Command) now travels the same public IPv4 path as outbound SMTP, still over TLS, instead of AWS's private backbone. This is a real security-posture trade (private-backbone isolation vs. ~$21.90/month), not a free optimization. Explicit decision: these endpoints will not be recreated as long as the instance keeps this Elastic IP; they'd only come back with a deliberate future decision to reintroduce private-backbone-only SSM isolation.

## Cost estimate (us-east-1, approximate, low-traffic personal blog)

| Item | Monthly estimate | Notes |
|---|---|---|
| EC2 `t3.micro` | ~$7.60 | On-demand, 730 hrs/month |
| EBS root volume (~28GB gp3) | ~$2.25 | Baseline IOPS/throughput included |
| Elastic IP | ~$3.65 | AWS charges for all public IPv4 addresses now, attached or not |
| CloudFront (requests + data transfer) | ~$1–5 | Highly traffic-dependent; a personal blog is nowhere near CloudFront's free tier limits in practice |
| CloudFront VPC-origin data processing | ~$1 or less | Small at this traffic volume |
| Route53 hosted zone | (pre-existing, not incremental) | The zone already existed for the domain before this project |
| ~~NAT Gateway~~ | $0 | Deliberately avoided (see Design deviations) |
| ~~SSM VPC interface endpoints~~ | $0 | Not part of the running architecture (see "Design deviations") — SSM uses the standing public IPv4 route instead. Would cost ~$21.90/mo (×3, ~$0.01/hr each) if ever reintroduced for private-backbone isolation. |
| **Total (new, incremental)** | **~$15–19/month** | |

EC2 compute is the largest recurring line item. There is no ongoing SSM VPC endpoint cost — that infrastructure isn't part of this architecture anymore, and won't be recreated on its own as long as the Elastic IP stays attached.

### Further cost optimization potential (not implemented)

EC2 compute (~$7.60/mo) is the only line item either of these applies to — EBS, the Elastic IP, and CloudFront are all usage-based with no reservation or architecture-family discount available.

- **Graviton (`t4g.micro` instead of `t3.micro`):** ARM pricing is roughly 19% cheaper (~$0.0084/hr vs. ~$0.0104/hr), saving about **$1.40/mo**. Requires reinstalling Node.js/Ghost natively for arm64 — the native-module toolchain issues hit during the original install (`sqlite3`/`re2` compiling from source, GCC version pinning) would need to be re-solved on ARM. Real migration effort for a modest dollar saving.
- **Savings Plans / Reserved Instances:** since only the $7.60/mo compute line is eligible, the ceiling on savings is small in absolute terms even though the percentage discount is real — roughly **$2/mo (1-yr No Upfront, ~28% off)** up to **~$4/mo (3-yr All Upfront, ~50-60% off)**. That requires a 1-3 year commitment on a single low-stakes personal-blog instance, trading away the flexibility to resize or terminate freely.

Neither is currently worth pursuing given the small absolute savings relative to the commitment/effort involved — noted here for reference if the calculus changes (e.g. if the instance size or traffic grows).
