# Draft-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/draft-sync`, a CLI that pulls a Ghost draft to a local
markdown file for offline editing (vim) and pushes edits back, per moth `lwlkt`.

**Architecture:** A small Node/ESM package with four pure/testable modules
(`store`, `convert`, `admin-api`, `pull`/`push`) behind a thin CLI entrypoint.
`pull`/`push` take an injected admin-api client object, so tests exercise them
with a fixture object instead of a live Ghost site.

**Tech Stack:** Node (`node --test`, matches `phase2/packages/sqlite-s3`
convention), `@tryghost/admin-api`, `@tryghost/kg-lexical-html-renderer`,
`@tryghost/kg-html-to-lexical`, `@tryghost/kg-default-nodes`, `turndown`,
`marked`.

**Spec:** `docs/superpowers/specs/2026-09-14-draft-sync-design.md`

## Global Constraints

- Manual pull-edit-push only. No watcher/daemon, no auto two-way sync.
- Local state is gitignored, one folder per draft: `.ghost-drafts/<slug>/{draft.md,original.lexical.json,meta.json}`.
- Push aborts (no auto-merge, no last-write-wins) if the remote draft's
  lexical differs from the locally-stored `original.lexical.json`.
- Ghost auth via `GHOST_ADMIN_API_URL` + `GHOST_ADMIN_API_KEY` env vars only;
  never written to a tracked file. Document (names only) in this repo;
  real values go in `.local-secrets.md`.
- Package versions for the koenig conversion packages must match the
  `Ghost/` submodule's currently-vendored versions exactly (checked at
  plan-writing time: `kg-lexical-html-renderer@1.5.0`,
  `kg-html-to-lexical@1.4.0`, `kg-default-nodes@2.2.1`) so pull/push convert
  using the same node set the running Ghost instance understands.
- `node --test` for unit tests (repo convention, see `phase2/packages/sqlite-s3/package.json`). No network calls in any automated test.

---

### Task 1: Package scaffold

**Files:**
- Create: `packages/draft-sync/package.json`
- Create: `packages/draft-sync/bin/draft-sync.js` (placeholder CLI, filled in Task 7)
- Modify: `.gitignore` (add `.ghost-drafts/`)
- Create: `scripts/draft-sync` (symlink to `../packages/draft-sync/bin/draft-sync.js`)

**Interfaces:**
- Produces: `packages/draft-sync/package.json` with `"type": "module"`, the
  dependency list below, and `"test": "node --test"` script — every later
  task's `import` statements assume ESM resolution from this file.

- [ ] **Step 1: Create the package.json**

```json
{
  "name": "draft-sync",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": {
    "draft-sync": "bin/draft-sync.js"
  },
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "@tryghost/admin-api": "^1.14.12",
    "@tryghost/kg-default-nodes": "2.2.1",
    "@tryghost/kg-html-to-lexical": "1.4.0",
    "@tryghost/kg-lexical-html-renderer": "1.5.0",
    "marked": "^12.0.0",
    "turndown": "^7.2.0"
  }
}
```

- [ ] **Step 2: Create a placeholder CLI so `npm install` has a valid bin target**

`packages/draft-sync/bin/draft-sync.js`:
```js
#!/usr/bin/env node
console.log('draft-sync: not yet implemented');
```

- [ ] **Step 3: Make it executable and install deps**

```bash
chmod +x packages/draft-sync/bin/draft-sync.js
cd packages/draft-sync && npm install
cd -
```

