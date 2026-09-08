# Phase 2 Docker image + IaC design (moth hnj9a)

Full technical design for adapting Ghost's Docker image to carry the
S3-backed-SQLite integration, and standing up the Lightsail/S3/IAM/ECR
infra to run it. The moth ticket (`hnj9a`) stays the decision record;
this doc carries the technical detail that would otherwise bloat it.

## Docker image: two-stage build

Ghost's own upstream `Dockerfile.production` (pulled in via the `main`
fast-forward in moth yofwh) is a solid multi-stage build with a `full`
target (server + built admin UI) we build on rather than fork.

**Stage A — Ghost's own image, unmodified.** Build admin first
(`pnpm nx run @tryghost/admin:build` inside the `Ghost/` checkout, on
`fork_main`), then:
```
docker build -f Ghost/Dockerfile.production --target full Ghost/
```
Zero diff to Ghost's Dockerfile or source — matches the "never patch
Ghost" principle from yofwh.

**Stage B — our launcher layer.** New `phase2/docker/Dockerfile`:
`FROM` stage A's tag, `COPY` in `phase2/packages/{sqlite-s3,ghost-sqlite-s3-launcher}`,
`npm install` inside the launcher dir (resolves the sqlite-s3 git
dependency — needs that commit already pushed to `origin`, which it
always will be by the time this runs), override `CMD` to
`node --import=<launcher>/src/preload.mjs index.js`. No `tsx`/`--conditions=source`
needed here — production build is already compiled, unlike the smoke
test's dev-mode invocation.

## Launcher: two new responsibilities

`ghost-sqlite-s3-launcher`'s preload (previously DB-wiring only, per
yofwh) grows two more jobs, in the same file/process — approved
explicitly over splitting into separate preloads, since both need the
same AssumeRole'd credentials and boot-time-config shape:

**Credentials.** Lightsail auto-injects credentials for a role in an
AWS-managed backend account with no access to our resources. Wrap the
container's ambient default credential chain with
`fromTemporaryCredentials({ params: { RoleArn: process.env.AWS_ROLE_ARN } })`
from `@aws-sdk/credential-providers`, used to construct both the S3
client and the SSM client below. This returns a credential *provider
function* the SDK calls lazily per request — auto-refreshes near the
~1hr expiry, no cron/entrypoint needed.

**Mail.** Fetch the existing Proton SMTP credential (SSM SecureString
param, name defaults to `ghost_imap_token` — the same one phase1/jpjiy
already uses; reused rather than duplicated) via the AssumeRole'd SSM
client, set Ghost's `mail` config alongside the existing DB config.

New env vars: `AWS_ROLE_ARN`, `GHOST_URL` (real production url — wired
now per explicit decision, see moth ticket), `MAIL_SSM_PARAM_NAME`
(default `ghost_imap_token`).

## IAM: two independent roles, don't conflate them

**1. App runtime role** (`phase2/iac/iam.tf`) — what the launcher's
`AWS_ROLE_ARN` above assumes. Trust policy: Principal is the Lightsail
container service's own principal ARN (one per service, shared by
every container/replica in it — a live Tofu resource reference, never
hardcoded). **No `sts:ExternalId`** — this exact no-ExternalId config
was *not* the one verified working in phase2/readme.md's hands-on
testing (that session used an ExternalId); if `tofu apply` shows this
doesn't work, add ExternalId back rather than treating it as settled.
Permissions: S3 CRUD on the new bucket; `ssm:GetParameter` +
`kms:Decrypt` scoped to the one mail-credential param's ARN.

**2. ECR image puller role** — a completely separate, Lightsail-managed
role, unrelated to the app runtime role above. Activated per-service
(`private-registry-access ecrImagePullerRole={isActive=true}` on
`update-container-service`, or the Tofu resource's equivalent block if
the AWS provider exposes it — verify at implementation time, fall back
to a CLI step / `local-exec` if not). Its principal ARN gets a grant on
the ECR repo (`ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`) via an
ECR repository policy. This role only lets Lightsail's control plane
pull the image; it has nothing to do with anything the running app
does.

