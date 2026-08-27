# Ghost Custom Build & Deploy Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a locally-patched Ghost on the instance, replacing the stock Ghost-CLI npm install, starting with one concrete patch (a live webfinger self-probe replacing `isSocialWebEnabled()`'s static subdirectory check) that unblocks `syigu` (Social Web).

**Architecture:** A `local-patches` branch on the `Ghost/` submodule (fork `dooreelko/Ghost`), based on the tag matching the instance's currently-installed version, holding our diffs on top of stock Ghost. Built locally with Ghost's own `pack.mjs` release tooling, shipped to the instance with `scripts/ssm-scp.sh`, installed via Ghost-CLI's `--archive` path.

**Tech Stack:** Ghost 6 monorepo (pnpm, Node, the `ghost/core` package), git submodule, AWS SSM (only access path to the instance), Ghost-CLI (already installed on the instance per `phase1.md`).

**Spec:** `docs/superpowers/specs/2026-08-27-ghost-build-pipeline-design.md`

## Global Constraints

- The instance has **no SSH** — all instance interaction goes through `aws
  ssm start-session --target <instance-id>` or `scripts/ssm-scp.sh` /
  `scripts/ssm-backup-instance.sh`. Instance ID comes from
  `.local-secrets.md` (header `Ghost On A Stick`), never hardcoded in any
  tracked file.
- **Run `scripts/ssm-backup-instance.sh` before Task 3's deploy step** if
  it hasn't been run since the last change to the instance (a fresh backup
  covers this session's baseline — check timestamps under
  `.instance-backups/` before assuming one is fresh enough).
- No AWS resource IDs, credential names, or account IDs in any file this
  plan creates or edits.
- The fork's `local-patches` branch is built from **merges** of upstream
  tags, never rebases (a rebase force-push would orphan the submodule's
  pinned commit).
- Every build's `ghost/core/package.json` version gets a local suffix
  (`-local.N`) before packing — never ship a tarball whose version string
  matches a real upstream release.
- `isSocialWebEnabled()` must stay **synchronous** — it's called from
  request-handling code paths (`settings-service.js`) that don't await it.
  The live webfinger probe runs asynchronously in the background and
  updates a cached result; the synchronous method only ever reads that
  cache, never blocks on a network call.

---

### Task 1: Set up the patch branch and prove the unpatched build pipeline

Establishes the fork branch at the right base and proves the build/pack
machinery works before any patch content is added — isolates "did our
patch break the build" from "does the build pipeline even work" in later
tasks.

**Files:**
- Create (in the `Ghost/` submodule, on its own branch — not this repo's
  history): branch `local-patches`, based on tag `v6.57.1`.

**Interfaces:**
- Produces: a pushed `local-patches` branch on `dooreelko/Ghost` at the
  same commit as upstream `v6.57.1`; a confirmed-working local build
  command sequence, recorded for Tasks 2–3 to reuse verbatim.

- [ ] **Step 1: Add the upstream remote and fetch the target tag**

```bash
cd /home/doo/projects/ghost/Ghost
git remote add upstream https://github.com/TryGhost/Ghost.git 2>/dev/null || true
git fetch upstream tag v6.57.1
```

(`v6.57.1` is the version currently running on the instance, confirmed via
`cat /var/www/ghost/package.json` during this session — re-confirm it's
still current with `aws ssm send-command` before running this step, in
case the instance was updated since.)

- [ ] **Step 2: Create and push the branch**

```bash
git checkout -b local-patches v6.57.1
git push -u origin local-patches
```

- [ ] **Step 3: Point this repo's submodule at the new branch**

```bash
cd /home/doo/projects/ghost
git -C Ghost checkout local-patches
git add Ghost
git commit -m "Pin Ghost submodule to local-patches branch (base: v6.57.1)"
```

- [ ] **Step 4: Install dependencies and confirm the unpatched build works**

```bash
cd /home/doo/projects/ghost/Ghost
corepack enable  # if pnpm isn't already the right version, per docs/contributing/development-setup.md
pnpm setup
pnpm install
pnpm --filter ghost run archive
ls ghost/core/package/../*.tgz 2>/dev/null || find ghost/core -maxdepth 1 -name "ghost-*.tgz"
```

