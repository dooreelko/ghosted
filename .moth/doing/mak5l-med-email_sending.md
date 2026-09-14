looks like there's something about imap

----- AI agent updates -------

## Decision record (2026-09-14)

**Symptom:** magic-link signin returned `EAUTH`/"Missing credentials for PLAIN" from Ghost's mail transport.

**Root cause:** `phase2/packages/ghost-sqlite-s3-launcher/src/preload.mjs` fetched the Proton SMTP credential from SSM param `ghost_imap_token` and split it on `:` assuming a `user:password` value (comment cited phase1/jpjiy's handling). The actual param only ever held the password. Splitting a colon-less string put the whole secret into `user` and left `pass` empty, which nodemailer's `smtp-connection` rejects before ever contacting Proton (`Missing credentials for "PLAIN"`).

**Fix:** stop splitting. `mailUser` is now a fixed constant (`robots@the-well-architected-cloud.com`, overridable via `MAIL_USER` env, matching phase1's actual sending address), and the full SSM param value is used as `pass` unchanged. See `phase2/packages/ghost-sqlite-s3-launcher/src/preload.mjs` and `mail-config.mjs`.

**Verified deployed:** Lightsail active deployment's image tag is `6557067`, which is the fix commit itself (deployed 2026-09-14T10:58:02+02:00). The fix is live in production, not pending.

**Still no email received after the fix — investigated, and it's a different, unrelated code path, not a regression of the SSM fix:**

The manual test used the *member portal* magic-link endpoint (`/blog/members/api/send-magic-link/`, `emailType: "signin"`) with the staff/owner email `sascha.fedorenko@the-well-architected-cloud.com`. Ghost's member system and staff/user accounts are separate; that address is not a registered Member. `router-controller.js`'s `_handleSignin` deliberately fakes a success response and returns early *without ever calling the mail service* when no Member exists for the given email — an anti-enumeration guard, not a bug. This fully explains "check your email" shown, no email arriving, and zero mail-related log lines (no send was attempted).

**Decision: re-test via the staff admin "forgot password" flow instead**, not the member portal. That path (`core/server/services/auth/passwordreset.js` → `POST /blog/ghost/api/admin/authentication/password_reset/` from the admin signin screen) throws a real `NotFoundError` for an email with no matching staff User (no silent guard), and on success calls `mailAPI.send()` directly — an unambiguous signal of whether the SMTP fix actually works end-to-end for a real account.

**Out of scope for this ticket:** member-portal signin's enumeration-guard behavior itself is working as designed; not something to change here.

**Next step (pending):** trigger staff forgot-password for sascha.fedorenko@the-well-architected-cloud.com from `/blog/ghost/`, confirm email arrives and/or capture any error from logs.


## Decision record 2 (2026-09-14): why container logs showed only [boot] lines

**Symptom:** after the SSM-credential fix, testing produced no visible Ghost-core log output at all in Lightsail's container logs -- only `preload.mjs`'s own `console.error('[boot] ...')` lines, never anything from Ghost itself (mail errors, request logs, member-signin info logs), even for requests confirmed to have reached and been processed by Ghost.

**Root cause found (no more hypotheses needed, confirmed directly from Ghost's own config files):** the base image's `Dockerfile.production` sets `NODE_ENV=production`. Ghost's config loader merges in `core/shared/config/env/config.production.json` for that env, which overrides `logging.transports` from the default `["stdout"]` to `["file"]`. Every Ghost-core log line was being written to a rotating log file under `content/logs/` inside the container filesystem, never to stdout -- so Lightsail's log capture (which only sees stdout/stderr) never saw any of it. This is unrelated to the earlier `stdbuf -oL -eL` fix (Dockerfile comment) -- that addressed buffering of whatever *does* reach stdout; this is a config override that keeps Ghost's own logs off stdout entirely.

**Fix:** `preload.mjs` now also does `config.set('logging:transports', ['stdout'])`, alongside the existing `mail`/`database`/`url`/`server:host`/`storage` overrides -- same mechanism, same place.

**Rejected alternative:** leaving `transports: ["file"]` and instead reading the log file inside the container (e.g. via an SSM exec/shell into the container) -- rejected as a standing operational tax (have to exec in every time to see anything) versus a one-line config override that makes `get-container-log` work as expected going forward.

**Next step (pending):** rebuild/redeploy image with this change, then re-run the staff forgot-password test (from decision record 1 above) and confirm both the email arrives and the attempt is now visible in Lightsail's container logs.


## Decision record 3 (2026-09-14): 400 on member signin after making robots@ a member

**Symptom:** with `robots@the-well-architected-cloud.com` now a real Member, the magic-link signin request (which now actually attempts a send, per decision record 1) returns HTTP 400.

**Root cause:** `router-controller.js`'s `sendMagicLink` returns 400 specifically when the mail attempt throws with `err.code === 'EENVELOPE'` (SMTP envelope rejection). Our `mail` config (`mail-config.mjs`) never set `mail.from`. Ghost's `getDefaultEmail()` (`settings-helpers.js`) falls back to a generated `noreply@<site-domain>` address for the member-facing from/support address whenever `mail.from` is unset -- so member emails were being sent From `noreply@the-well-architected-cloud.com` while authenticating to Proton as `robots@the-well-architected-cloud.com`. Proton's submission server rejects a From address that isn't the authenticated mailbox, which nodemailer surfaces as `EENVELOPE`.

**Fix:** `buildMailConfig` now also sets `from: user` (same address used for SMTP auth), so the member-facing from address always matches the authenticated Proton mailbox.

**Next step (pending):** rebuild/redeploy with all three fixes (SSM credential parsing, stdout logging, mail.from), then re-test member magic-link signin for robots@ end-to-end.


## Decision record 4 (2026-09-14): stdout-logging fix confirmed working; new EENVELOPE cause found

**Confirmed working:** after deploy, the real Ghost-core error appeared directly in container logs (decision record 2's fix verified in production).

**New error surfaced:** `553 5.7.1 <noreply@the-well-architected-cloud.com>: Sender address rejected: not owned by user robots@the-well-architected-cloud.com` -- still EENVELOPE, still using `noreply@`, despite decision record 3's `mail.from` fix being deployed.

**Root cause:** member-facing emails (magic-link signin included) get their From/support address from `EmailAddressService.getMembersSupportAddress()`, which reads Ghost's `members_support_address` **Settings table row** first -- not `mail.from`/`getDefaultEmail()` at all (that's only the fallback when `members_support_address` is unset). Ghost ships this setting with `defaultValue: "noreply"` (`core/server/data/schema/default-settings/default-settings.json`), which combined with the site's own domain produces `noreply@the-well-architected-cloud.com` regardless of `mail.from`. This is per-install application data (a DB row), not something `preload.mjs`'s config overrides touch.

**Decision: fix via Ghost Settings, not code.** Self-hosted installs (`managedEmailEnabled` false) can set this freely with no verification-email requirement (`email-address-service.ts` `validate()`). Set `members_support_address` to `robots@the-well-architected-cloud.com` via Admin UI (Settings -> Membership -> Portal settings) or the Admin API's settings endpoint.

**Scope note:** `mail.from` (decision record 3) stays as the right fix for paths that *do* fall through to `getDefaultEmail()` (e.g. staff password-reset uses `getFromAddress()` in `ghost-mailer.js`, which falls back to `emailAddress.service.defaultFromEmail` when no explicit from is requested) -- not redundant, just not sufficient on its own for member-portal mail.

**Next step (pending):** set `members_support_address`, re-test member magic-link signin for robots@.


## Decision record 5 (2026-09-14): members_support_address fixed via Admin UI

**Fix applied:** Settings -> Membership -> Signup portal -> Customize -> Account page -> "Support email address" changed from `noreply@the-well-architected-cloud.com` (the ships-with-Ghost `noreply` default) to `robots@the-well-architected-cloud.com`, matching the SMTP-authenticated mailbox. Confirmed via Admin API read afterward.

**Why UI, not API:** the Admin API's Custom Integration tokens are blocked from writing `/settings/` (`403 NoPermissionError: API tokens do not have permission to access this endpoint`) -- Ghost restricts settings writes to staff-session auth. Read access works fine with an integration token; writes don't.

**Next step (pending):** re-test member magic-link signin for robots@the-well-architected-cloud.com end-to-end -- all four fixes (SSM credential parsing, stdout logging, mail.from, members_support_address) should now combine to make this actually work.


## Decision record 6 (2026-09-14): mail-sending smoke test added to deploy verification

**Confirmed:** magic-link signin for robots@the-well-architected-cloud.com went through end-to-end.

**Decision:** every previous verification step (HTTP smoke test, Admin API image/post roundtrip) never exercised Ghost's actual mail path -- that's exactly why all four bugs above (SSM credential parsing, stdout logging, mail.from, members_support_address) went unnoticed by `deploy.sh`'s own verification until manually tested. Added `sendMagicLinkSmoke` (`phase2/packages/deploy-verify/src/mail-smoke-test.mjs`) as the final step of `verify.mjs`: fetches an integrity token then POSTs a real signin magic-link request for robots@the-well-architected-cloud.com (a real Member), and fails deploy verification (triggering the existing rollback path) if Ghost/Proton doesn't accept the send.

**Scope/limit, explicit:** this only confirms Ghost's mail service accepted the send (no EAUTH/EENVELOPE/etc) -- it does not confirm actual inbox delivery, which would need a real mailbox-polling step, not attempted here.
