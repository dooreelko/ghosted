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
