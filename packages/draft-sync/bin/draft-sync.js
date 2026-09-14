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

function firstNonFlagArg(args) {
  return args.find((arg) => !arg.startsWith('--'));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const repoRoot = process.cwd();

  if (command === 'list') {
    const api = createAdminApi();
    const posts = await api.posts.browse({ filter: 'status:draft', limit: 'all' });
    for (const post of posts) {
      console.log(`${post.id}\t${post.slug}\t${post.title}\t${post.updated_at}`);
    }
    return;
  }

  if (command === 'pull') {
    const slug = firstNonFlagArg(rest);
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
    const slug = firstNonFlagArg(rest);
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
