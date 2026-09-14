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
