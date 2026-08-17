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
