import { draftExists, writeDraft } from './store.js';
import { lexicalToMarkdown } from './convert.js';

const PLAIN_PROSE_NODE_TYPES = new Set(['paragraph', 'heading', 'quote', 'list', 'linebreak']);

export function warnIfRichContent(slug, lexicalString) {
  let parsed;
  try {
    parsed = JSON.parse(lexicalString);
  } catch {
    return;
  }
  const children = parsed?.root?.children;
  if (!Array.isArray(children)) {
    return;
  }
  const hasRichContent = children.some((child) => !PLAIN_PROSE_NODE_TYPES.has(child?.type));
  if (hasRichContent) {
    process.stderr.write(
      `Warning: draft "${slug}" contains rich content (cards/embeds/images) that may not survive the markdown round-trip intact.\n`
    );
  }
}

export async function pullDraft(adminApi, repoRoot, slug, { force = false } = {}) {
  if (draftExists(repoRoot, slug) && !force) {
    throw new Error(`draft exists: .ghost-drafts/${slug} (pass force to overwrite)`);
  }
  const post = await adminApi.posts.read({ slug }, { formats: 'lexical' });
  if (!post.lexical) {
    throw new Error(`draft ${slug} has no lexical content (mobiledoc-only post?)`);
  }
  warnIfRichContent(slug, post.lexical);
  const markdown = await lexicalToMarkdown(post.lexical);
  writeDraft(repoRoot, slug, {
    markdown,
    originalLexical: post.lexical,
    meta: { id: post.id, updated_at: post.updated_at }
  }, { force: true });
}

/**
 * Pulls every remote draft. A single draft's failure (e.g. an existing
 * local copy without --force) doesn't abort the rest -- each is reported
 * in the returned per-slug results instead.
 */
export async function pullAllDrafts(adminApi, repoRoot, { force = false } = {}) {
  const posts = await adminApi.posts.browse({ filter: 'status:draft', limit: 'all' });
  const results = [];
  for (const post of posts) {
    try {
      await pullDraft(adminApi, repoRoot, post.slug, { force });
      results.push({ slug: post.slug, ok: true });
    } catch (err) {
      results.push({ slug: post.slug, ok: false, error: err.message });
    }
  }
  return results;
}
