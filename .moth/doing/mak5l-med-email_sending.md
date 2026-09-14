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
