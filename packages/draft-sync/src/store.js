import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function draftDir(repoRoot, slug) {
  if (/[/\\]/.test(slug) || slug === '.' || slug === '..') {
    throw new Error(`invalid slug: ${slug}`);
  }
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
