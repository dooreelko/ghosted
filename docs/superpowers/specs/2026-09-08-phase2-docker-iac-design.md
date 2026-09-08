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

## Launcher: three new responsibilities

`ghost-sqlite-s3-launcher`'s preload (previously DB-wiring only, per
yofwh) grows three more jobs, in the same file/process:

**Credentials — corrected mid-design.** The original plan (wrap the
container's ambient credentials with `fromTemporaryCredentials` from
`@aws-sdk/credential-providers`, pass that provider into each client we
construct) only covers clients *we* construct — it doesn't reach
Ghost's own internally-constructed `S3Client` inside its `S3Storage`
adapter (see Image storage below), which only accepts static
`accessKeyId`/`secretAccessKey`/`sessionToken` strings or falls back to
the ambient chain. Resolving the provider once at boot and handing
S3Storage static strings would go stale after ~1hr with no refresh,
silently breaking image uploads on a long-running site.

Corrected approach: at the very top of the preload, before any other
import touches AWS, write an AWS CLI `credential_process` profile
(`~/.aws/config`, or `AWS_CONFIG_FILE` pointed at a container-local
path) whose `credential_process` command is a small helper script
(new file, `<launcher>/src/assume-role-credential-process.mjs`) that
calls `sts:AssumeRole` using the container's own ambient default
credentials and prints AWS CLI's standard JSON credential shape
(`AccessKeyId`/`SecretAccessKey`/`SessionToken`/`Expiration`) to
stdout. Set `AWS_SDK_LOAD_CONFIG=1` and `AWS_PROFILE` to that profile's
name. Every S3/SSM client anyone constructs from that point on —
sqlite-s3's own, S3Storage's internal one, our SSM read below —
resolves credentials through the same ambient chain and independently
re-invokes the helper script as its own cached token nears expiry. One
mechanism, no per-client wiring, covers code we don't control the
construction of.

**Mail.** Fetch the existing Proton SMTP credential (SSM SecureString
param, name defaults to `ghost_imap_token` — the same one phase1/jpjiy
already uses; reused rather than duplicated), set Ghost's `mail` config
alongside the existing DB config.

**Image storage — added, was missing from the first pass of this doc.**
phase2/readme.md already decided images live in the same S3 bucket as
the SQLite data; this preload is where that actually gets wired, via
`config.set('storage', { active: 'S3Storage', S3Storage: {...} })`
(Ghost's adapter-manager config shape — `active` names the adapter
class, per-adapter config sits under a key matching that class name).
Required `S3Storage` fields: `bucket` (same `SQLITE_S3_BUCKET`),
`region` (same `SQLITE_S3_REGION`), `staticFileURLPrefix` (`content/images`,
Ghost's own default), `cdnUrl`, `multipartUploadThresholdBytes`,
`multipartChunkSizeBytes` (>= 5 MiB — use Ghost's own defaults, `zod`
requires an integer but doesn't set one, need to check `ghost-storage-base`/
Ghost's own default config for the conventional value at implementation
time). No `accessKeyId`/`secretAccessKey` passed — S3Storage falls back
to the ambient chain, which now resolves through the `credential_process`
profile above.

`cdnUrl` known limitation: nothing fronts this bucket publicly yet (no
CloudFront — out of scope, see below), so `cdnUrl` is set to the
bucket's own S3 URL even though the bucket itself stays private (no
public bucket policy — it also holds DB segments/manifest, which must
never be public). Uploaded image URLs will not actually resolve
publicly until i8hlt fronts the bucket with a CDN as part of cutover.
Uploads themselves still work and are recorded correctly in the DB.

New env vars: `AWS_ROLE_ARN` (role the credential_process helper
assumes), `GHOST_URL` (real production url — wired now per explicit
decision, see moth ticket), `MAIL_SSM_PARAM_NAME` (default
`ghost_imap_token`).

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
