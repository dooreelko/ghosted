import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushDraft } from '../src/push.js';
import { writeDraft, readDraft } from '../src/store.js';

const ORIGINAL_LEXICAL = '{"root":{"type":"root","version":"orig"}}';
const CHANGED_LEXICAL = '{"root":{"type":"root","version":"changed-on-remote"}}';

async function withTmpRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'draft-sync-test-'));
  try {
    return await fn(repoRoot);
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
    assert.match(editCalls[0].lexical, /Edited body/);

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
