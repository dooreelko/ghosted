import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullDraft, pullAllDrafts } from '../src/pull.js';
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

function fakeAdminApiForSlugs(postsBySlug) {
  return {
    posts: {
      async browse() {
        return Object.values(postsBySlug);
      },
      async read(data) {
        const post = postsBySlug[data.slug];
        if (!post) throw new Error(`no such post: ${data.slug}`);
        return post;
      }
    }
  };
}

async function withTmpRepo(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'draft-sync-test-'));
  try {
    return await fn(repoRoot);
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

test('pullDraft rejects when the remote post has no lexical content', async () => {
  await withTmpRepo(async (repoRoot) => {
    const adminApi = fakeAdminApi({ lexical: null });
    await assert.rejects(
      () => pullDraft(adminApi, repoRoot, 'my-draft'),
      /draft my-draft has no lexical content \(mobiledoc-only post\?\)/
    );
  });
});

test('pullDraft warns on stderr when the draft contains rich content (cards/embeds/images)', async () => {
  await withTmpRepo(async (repoRoot) => {
    const richLexical = JSON.stringify({
      root: {
        children: [
          {
            children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: 'Draft body', type: 'text', version: 1 }],
            direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1
          },
          { type: 'image', version: 1, src: 'https://example.com/a.png', caption: '' }
        ],
        direction: 'ltr', format: '', indent: 0, type: 'root', version: 1
      }
    });

    let stderrOutput = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk;
      return true;
    };
    try {
      await pullDraft(fakeAdminApi({ lexical: richLexical }), repoRoot, 'my-draft');
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.match(stderrOutput, /contains rich content \(cards\/embeds\/images\)/);
    assert.match(stderrOutput, /my-draft/);
  });
});

test('pullAllDrafts pulls every remote draft', async () => {
  await withTmpRepo(async (repoRoot) => {
    const api = fakeAdminApiForSlugs({
      'draft-a': { id: 'a', slug: 'draft-a', updated_at: '2026-01-01T00:00:00.000Z', lexical: FIXTURE_LEXICAL },
      'draft-b': { id: 'b', slug: 'draft-b', updated_at: '2026-01-02T00:00:00.000Z', lexical: FIXTURE_LEXICAL }
    });
    const results = await pullAllDrafts(api, repoRoot);
    assert.deepEqual(results, [
      { slug: 'draft-a', ok: true },
      { slug: 'draft-b', ok: true }
    ]);
    assert.match(readDraft(repoRoot, 'draft-a').markdown, /Draft body/);
    assert.match(readDraft(repoRoot, 'draft-b').markdown, /Draft body/);
  });
});

test('pullAllDrafts reports a per-draft failure without aborting the rest', async () => {
  await withTmpRepo(async (repoRoot) => {
    const api = fakeAdminApiForSlugs({
      'draft-a': { id: 'a', slug: 'draft-a', updated_at: '2026-01-01T00:00:00.000Z', lexical: null },
      'draft-b': { id: 'b', slug: 'draft-b', updated_at: '2026-01-02T00:00:00.000Z', lexical: FIXTURE_LEXICAL }
    });
    const results = await pullAllDrafts(api, repoRoot);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /has no lexical content/);
    assert.deepEqual(results[1], { slug: 'draft-b', ok: true });
    assert.match(readDraft(repoRoot, 'draft-b').markdown, /Draft body/);
  });
});