## Registry: private ECR, not Lightsail's own push mechanism

Lightsail Container Service deployments only accept two image source
shapes: `:service.label.version` (Lightsail's own internal registry,
populated via `aws lightsail push-container-image`) or a plain
unauthenticated public-registry ref (`nginx:latest`-style). Private ECR
access is a *third*, distinct mechanism (see IAM section above) that
was initially missed and corrected mid-design — not a variant of
either of the other two.

Chosen: **private ECR**, same account/region as everything else, image
referenced as `<account>.dkr.ecr.us-east-1.amazonaws.com/<repo>:<tag>`.
Rejected: Lightsail's own push registry (works, but ties the image
purely to Lightsail with no reuse path if compute ever changes).
Rejected: public ECR (would've avoided the ECR-puller-role plumbing
entirely, but makes the built image publicly pullable by anyone with
the URI — not acceptable even though no secrets are baked in).
Image-size cost concern (ECR is $0.10/GB-month) is a non-issue either
way — a Ghost production image runs in the few-hundred-MB range,
nowhere near a size where this matters.

## OpenTofu layout

`phase2/iac/`, flat local state (`terraform.tfstate`, gitignored — add
to `.gitignore`), one file per component per the phase2/readme.md
decision:
- `providers.tf` — AWS provider, region `us-east-1`.
- `s3.tf` — the bucket (SQLite segments/manifest + Ghost's S3 image
  storage, same bucket per phase2/readme.md), tagged `app:ghost-phase2`.
- `ecr.tf` — the private repository.
- `iam.tf` — the app runtime role (above), and whatever the ECR-puller
  activation needs (Tofu resource if the provider supports it, else a
  documented manual/CLI step run alongside `tofu apply`).
- `lightsail.tf` — the container service (Micro tier, 1 node) and its
  deployment, referencing the ECR image URI.

All new resources tagged `app:ghost-phase2` (distinct from phase1's
`app:ghost-classic`, since this is genuinely different infra even
though it's the same logical blog).

## Sequencing (apply flow)

Chicken-and-egg note: the container service's principal ARN (needed
for the app runtime role's trust policy) only exists once the service
itself exists, and the ECR repo policy needs the ECR-puller role's
principal ARN, which only exists once *that's* activated on the
service. Concretely, in dependency order:

1. `tofu apply` creates: S3 bucket, ECR repo, Lightsail container
   service (no deployment yet — a service can exist without one),
   app runtime IAM role (trust policy referencing the service's
   principal ARN via Tofu resource reference, not hardcoded).
2. Activate the ECR image puller role on the service (Tofu resource or
   CLI step, per the IAM section above) and grant its principal ARN on
   the ECR repo policy (Tofu resource, `aws_ecr_repository_policy`, or
   `aws ecr set-repository-policy`).
3. Build the Docker image (two-stage, above), tag and
   `docker push` to the ECR repo.
4. Create the container service deployment (Tofu `aws_lightsail_container_service_deployment_version`
   or `aws lightsail create-container-service-deployment`), referencing
   the pushed image tag, with the env vars from the Launcher section
   set to this apply's real values (`AWS_ROLE_ARN` from step 1's role,
   `SQLITE_S3_BUCKET`/`SQLITE_S3_REGION` from step 1's bucket,
   `GHOST_URL`, `MAIL_SSM_PARAM_NAME`).

Exact Tofu-resource-vs-CLI-step split for steps 2 and 4 is an
implementation-time detail (provider version dependent) — the plan
written from this doc verifies it rather than assuming.

## Explicitly out of scope for hnj9a

Per hi3zi's task split (see moth i8hlt): no CloudFront/DNS traffic
cutover, no content/DB migration from the phase1 VM. This produces a
real, fully-configured (real url, real mail) Lightsail deployment that
nothing points real traffic at yet — i8hlt owns turning that into the
live site (and building the automated get-latest/package/deploy/test/
rollback cycle around it).
