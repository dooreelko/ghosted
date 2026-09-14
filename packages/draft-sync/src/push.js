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
