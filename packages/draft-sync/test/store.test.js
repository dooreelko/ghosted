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