Expected: two tarballs matching `ghost-6.57.1.tgz` and
`ghost-6.57.1-npm.tgz` (per `pack.mjs`'s header comment) appear under
`ghost/core/`. This confirms the pipeline before Task 2 touches any code.
If this step fails, stop — it's a pipeline problem, not a patch problem,
and nothing later in this plan will work until it's fixed.

- [ ] **Step 5: Clean up the build output (don't ship the unpatched build)**

```bash
rm -f ghost/core/ghost-*.tgz
```

No further commit — Task 1's only tracked-repo change is the submodule
pointer bump in Step 3.

---

### Task 2: Implement the webfinger self-probe patch

**Files:**
- Modify (in `Ghost/`, on `local-patches`):
  `ghost/core/core/server/services/settings-helpers/settings-helpers.js`
- Test: `ghost/core/test/unit/server/services/settings-helpers/settings-helpers.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the branch/build setup.
- Produces: `SettingsHelpers` gains an async `probeSocialWebSubdirectory()`
  method and a cached probe-result field that `isSocialWebEnabled()` reads
  instead of unconditionally returning `false` for a subdirectory install.
  Later tasks (build/deploy) depend on this file's final state, not on any
  new exported name — `isSocialWebEnabled()`'s signature and call sites are
  unchanged.

- [ ] **Step 1: Read the current implementation for exact context**

```bash
cd /home/doo/projects/ghost/Ghost
sed -n '1,60p' ghost/core/core/server/services/settings-helpers/settings-helpers.js
```

Confirm the constructor's dependencies (`settingsCache`, `config`,
`urlUtils`, `labs`, `limitService`) and that `isSocialWebEnabled()` is a
plain synchronous method on the `SettingsHelpers` class (both true as of
the `v6.57.1` base commit checked during this session — re-confirm, since
Task 1 may have landed a different exact revision if the tag moved).

- [ ] **Step 2: Write the failing tests**

Add these two tests inside the existing `describe('isSocialWebEnabled', ...)`
block in `ghost/core/test/unit/server/services/settings-helpers/settings-helpers.test.js`,
replacing the existing `it('returns false when the site is hosted on a subdirectory', ...)`
test (lines ~441-454 as of the base commit) with:

```js
it('returns false when the site is hosted on a subdirectory and no probe has run yet', function () {
  urlUtils.getSubdir.returns('blog');

  const settingsHelpers = new SettingsHelpers({
    settingsCache,
    config,
    urlUtils,
    labs,
    limitService,
  });
  const isEnabled = settingsHelpers.isSocialWebEnabled();

  assert.equal(isEnabled, false);
});

it('returns true when the site is hosted on a subdirectory but a probe already confirmed webfinger is reachable at the domain root', function () {
  urlUtils.getSubdir.returns('blog');

  const settingsHelpers = new SettingsHelpers({
    settingsCache,
    config,
    urlUtils,
    labs,
    limitService,
  });
  settingsHelpers._socialWebSubdirectoryProbeResult = true;

  const isEnabled = settingsHelpers.isSocialWebEnabled();

  assert.equal(isEnabled, true);
});

it('probeSocialWebSubdirectory caches a successful webfinger fetch', async function () {
  urlUtils.getSiteUrl.returns('http://example.com/blog/');
  urlUtils.getSubdir.returns('blog');
  const fetchStub = sinon.stub().resolves({ ok: true });

  const settingsHelpers = new SettingsHelpers({
    settingsCache,
    config,
    urlUtils,
    labs,
    limitService,
    fetchFn: fetchStub,
  });

  await settingsHelpers.probeSocialWebSubdirectory();

  assert.equal(settingsHelpers._socialWebSubdirectoryProbeResult, true);
  sinon.assert.calledWith(
    fetchStub,
    'http://example.com/.well-known/webfinger?resource=acct:index@example.com'
  );
});

it('probeSocialWebSubdirectory caches a failed webfinger fetch as false', async function () {
  urlUtils.getSiteUrl.returns('http://example.com/blog/');
  urlUtils.getSubdir.returns('blog');
  const fetchStub = sinon.stub().resolves({ ok: false });

  const settingsHelpers = new SettingsHelpers({
    settingsCache,
    config,
    urlUtils,
    labs,
    limitService,
    fetchFn: fetchStub,
  });

  await settingsHelpers.probeSocialWebSubdirectory();

  assert.equal(settingsHelpers._socialWebSubdirectoryProbeResult, false);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd /home/doo/projects/ghost/Ghost
pnpm --filter ghost run test:unit -- --grep "isSocialWebEnabled|probeSocialWebSubdirectory"
```

Expected: FAIL — `probeSocialWebSubdirectory is not a function`, and the
"probe already confirmed" test fails because the field doesn't exist yet.

- [ ] **Step 4: Implement the patch**

In `ghost/core/core/server/services/settings-helpers/settings-helpers.js`,
find the constructor (confirm exact current parameter list from Step 1)
and add a `fetchFn` dependency (defaulting to the global `fetch`, matching
how `activity-pub-service.ts` already calls `fetch` directly elsewhere in
this codebase) plus the cache field:

```js
constructor({
  settingsCache,
  config,
  urlUtils,
  labs,
  limitService,
  fetchFn = fetch,
  // ...whatever other existing constructor deps were found in Step 1, unchanged
}) {
  // ...existing assignments, unchanged...
  this.fetchFn = fetchFn;
  this._socialWebSubdirectoryProbeResult = false;
}
```

Replace the `isSocialWebEnabled()` body's subdirectory block (the exact
lines found in Step 1, matching this shape):

```js
    // Social web (ActivityPub) currently does not support Ghost sites hosted on a subdirectory, e.g. https://example.com/blog/
    const subdirectory = this.urlUtils.getSubdir();
    if (subdirectory) {
      debug('Social web is not available for Ghost sites hosted on a subdirectory');
      return false;
    }
```

with:

```js
    // Social web (ActivityPub) normally isn't available for a subdirectory
    // install, because WebFinger discovery must resolve at the bare domain
    // root (RFC 7033) - but an operator can carve out root-level routing to
    // Ghost anyway (reverse proxy / CDN rules) without changing Ghost's own
    // configured site URL. Rather than refuse unconditionally, probe for it:
    // only allow the feature once a live fetch of the domain-root webfinger
    // endpoint actually succeeds. The probe result is cached and refreshed
    // in the background (see probeSocialWebSubdirectory) so this check stays
    // synchronous.
    const subdirectory = this.urlUtils.getSubdir();
    if (subdirectory && !this._socialWebSubdirectoryProbeResult) {
      debug('Social web on a subdirectory install requires a passing webfinger probe');
      this.probeSocialWebSubdirectory().catch((err) => {
        debug(`Social web subdirectory probe failed: ${err}`);
      });
      return false;
    }
```

Add the new method (place it directly after `isSocialWebEnabled()`):

```js
  /**
   * For a subdirectory install, probes the domain root's WebFinger endpoint
   * and caches whether it actually resolves through to this Ghost instance.
   * isSocialWebEnabled() reads the cached result rather than awaiting this
   * directly, since it must stay synchronous for its callers.
   *
   * @returns {Promise<boolean>}
   */
  async probeSocialWebSubdirectory() {
    const siteUrl = new URL(this.urlUtils.getSiteUrl());
    const probeUrl = `${siteUrl.protocol}//${siteUrl.host}/.well-known/webfinger?resource=acct:index@${siteUrl.hostname}`;

    try {
      const response = await this.fetchFn(probeUrl);
      this._socialWebSubdirectoryProbeResult = Boolean(response && response.ok);
    } catch (err) {
      debug(`Social web subdirectory probe request failed: ${err}`);
      this._socialWebSubdirectoryProbeResult = false;
    }

    return this._socialWebSubdirectoryProbeResult;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter ghost run test:unit -- --grep "isSocialWebEnabled|probeSocialWebSubdirectory"
```

Expected: PASS, all tests in both describe blocks.

- [ ] **Step 6: Run the broader settings-helpers suite to check for regressions**

```bash
pnpm --filter ghost run test:unit -- --grep "settings-helpers"
```

Expected: PASS — no other test in the file depended on the exact shape of
the subdirectory branch.

- [ ] **Step 7: Commit on the fork**

```bash
cd /home/doo/projects/ghost/Ghost
git add ghost/core/core/server/services/settings-helpers/settings-helpers.js \
        ghost/core/test/unit/server/services/settings-helpers/settings-helpers.test.js
git commit -m "Probe webfinger reachability instead of refusing social web on any subdirectory install"
git push origin local-patches
```

- [ ] **Step 8: Bump this repo's submodule pointer**

```bash
cd /home/doo/projects/ghost
git add Ghost
git commit -m "Bump Ghost submodule: webfinger subdirectory probe patch"
```

---

### Task 3: Build, ship, and deploy the patched Ghost

**Files:** none in this repo beyond what Task 1/2 already committed (submodule pointer).

**Interfaces:**
- Consumes: the working build command sequence from Task 1 Step 4; the
  patched `local-patches` branch from Task 2.
- Produces: the instance running the patched build, confirmed via
  `ghost status` reporting the bumped local version string.

- [ ] **Step 1: Confirm a recent instance backup exists**

```bash
ls -la /home/doo/projects/ghost/.instance-backups/
```

If the newest backup predates today, run
`scripts/ssm-backup-instance.sh` first (per Global Constraints).

- [ ] **Step 2: Bump the version and build**

```bash
cd /home/doo/projects/ghost/Ghost
node -e "
const fs = require('fs');
const path = 'ghost/core/package.json';
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.version = pkg.version.replace(/(-rc\.\d+)?$/, '-local.1');
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
console.log(pkg.version);
"
pnpm --filter ghost run archive
find ghost/core -maxdepth 1 -name "ghost-*-npm.tgz"
```

Expected: a single file matching `ghost-6.57.1-local.1-npm.tgz` (or
whatever version Task 1 actually built from, with the `-local.1` suffix
applied). Record this exact filename — later steps use it verbatim.

- [ ] **Step 3: Revert the version bump in git (the tarball itself carries the version, the source shouldn't)**

```bash
git checkout ghost/core/package.json
```

- [ ] **Step 4: Ship the tarball to the instance**

```bash
cd /home/doo/projects/ghost
./scripts/ssm-scp.sh push Ghost/ghost/core/ghost-6.57.1-local.1-npm.tgz /tmp/ghost-6.57.1-local.1-npm.tgz
```

(Substitute the exact filename from Step 2.)

- [ ] **Step 5: Deploy via Ghost-CLI on the instance**

```bash
aws ssm start-session --target <instance-id from .local-secrets.md>
```

Inside the session:

```bash
sudo -u ghost bash -c 'cd /var/www/ghost && ghost update --zip /tmp/ghost-6.57.1-local.1-npm.tgz --v1'
```

(Confirm the exact flag against `ghost help update` on the instance first
— Ghost-CLI's archive-install flag naming has varied across versions
[the shipping doc references `--archive` generically]; run `ghost help
update` and `ghost help install` and use whichever flag that specific
CLI version documents for installing from a local file, adjusting this
command accordingly. Do not guess if the two disagree — read the actual
help output.)

- [ ] **Step 6: Verify the deployed version**

```bash
sudo -u ghost ghost status
cat /var/www/ghost/package.json | grep -m1 version
```

Expected: version string shows the `-local.1` suffix, and Ghost's status
is running.

- [ ] **Step 7: Verify the site still serves correctly**

```bash
exit  # leave the SSM session
curl -sI https://the-well-architected-cloud.com/blog/ | head -5
```

Expected: `200 OK` (or the site's normal response), confirming the swap
didn't break the running blog.

- [ ] **Step 8: Clean up the remote tarball**

```bash
aws ssm start-session --target <instance-id from .local-secrets.md>
```

Inside the session: `rm -f /tmp/ghost-6.57.1-local.1-npm.tgz`, then `exit`.

No repo commit for this task (deploy-only, no tracked file changes beyond
what Task 2 already committed).

---

### Task 4: Record the outcome

**Files:**
- Modify: `.local-secrets.md` (append, don't overwrite — see this repo's
  `CLAUDE.md` for why)
- Modify: moth issue `qadpt` (via `moth update`, read-then-append, same rule)

**Interfaces:** none — this task only updates records.

- [ ] **Step 1: Append the deployed version to `.local-secrets.md`**

Under the existing `Ghost On A Stick` section, add a line noting the
instance now runs a `-local.N`-suffixed build from the `local-patches`
branch, so a future reader knows `ghost update` from npm would silently
discard the patch.

- [ ] **Step 2: Update the moth issue**

```bash
cd /home/doo/projects/ghost
moth show qadpt > /tmp/qadpt_final.md
tail -n +4 /tmp/qadpt_final.md > /tmp/qadpt_final_body.md
```

Append a short "Deployed" section (build version, date, confirmation the
site verified working) to `/tmp/qadpt_final_body.md`, then:

```bash
moth update qadpt < /tmp/qadpt_final_body.md
moth done qadpt
```

Only run `moth done qadpt` after Task 3 Step 7's verification actually
passed — do not mark it done speculatively.

- [ ] **Step 3: Commit the `.local-secrets.md` note**

`.local-secrets.md` is gitignored (per this repo's `.gitignore`), so
there's nothing to `git add` for Step 1 — this step is a no-op by design,
listed for clarity that Step 1's change is intentionally untracked.
