we want to install an instance of ghost on a VM (the one with tags app:ghost-classic and Name:appserver). it should:

- the instance should not be publicly accessible. we use ssm connect instead of ssh
- use https://docs.ghost.org/install/ubuntu
- serve non-TLS on 8000
- have IMAP configured to send mails as robots@the-well-architected-cloud.com via Proton
- be accessible via Cloudfront under https://the-well-architected-cloud.com/blog

As a result there should be a working blog, plus a phase1.md document describing the infra architecture involved (including VPC endpoints because they're needed for ssm connect) and a cost estimate

----- AI agent updates -------

## Decisions from design/brainstorm session (2026-08-17)

Note: exact AWS resource IDs (instance, VPC, subnet, security group, route table, egress-only gateway, CloudFront distribution, Route53 zone, IAM role, SSM parameter name) live in `.local-secrets.md` (gitignored, not this file) under the "Ghost On A Stick" heading, since this spec is public information. Everything below refers to resources by role/tag instead.

**Instance identified:** the appserver instance (tags app:ghost-classic, Name:appserver; exact instance ID in .local-secrets.md), us-east-1b, t3.micro, fresh Ubuntu 26.04 LTS, no public IP, no NAT gateway. Confirmed nothing installed yet (no Node, no ghost user, no /var/www).

**IPv6 egress (prerequisite, already done in a separate session):** the instance's subnet has an IPv6 /64 (see .local-secrets.md for the CIDR and gateway/route-table IDs), routed to an egress-only internet gateway. This is the outbound internet path for apt/npm/Ghost install and future updates -- chosen over a NAT Gateway to avoid its hourly + per-GB cost, consistent with this project's cost-optimization goal. Risk noted: relies on install-time package sources (Ubuntu archives, NodeSource, npm registry) being IPv6-reachable -- not yet verified end-to-end, to be confirmed during implementation.

**"IMAP configured to send mails via Proton" clarified as SMTP:** Ghost sends transactional mail via SMTP, not IMAP. Decision: use Proton's native SMTP submission (Business/Enterprise plan), not Proton Mail Bridge (which would require a continuously-running local proxy process). Rejected Bridge specifically to avoid that extra long-running dependency on the instance.

**Mail DNS:** Already fully configured in the the-well-architected-cloud.com Route53 zone (zone ID in .local-secrets.md) -- MX (mail.protonmail.ch / mailsec.protonmail.ch), 3x DKIM CNAMEs (protonmail._domainkey, protonmail2._domainkey, protonmail3._domainkey), DMARC (_dmarc, p=quarantine), and a protonmail-verification TXT. No DNS changes needed for mail; document as-is in phase1.md.

**Mail credential:** an SSM Parameter Store SecureString already created by the user (parameter name in .local-secrets.md; named as an IMAP token despite being an SMTP credential -- kept as-is). The instance's IAM role currently only has the AWS-managed SSM core policy attached, which does not grant ssm:GetParameter on arbitrary parameters. Decision: add a scoped inline IAM policy granting ssm:GetParameter + kms:Decrypt limited to this one parameter's ARN (least privilege, not a blanket SSM read policy). All other Ghost secrets (e.g. admin password) stay on-instance only, not stored in AWS -- explicit user decision, out of scope for AWS-side secrets design.

**CloudFront <-> private origin:** Use CloudFront's VPC origin feature (native private connectivity to a resource inside a VPC) pointed directly at the EC2 instance's private IP on port 8000, HTTP (non-TLS) between CloudFront and origin since that path is AWS backbone, not public internet. Viewer-facing TLS still terminates at CloudFront using the existing the-well-architected-cloud.com ACM cert. Rejected: giving the instance an Elastic IP + SG-restricted-to-CloudFront-prefix-list (still nominally public-facing), and an internal ALB in front of the instance (unnecessary extra moving part/cost for a single backend instance).

**CloudFront distribution:** Reuse the existing distribution serving the-well-architected-cloud.com (distribution ID in .local-secrets.md; currently serves the site from an S3 origin at the default/root behavior) rather than creating a new distribution. Add the VM as a second origin and a new /blog* cache behavior. Default (root) behavior and its S3 origin are untouched.

**Caching on /blog*:** Short-TTL caching as a traffic-spike safety net for the t3.micro (cost difference between CachingDisabled and short-TTL is negligible at this traffic scale -- cents/month via VPC-origin data transfer -- the real reason for caching is protecting the small instance from load spikes, not cost). A second, higher-precedence behavior excludes /blog/ghost/* (admin), /blog/members/* (member auth), and Ghost's API/webhook paths from caching (CachingDisabled), so login/admin/webhooks always hit origin live. Rejected: CachingDisabled everywhere under /blog* (simpler but no spike protection) -- explicitly chosen against in favor of the safety net despite the added complexity of the second behavior.

**Ghost admin panel access:** /blog/ghost is reached through the same public CloudFront path as the rest of the blog (protected by Ghost's own login), not via a separate SSM port-forward tunnel. Rejected the SSM-tunnel-only option as unnecessary friction for day-to-day blogging.

**Database:** SQLite instead of MySQL 8 (the official Ubuntu guide's default). Explicit deviation from docs.ghost.org/install/ubuntu's default, chosen due to the instance's 908MB RAM being tight for MySQL + Node/Ghost together. To be called out explicitly as a documented deviation in phase1.md. A swap file will be added regardless, mainly for install-time headroom (build tooling), since steady-state RAM pressure is lower with SQLite than MySQL would have been.

**Ghost URL/subdirectory:** Ghost's `url` config set to https://the-well-architected-cloud.com/blog. Ghost natively supports subdirectory installs; no path-stripping/rewriting needed at CloudFront -- the full /blog/... path is forwarded to origin as-is.

**SSM connectivity gap found:** Only the ssm and ssmmessages VPC interface endpoints exist in the instance's subnet; ec2messages is missing, which is required for interactive `aws ssm start-session` (Run Command, which was used for verification during this session, does not need it). Decision: add the missing ec2messages endpoint as part of this work.

**SG cleanup:** the instance's security group has an existing leftover inbound rule for tcp/8000 from 0.0.0.0/0 (currently harmless only because the instance has no public IP). Decision: replace it with a rule scoped to the CloudFront VPC-origin traffic path only.

**Resource tagging requirement (explicit user instruction):** every new AWS resource created for this work must be tagged app:ghost-classic.

**Sensitive-data handling (explicit user instruction):** this spec is public information. Exact AWS resource IDs and any credential/parameter names go in .local-secrets.md (gitignored) instead of here; this file references them by role/tag and points at .local-secrets.md for the concrete values. Same convention applies to phase1.md when it's written.

**Deliverables confirmed:** phase1.md covering the architecture described above (network/VPC endpoints including the new ec2messages one, CloudFront origin/behavior config, DNS as documented above, IAM scoping) plus an itemized cost estimate (CloudFront requests/data transfer, CloudFront VPC-origin data processing, SSM interface endpoints hourly cost, t3.micro hourly, EBS, Route53 -- explicitly no NAT Gateway line item since that was rejected in favor of the existing IPv6 egress-only path). phase1.md describes resources by role/tag, not exact IDs, per the sensitive-data handling decision above.

### Implementation approach (abstract, not code)

1. Add the missing ec2messages VPC interface endpoint to the VPC/subnet.
2. Tighten the instance's security group inbound rules: remove the 0.0.0.0/0:8000 rule, add a rule scoped to the CloudFront VPC origin's traffic.
3. Add a scoped IAM inline policy to the instance's role for ssm:GetParameter/kms:Decrypt on the mail-credential parameter's ARN only.
4. Via SSM, install Node.js, Ghost-CLI, and Ghost itself per the Ubuntu guide with SQLite as the DB adapter instead of MySQL; add a swap file; configure Ghost's url and mail (SMTP via Proton, credential pulled from Parameter Store at setup time) settings for the /blog subdirectory.
5. Create a CloudFront VPC origin resource pointed at the instance's private IP:8000.
6. Update the existing distribution: add the VM as a second origin, add a /blog* short-TTL cache behavior, and a higher-precedence CachingDisabled behavior for /blog/ghost/*, /blog/members/*, and API/webhook paths.
7. Verify end-to-end: SSM interactive session works, outbound installs succeed over IPv6, blog loads and admin login works through CloudFront, test email send via Ghost through Proton SMTP.
8. Tag every new resource app:ghost-classic.
9. Write phase1.md with architecture description (resources referenced by role/tag, not exact IDs) and itemized cost estimate.


## Implementation findings (2026-08-17, during build)

**CloudFront strips `X-Forwarded-Proto` for custom/VPC origins -- nginx added as a local reverse proxy.** This was not anticipated in the design above. CloudFront removes any viewer-sent `X-Forwarded-Proto` header and does not forward it to custom origins; it also refuses to let a CloudFront Function set that exact header name (confirmed empirically: a CloudFront Function attempt caused a brief `502 FunctionValidationError` outage, immediately reverted). Without this header, Ghost's own HTTPS-canonical-URL enforcement produced an infinite self-redirect loop, since Ghost only ever sees plain HTTP from the VPC origin. A CloudFront custom origin header for the same purpose was also tried and confirmed (via packet capture on the instance) to not be forwarded for a VPC origin -- an undocumented gap versus regular custom origins. A working Lambda@Edge origin-request fix was built (IAM role + function, since Lambda@Edge is allowed to set this header) but not deployed; nginx was chosen instead, on user preference, once suggested as an alternative. Decision: nginx runs as a local reverse proxy on the instance -- nginx listens on `0.0.0.0:8000` (preserving "serve on 8000" as CloudFront/the outside world sees it) and proxies to Ghost, which now listens only on `127.0.0.1:2368`; nginx injects `X-Forwarded-Proto: https` on the way through, which Ghost already trusts (Express's standard proxy-protocol header). This is an explicit deviation from the earlier "no nginx" design decision, made necessary by the CloudFront limitation above, not a change of the underlying feature. The Lambda@Edge function and its IAM role were deleted after nginx was confirmed working, to avoid leaving unused resources around.

**Ghost's own `server.host` default (127.0.0.1) also had to be overridden.** Ghost-CLI's install defaults to binding the app to loopback only; this had to be set explicitly (first to `0.0.0.0`, later to `127.0.0.1` once nginx took over the public-facing `0.0.0.0:8000` binding) for the VPC origin/nginx to reach it at all.

**Ghost-CLI's automated `setup` steps for `linux-user` and `systemd` could not be used as designed.** Ghost-CLI refuses to run its install/setup commands as the root user, and its `linux-user`/`systemd` setup stages shell out to `sudo` internally, which requires a password for a non-root admin account -- granting that account passwordless sudo was declined (blocked by the coding agent's own safety classifier, correctly, since it's a real standing privilege escalation). Resolved by directly replicating, as root (already legitimately held via the SSM session), the exact same operations Ghost-CLI's own source shows those stages perform: create an unprivileged system user for running Ghost, hand it ownership of the content directory, and write/enable the systemd unit from Ghost-CLI's own template. No new persistent privilege was granted to do this.

**Native module compilation needed extra toolchain setup not covered by the base Ubuntu image.** `sqlite3`/`re2` (Ghost dependencies) had no prebuilt binaries for this platform and had to compile from source, requiring `build-essential`/`python3-dev`/`libsqlite3-dev` to be installed first, and further required an older compiler (`gcc-12`/`g++-12`) than the image's default `gcc-15`, whose stricter header-usage enforcement broke the vendored `re2` C++ source. `ghost setup`'s own memory-availability and OS-stack-compatibility prompts also had to be explicitly disabled (`--no-check-mem --no-stack --auto`) since they're interactive-only and this is a low-RAM (908MB) instance.

**Mail credential handling in practice:** the SMTP token is fetched from Parameter Store and written into Ghost's config via a short Python script fed the token only through an environment variable, specifically to avoid it ever appearing as a process argument (visible via `ps`) or in command history -- an implementation detail, not a design change.


## Superseding decision: IPv6-only egress replaced with a public IPv4 (2026-08-17, during verification)

**The IPv6 egress-only-gateway path (an earlier decision, from a prior session, described above) turned out to be unusable for mail and has been fully removed.** Discovered during end-to-end verification: Proton's SMTP submission host (`smtp.protonmail.ch`) has no IPv6 (AAAA) DNS record -- IPv4-only. A pivot to Amazon SES as an alternative mail provider was considered and rejected: SES's SMTP endpoints and its plain HTTPS API endpoint are also IPv4-only, so switching providers would not have avoided the underlying problem. Every viable outbound mail path needs IPv4 egress; there is no IPv6-only route to any of them.

**Decision: give the instance a public IPv4 address (Elastic IP) instead of NAT Gateway or a NAT instance.** Explicit user choice, reasoning: inbound is already fully restricted (SG only allows :8000 from CloudFront's own VPC-origin service SG, plus AWS API access via the SSM VPC interface endpoints) regardless of whether the instance has a public IP, so an EIP doesn't meaningfully change the "not publicly accessible" posture for anything except outbound-initiated traffic -- and it's simpler and cheaper than a NAT Gateway (no separate NAT resource, no NAT Gateway hourly charge) or a self-managed NAT instance (no second box to patch/monitor). The subnet already had a route to an Internet Gateway from before this project (`0.0.0.0/0 -> igw`); only the instance lacked a public IP to use it.

**Removed:** the egress-only internet gateway, its `::/0` route, and the instance's own IPv6 address. The subnet's IPv6 `/64` CIDR association itself could not be fully torn down -- CloudFront's own VPC-origin service-managed ENI (a resource CloudFront creates and owns for the working origin connection) still holds an address from that block, and removing it would require disrupting/recreating the VPC origin. The CIDR association is left in place but is now inert (no route, no gateway associated with it).

**Added:** an Elastic IP associated with the instance; SG egress rules for tcp/587 (SMTP submission) and tcp/80 over IPv4 (the existing tcp/443 and tcp/80 IPv6-only egress rules from the earlier session already covered HTTPS; 587 had no egress rule at all before this).

**Verified:** SMTP AUTH against `smtp.protonmail.ch:587` succeeds from the instance using the real Parameter Store credential (connection + STARTTLS + login, no message actually sent since no target recipient was specified). The blog continued to resolve correctly through CloudFront throughout this change, since CloudFront reaches the instance via its private IP (VPC origin), unaffected by the public IP change.