- [ ] **Step 4: Symlink from scripts/**

```bash
ln -s ../packages/draft-sync/bin/draft-sync.js scripts/draft-sync
```

- [ ] **Step 5: Add `.ghost-drafts/` to .gitignore**

Append `.ghost-drafts/` as its own line to the repo-root `.gitignore`.

- [ ] **Step 6: Verify**

```bash
node scripts/draft-sync
```
Expected: prints `draft-sync: not yet implemented`.

- [ ] **Step 7: Commit**

```bash
git add packages/draft-sync/package.json packages/draft-sync/package-lock.json packages/draft-sync/bin/draft-sync.js scripts/draft-sync .gitignore
git commit -m "draft-sync: scaffold package"
```

---

### Task 2: Local draft store

**Files:**
- Create: `packages/draft-sync/src/store.js`
- Test: `packages/draft-sync/test/store.test.js`

**Interfaces:**
- Produces:
  - `draftDir(repoRoot, slug) -> string` (absolute path to `.ghost-drafts/<slug>`)
  - `draftExists(repoRoot, slug) -> boolean`
  - `writeDraft(repoRoot, slug, {markdown, originalLexical, meta}, {force = false} = {}) -> void` — throws `Error` (message starting `"draft exists"`) if the folder already exists and `force` is false; otherwise creates/overwrites `draft.md`, `original.lexical.json`, `meta.json` (meta written as `JSON.stringify(meta, null, 2)`).
  - `readDraft(repoRoot, slug) -> {markdown, originalLexical, meta}` — throws `Error` (message starting `"no local draft"`) if the folder doesn't exist.
- Consumes: nothing (pure filesystem, no other task modules).

- [ ] **Step 1: Write the failing tests**

`packages/draft-sync/test/store.test.js`:
```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftDir, draftExists, writeDraft, readDraft } from '../src/store.js';

function withTmpRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'draft-sync-test-'));
  try {
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('draftDir builds the per-slug path', () => {
  withTmpRepo((repoRoot) => {
    assert.equal(
      draftDir(repoRoot, 'hello-world'),
      join(repoRoot, '.ghost-drafts', 'hello-world')
    );
  });
});

test('draftExists is false before write, true after', () => {
  withTmpRepo((repoRoot) => {
    assert.equal(draftExists(repoRoot, 'a'), false);
    writeDraft(repoRoot, 'a', { markdown: 'hi', originalLexical: '{}', meta: { id: '1', updated_at: 't' } });
    assert.equal(draftExists(repoRoot, 'a'), true);
  });
});

test('writeDraft then readDraft round-trips', () => {
  withTmpRepo((repoRoot) => {
    writeDraft(repoRoot, 'a', { markdown: '# Hi', originalLexical: '{"root":{}}', meta: { id: '1', updated_at: 't1' } });
    const draft = readDraft(repoRoot, 'a');
    assert.equal(draft.markdown, '# Hi');
    assert.equal(draft.originalLexical, '{"root":{}}');
    assert.deepEqual(draft.meta, { id: '1', updated_at: 't1' });
  });
});

test('writeDraft refuses to overwrite without force', () => {
  withTmpRepo((repoRoot) => {
    writeDraft(repoRoot, 'a', { markdown: 'v1', originalLexical: '{}', meta: { id: '1', updated_at: 't' } });
    assert.throws(
      () => writeDraft(repoRoot, 'a', { markdown: 'v2', originalLexical: '{}', meta: { id: '1', updated_at: 't2' } }),
      /draft exists/
    );
    assert.equal(readDraft(repoRoot, 'a').markdown, 'v1');
  });
});

test('writeDraft overwrites with force: true', () => {
  withTmpRepo((repoRoot) => {
    writeDraft(repoRoot, 'a', { markdown: 'v1', originalLexical: '{}', meta: { id: '1', updated_at: 't' } });
    writeDraft(repoRoot, 'a', { markdown: 'v2', originalLexical: '{}', meta: { id: '1', updated_at: 't2' } }, { force: true });
    assert.equal(readDraft(repoRoot, 'a').markdown, 'v2');
  });
});

test('readDraft throws when no local draft exists', () => {
  withTmpRepo((repoRoot) => {
    assert.throws(() => readDraft(repoRoot, 'nope'), /no local draft/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/draft-sync && node --test test/store.test.js
```
Expected: FAIL — `src/store.js` doesn't exist yet (module not found).

- [ ] **Step 3: Implement store.js**

`packages/draft-sync/src/store.js`:
```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function draftDir(repoRoot, slug) {
  return join(repoRoot, '.ghost-drafts', slug);
}

export function draftExists(repoRoot, slug) {
  return existsSync(draftDir(repoRoot, slug));
}

export function writeDraft(repoRoot, slug, { markdown, originalLexical, meta }, { force = false } = {}) {
  const dir = draftDir(repoRoot, slug);
  if (existsSync(dir) && !force) {
    throw new Error(`draft exists: ${dir} (pass force to overwrite)`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'draft.md'), markdown);
  writeFileSync(join(dir, 'original.lexical.json'), originalLexical);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

export function readDraft(repoRoot, slug) {
  const dir = draftDir(repoRoot, slug);
  if (!existsSync(dir)) {
    throw new Error(`no local draft: ${dir} (run pull first)`);
  }
  return {
    markdown: readFileSync(join(dir, 'draft.md'), 'utf8'),
    originalLexical: readFileSync(join(dir, 'original.lexical.json'), 'utf8'),
    meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/draft-sync && node --test test/store.test.js
```
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/draft-sync/src/store.js packages/draft-sync/test/store.test.js
git commit -m "draft-sync: local draft store"
```

---

### Task 3: Lexical <-> markdown conversion

**Files:**
- Create: `packages/draft-sync/src/convert.js`
- Test: `packages/draft-sync/test/convert.test.js`

**Interfaces:**
- Produces:
  - `async lexicalToMarkdown(lexicalString) -> Promise<string>`
  - `markdownToLexicalString(markdown) -> string` (JSON-stringified lexical state, same shape as what the Admin API's `lexical` field contains)
- Consumes: nothing from other draft-sync modules; wraps `@tryghost/kg-lexical-html-renderer`, `@tryghost/kg-html-to-lexical`, `@tryghost/kg-default-nodes`, `turndown`, `marked`.

- [ ] **Step 1: Write the failing test**

`packages/draft-sync/test/convert.test.js`:
```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexicalToMarkdown, markdownToLexicalString } from '../src/convert.js';

const SIMPLE_LEXICAL = JSON.stringify({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: 'Hello world', type: 'text', version: 1 }],
        direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1
      }
    ],
    direction: 'ltr', format: '', indent: 0, type: 'root', version: 1
  }
});

test('lexicalToMarkdown renders a simple paragraph', async () => {
  const markdown = await lexicalToMarkdown(SIMPLE_LEXICAL);
  assert.match(markdown, /Hello world/);
});

test('markdownToLexicalString produces a parseable lexical doc containing the text', () => {
  const lexicalString = markdownToLexicalString('Hello world');
  const parsed = JSON.parse(lexicalString);
  assert.equal(parsed.root.type, 'root');
  assert.match(JSON.stringify(parsed), /Hello world/);
});

test('round trip: lexical -> markdown -> lexical -> markdown keeps the text', async () => {
  const markdown1 = await lexicalToMarkdown(SIMPLE_LEXICAL);
  const lexical2 = markdownToLexicalString(markdown1);
  const markdown2 = await lexicalToMarkdown(lexical2);
  assert.match(markdown2, /Hello world/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/draft-sync && node --test test/convert.test.js
```
Expected: FAIL — `src/convert.js` doesn't exist.

- [ ] **Step 3: Implement convert.js**

`packages/draft-sync/src/convert.js`:
```js
import { LexicalHTMLRenderer } from '@tryghost/kg-lexical-html-renderer';
import { htmlToLexical } from '@tryghost/kg-html-to-lexical';
import { DEFAULT_NODES } from '@tryghost/kg-default-nodes';
import TurndownService from 'turndown';
import { marked } from 'marked';

const renderer = new LexicalHTMLRenderer({ nodes: DEFAULT_NODES });
const turndown = new TurndownService();

export async function lexicalToMarkdown(lexicalString) {
  const html = await renderer.render(lexicalString);
  return turndown.turndown(html);
}

export function markdownToLexicalString(markdown) {
  const html = marked.parse(markdown);
  const lexicalState = htmlToLexical(html);
  return JSON.stringify(lexicalState);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/draft-sync && node --test test/convert.test.js
```
Expected: PASS, all 3 tests. If `lexicalToMarkdown` throws about a missing
`jsdom` module, run `npm install jsdom --save` in `packages/draft-sync` —
`kg-lexical-html-renderer` dynamically `import()`s it and expects it
resolvable from the consuming package, not just its own `node_modules`.

- [ ] **Step 5: Commit**

```bash
git add packages/draft-sync/src/convert.js packages/draft-sync/test/convert.test.js packages/draft-sync/package.json packages/draft-sync/package-lock.json
git commit -m "draft-sync: lexical<->markdown conversion"
```

---

### Task 4: Admin API client factory

**Files:**
- Create: `packages/draft-sync/src/admin-api.js`
- Test: `packages/draft-sync/test/admin-api.test.js`

**Interfaces:**
- Produces: `createAdminApi(env = process.env) -> GhostAdminAPI instance` — throws
  `Error` (message starting `"GHOST_ADMIN_API_URL"` or `"GHOST_ADMIN_API_KEY"`
  respectively) if either env var is missing.
- Consumes: nothing from other draft-sync modules.

- [ ] **Step 1: Write the failing test**

`packages/draft-sync/test/admin-api.test.js`:
```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminApi } from '../src/admin-api.js';

test('throws when GHOST_ADMIN_API_URL is missing', () => {
  assert.throws(
    () => createAdminApi({ GHOST_ADMIN_API_KEY: '000000000000000000000000:' + '0'.repeat(64) }),
    /GHOST_ADMIN_API_URL/
  );
});

test('throws when GHOST_ADMIN_API_KEY is missing', () => {
  assert.throws(
    () => createAdminApi({ GHOST_ADMIN_API_URL: 'https://example.com' }),
    /GHOST_ADMIN_API_KEY/
  );
});

test('returns a client with posts.read/browse/edit when both env vars are set', () => {
  const api = createAdminApi({
    GHOST_ADMIN_API_URL: 'https://example.com',
    GHOST_ADMIN_API_KEY: '000000000000000000000000:' + '0'.repeat(64)
  });
  assert.equal(typeof api.posts.read, 'function');
  assert.equal(typeof api.posts.browse, 'function');
  assert.equal(typeof api.posts.edit, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/draft-sync && node --test test/admin-api.test.js
```
Expected: FAIL — `src/admin-api.js` doesn't exist.

- [ ] **Step 3: Implement admin-api.js**

`packages/draft-sync/src/admin-api.js`:
```js
import GhostAdminAPI from '@tryghost/admin-api';

export function createAdminApi(env = process.env) {
  const url = env.GHOST_ADMIN_API_URL;
  const key = env.GHOST_ADMIN_API_KEY;
  if (!url) {
    throw new Error('GHOST_ADMIN_API_URL is not set');
  }
  if (!key) {
    throw new Error('GHOST_ADMIN_API_KEY is not set');
  }
  return new GhostAdminAPI({ url, key, version: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/draft-sync && node --test test/admin-api.test.js
```
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/draft-sync/src/admin-api.js packages/draft-sync/test/admin-api.test.js
git commit -m "draft-sync: admin API client factory"
```

---

### Task 5: Pull command

**Files:**
- Create: `packages/draft-sync/src/pull.js`
- Test: `packages/draft-sync/test/pull.test.js`

**Interfaces:**
- Consumes: `writeDraft`, `draftExists` from `./store.js` (Task 2);
  `lexicalToMarkdown` from `./convert.js` (Task 3).
- Produces: `async pullDraft(adminApi, repoRoot, slug, { force = false } = {}) -> Promise<void>` —
  `adminApi` is duck-typed as `{ posts: { read(data, queryParams) } }`. Throws
  the same `"draft exists"` error as `writeDraft` when a local copy already
  exists and `force` is false (checked before calling the API, so no wasted
  network round trip).

- [ ] **Step 1: Write the failing test**

`packages/draft-sync/test/pull.test.js`:
```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullDraft } from '../src/pull.js';
import { readDraft } from '../src/store.js';

const FIXTURE_LEXICAL = JSON.stringify({
  root: {
    children: [{
      children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: 'Draft body', type: 'text', version: 1 }],
      direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1
    }],
    direction: 'ltr', format: '', indent: 0, type: 'root', version: 1
  }
});

function fakeAdminApi({ id = 'post-1', slug = 'my-draft', updated_at = '2026-01-01T00:00:00.000Z', lexical = FIXTURE_LEXICAL } = {}) {
  return {
    posts: {
      async read(data, queryParams) {
        assert.equal(data.slug, slug);
        assert.deepEqual(queryParams, { formats: 'lexical' });
        return { id, slug, updated_at, lexical };
      }
    }
  };
}

function withTmpRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'draft-sync-test-'));
  try {
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('pullDraft writes markdown, original lexical, and meta locally', async () => {
  await withTmpRepo(async (repoRoot) => {
    await pullDraft(fakeAdminApi(), repoRoot, 'my-draft');
    const draft = readDraft(repoRoot, 'my-draft');
    assert.match(draft.markdown, /Draft body/);
    assert.equal(draft.originalLexical, FIXTURE_LEXICAL);
    assert.deepEqual(draft.meta, { id: 'post-1', updated_at: '2026-01-01T00:00:00.000Z' });
  });
});

test('pullDraft refuses to overwrite an existing local draft without force', async () => {
  await withTmpRepo(async (repoRoot) => {
    await pullDraft(fakeAdminApi(), repoRoot, 'my-draft');
    await assert.rejects(
      () => pullDraft(fakeAdminApi(), repoRoot, 'my-draft'),
      /draft exists/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/draft-sync && node --test test/pull.test.js
```
Expected: FAIL — `src/pull.js` doesn't exist.

- [ ] **Step 3: Implement pull.js**

`packages/draft-sync/src/pull.js`:
```js
import { draftExists, writeDraft } from './store.js';
import { lexicalToMarkdown } from './convert.js';

export async function pullDraft(adminApi, repoRoot, slug, { force = false } = {}) {
  if (draftExists(repoRoot, slug) && !force) {
    throw new Error(`draft exists: .ghost-drafts/${slug} (pass force to overwrite)`);
  }
  const post = await adminApi.posts.read({ slug }, { formats: 'lexical' });
  const markdown = await lexicalToMarkdown(post.lexical);
  writeDraft(repoRoot, slug, {
    markdown,
    originalLexical: post.lexical,
    meta: { id: post.id, updated_at: post.updated_at }
  }, { force: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/draft-sync && node --test test/pull.test.js
```
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add packages/draft-sync/src/pull.js packages/draft-sync/test/pull.test.js
git commit -m "draft-sync: pull command"
```

---

### Task 6: Push command

**Files:**
- Create: `packages/draft-sync/src/push.js`
- Test: `packages/draft-sync/test/push.test.js`

**Interfaces:**
- Consumes: `readDraft`, `writeDraft` from `./store.js` (Task 2);
  `markdownToLexicalString` from `./convert.js` (Task 3).
- Produces: `async pushDraft(adminApi, repoRoot, slug) -> Promise<void>` —
  `adminApi` duck-typed as `{ posts: { read(data, queryParams), edit(data, queryParams) } }`.
  Throws an `Error` whose message starts with `"remote draft changed"` when
  the freshly-fetched remote lexical differs from the locally stored
  `original.lexical.json` (checked before any write).

- [ ] **Step 1: Write the failing test**

`packages/draft-sync/test/push.test.js`:
```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushDraft } from '../src/push.js';
import { writeDraft, readDraft } from '../src/store.js';

const ORIGINAL_LEXICAL = '{"root":{"type":"root","version":"orig"}}';
const CHANGED_LEXICAL = '{"root":{"type":"root","version":"changed-on-remote"}}';

function withTmpRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'draft-sync-test-'));
  try {
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function seedLocalDraft(repoRoot, slug, markdown = 'Edited body') {
  writeDraft(repoRoot, slug, {
    markdown,
    originalLexical: ORIGINAL_LEXICAL,
    meta: { id: 'post-1', updated_at: '2026-01-01T00:00:00.000Z' }
  });
}

test('pushDraft succeeds and refreshes local state when remote is unchanged', async () => {
  await withTmpRepo(async (repoRoot) => {
    seedLocalDraft(repoRoot, 'my-draft');
    const editCalls = [];
    const adminApi = {
      posts: {
        async read(data) {
          assert.equal(data.id, 'post-1');
          return { id: 'post-1', updated_at: '2026-01-01T00:00:00.000Z', lexical: ORIGINAL_LEXICAL };
        },
        async edit(data) {
          editCalls.push(data);
          return { id: 'post-1', updated_at: '2026-01-02T00:00:00.000Z', lexical: '{"root":{"pushed":true}}' };
        }
      }
    };

    await pushDraft(adminApi, repoRoot, 'my-draft');

    assert.equal(editCalls.length, 1);
    assert.equal(editCalls[0].id, 'post-1');
    assert.equal(editCalls[0].updated_at, '2026-01-01T00:00:00.000Z');
    assert.match(editCalls[0].lexical, /Edited body|pushed/); // converted from markdown, see note below

    const draft = readDraft(repoRoot, 'my-draft');
    assert.equal(draft.originalLexical, '{"root":{"pushed":true}}');
    assert.equal(draft.meta.updated_at, '2026-01-02T00:00:00.000Z');
  });
});

test('pushDraft aborts when the remote draft changed since last pull', async () => {
  await withTmpRepo(async (repoRoot) => {
    seedLocalDraft(repoRoot, 'my-draft');
    const adminApi = {
      posts: {
        async read() {
          return { id: 'post-1', updated_at: '2026-01-01T00:05:00.000Z', lexical: CHANGED_LEXICAL };
        },
        async edit() {
          throw new Error('edit should not be called when remote changed');
        }
      }
    };

    await assert.rejects(
      () => pushDraft(adminApi, repoRoot, 'my-draft'),
      /remote draft changed/
    );

    // local state untouched
    const draft = readDraft(repoRoot, 'my-draft');
    assert.equal(draft.originalLexical, ORIGINAL_LEXICAL);
  });
});
```

Note: the first test's `editCalls[0].lexical` assertion is loose
(`/Edited body|pushed/`) because the real `markdownToLexicalString` output
for `'Edited body'` won't literally contain "pushed" — pin it down precisely
in Step 3 below once `markdownToLexicalString` is wired in: replace that
line with `assert.match(editCalls[0].lexical, /Edited body/);`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/draft-sync && node --test test/push.test.js
```
Expected: FAIL — `src/push.js` doesn't exist.

- [ ] **Step 3: Implement push.js, and tighten the loose assertion from Step 1**

`packages/draft-sync/src/push.js`:
```js
import { readDraft, writeDraft } from './store.js';
import { markdownToLexicalString } from './convert.js';

export async function pushDraft(adminApi, repoRoot, slug) {
  const local = readDraft(repoRoot, slug);
  const remote = await adminApi.posts.read({ id: local.meta.id }, { formats: 'lexical' });

  if (remote.lexical !== local.originalLexical) {
    throw new Error(
      `remote draft changed since last pull: re-run "draft-sync pull ${slug} --force" and reapply your edits`
    );
  }

  const lexical = markdownToLexicalString(local.markdown);
  const updated = await adminApi.posts.edit(
    { id: local.meta.id, updated_at: remote.updated_at, lexical },
    { formats: 'lexical' }
  );

  writeDraft(repoRoot, slug, {
    markdown: local.markdown,
    originalLexical: updated.lexical,
    meta: { id: updated.id, updated_at: updated.updated_at }
  }, { force: true });
}
```

In `packages/draft-sync/test/push.test.js`, replace the loose assertion line
with:
```js
assert.match(editCalls[0].lexical, /Edited body/);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/draft-sync && node --test test/push.test.js
```
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add packages/draft-sync/src/push.js packages/draft-sync/test/push.test.js
git commit -m "draft-sync: push command"
```

---

### Task 7: CLI wiring

**Files:**
- Modify: `packages/draft-sync/bin/draft-sync.js`
- Test: `packages/draft-sync/test/cli.test.js`

**Interfaces:**
- Consumes: `createAdminApi` (Task 4), `pullDraft` (Task 5), `pushDraft`
  (Task 6), plus a direct `adminApi.posts.browse` call for `list`.
- Produces: the `draft-sync` executable: `list`, `pull <slug> [--force]`,
  `push <slug>`, and bare/unknown/`--help` invocations print usage to stderr
  and exit 1 without touching the network — this is what the test below
  checks without mocking the Admin API.

- [ ] **Step 1: Write the failing test (usage/exit-code behavior only — no live API calls)**

`packages/draft-sync/test/cli.test.js`:
```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'draft-sync.js');

test('no arguments prints usage and exits non-zero', async () => {
  await assert.rejects(execFileAsync('node', [CLI]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Usage: draft-sync/);
    return true;
  });
});

test('unknown command prints usage and exits non-zero', async () => {
  await assert.rejects(execFileAsync('node', [CLI, 'frobnicate']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Usage: draft-sync/);
    return true;
  });
});

test('pull without a slug prints usage and exits non-zero', async () => {
  await assert.rejects(execFileAsync('node', [CLI, 'pull']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Usage: draft-sync/);
    return true;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/draft-sync && node --test test/cli.test.js
```
Expected: FAIL — placeholder CLI from Task 1 always exits 0 and prints the
placeholder line, not usage.

- [ ] **Step 3: Implement the real CLI**

`packages/draft-sync/bin/draft-sync.js`:
```js
#!/usr/bin/env node
import { createAdminApi } from '../src/admin-api.js';
import { pullDraft } from '../src/pull.js';
import { pushDraft } from '../src/push.js';

const USAGE = `Usage: draft-sync <command> [args]

Commands:
  list                 List remote drafts (id, slug, title, updated_at)
  pull <slug> [--force]  Pull a draft to .ghost-drafts/<slug>/draft.md
  push <slug>           Push local edits back to Ghost
`;

function usageExit() {
  process.stderr.write(USAGE);
  process.exit(1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const repoRoot = process.cwd();

  if (command === 'list') {
    const api = createAdminApi();
    const { posts } = await api.posts.browse({ filter: 'status:draft', limit: 'all' });
    for (const post of posts) {
      console.log(`${post.id}\t${post.slug}\t${post.title}\t${post.updated_at}`);
    }
    return;
  }

  if (command === 'pull') {
    const slug = rest.find((arg) => !arg.startsWith('--'));
    if (!slug) {
      usageExit();
    }
    const force = rest.includes('--force');
    const api = createAdminApi();
    await pullDraft(api, repoRoot, slug, { force });
    console.log(`pulled ${slug} -> .ghost-drafts/${slug}/draft.md`);
    return;
  }

  if (command === 'push') {
    const slug = rest[0];
    if (!slug) {
      usageExit();
    }
    const api = createAdminApi();
    await pushDraft(api, repoRoot, slug);
    console.log(`pushed ${slug}`);
    return;
  }

  usageExit();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/draft-sync && node --test test/cli.test.js
```
Expected: PASS, all 3 tests.

- [ ] **Step 5: Run the full test suite for the package**

```bash
cd packages/draft-sync && node --test
```
Expected: PASS — every test file from Tasks 2-7.

- [ ] **Step 6: Commit**

```bash
git add packages/draft-sync/bin/draft-sync.js packages/draft-sync/test/cli.test.js
git commit -m "draft-sync: CLI wiring for list/pull/push"
```

---

### Task 8: Document credentials and manual verification

**Files:**
- Modify: `.local-secrets.md` (create the `draft-sync` heading if the file doesn't exist yet — it's gitignored, so check first with `ls .local-secrets.md`)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add a `draft-sync` heading to `.local-secrets.md`**

Append (creating the file if absent):
```markdown
## draft-sync

- `GHOST_ADMIN_API_URL`: <site's admin root URL>
- `GHOST_ADMIN_API_KEY`: <id>:<secret>, from Ghost Admin -> Settings ->
  Integrations -> "draft-sync" custom integration (create one if it
  doesn't exist yet).
```

- [ ] **Step 2: Manually verify against a real draft**

With both env vars exported:
```bash
node scripts/draft-sync list
node scripts/draft-sync pull <a-real-draft-slug>
vim .ghost-drafts/<slug>/draft.md   # make an edit, save
node scripts/draft-sync push <a-real-draft-slug>
```
Confirm the edit shows up in the Ghost admin UI for that draft.

- [ ] **Step 3: No commit** — `.local-secrets.md` is gitignored by repo
  convention; nothing here is tracked.

---
