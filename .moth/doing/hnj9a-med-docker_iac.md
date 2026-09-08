this is a subtask of hi3zi

adapt docker images to our needs and create iac for lightsail & co under ./phase2/iac/

----- AI agent updates -------

## Decisions (2026-09-08)

Full technical design: [docs/superpowers/specs/2026-09-08-phase2-docker-iac-design.md](../../docs/superpowers/specs/2026-09-08-phase2-docker-iac-design.md)

**Docker: two-stage build, never fork Ghost's own Dockerfile.** Ghost's
upstream `Dockerfile.production` (`full` target) is built as-is; a second,
small Dockerfile in `phase2/docker/` layers the `ghost-sqlite-s3-launcher`
package on top and overrides `CMD` to boot through it. Zero diff to
Ghost's own build.
- Rejected: one combined Dockerfile reimplementing Ghost's build stages
  plus the launcher — would duplicate/fork upstream's build logic.

**Launcher grows two more boot-time jobs, not split into separate
preloads:** AssumeRole credential wiring (auto-refreshing, via
`fromTemporaryCredentials`, used for both S3 and SSM) and mail config
(fetches the existing Proton SMTP credential from SSM, reusing phase1's
`ghost_imap_token` param rather than a new one).
- Rejected: a shell entrypoint doing AssumeRole instead of the launcher
  itself — moot once confirmed the SDK's credential provider
  auto-refreshes on its own.
- Rejected: a second, separate preload just for mail — same kind of
  boot-time-config job as the DB/credentials wiring, no reason to split.

**Registry: private ECR**, not Lightsail's own push-image mechanism, not
public ECR. Corrected mid-design: Lightsail Container Service *does*
support pulling from a private ECR repo (initially missed) via a
dedicated, Lightsail-managed "ECR image puller" role — a completely
separate IAM construct from the app's own AssumeRole runtime role above,
easy to conflate, don't.
- Rejected: Lightsail's own internal registry (`push-container-image`) —
  works, but ties the image purely to Lightsail with no portability if
  compute ever changes.
- Rejected: public ECR — would avoid the ECR-puller-role plumbing, but
  makes the built image publicly pullable by anyone with the URI.
- Image size / ECR's $0.10/GB-month pricing is a non-concern either way
  (Ghost production images run a few hundred MB).

**IAM: two independent roles.** The app's own runtime role (trust policy
names the container service's principal ARN, no `sts:ExternalId` — note
this exact config wasn't the one verified working in phase2/readme.md's
hands-on session, which used an ExternalId; watch for it on apply) is
unrelated to the Lightsail-managed ECR image puller role. Same mistake
(conflating them) is easy to make again — kept explicit in the design
doc.

**Tag `app:ghost-phase2`** on all new resources (distinct from phase1's
`app:ghost-classic`), region `us-east-1` (same as phase1).

**OpenTofu**, flat local state, one file per component under
`phase2/iac/`, applied for real this session (not just written) —
explicit user instruction.

**Scope: infra + a real, fully-configured image/deployment (real url,
real mail), but no traffic cutover.** No CloudFront/DNS changes, no
content/DB migration — matches hi3zi's split; moth i8hlt owns turning
this into the live site and the automated deploy/rollback cycle around
it.
