#!/usr/bin/env node
// The migration gate. Runs before any traffic moves, and again after.
//
//   GHOST_ADMIN_API_KEY=<id:secret> node bin/validate-migration.mjs \
//     --source-db ./.instance-backups/<ts>.db \
//     --target-db ./.instance-backups/<ts>-post-boot.db \
//     --public-url https://<lightsail service url> \
//     --bucket <data bucket> \
//     [--image-check s3|http]
//
// --image-check s3 (the default) heads the data bucket directly: before the
// cutover the rendered image URL still resolves against the PHASE 1 origin,
// so an HTTP check would pass even with a completely failed image sync. Use
// --image-check http for the post-cutover re-validation on the real domain.
//
// Exits non-zero on any difference. The visual checks are printed for a human
// at the end; they are not automated.
import Database from 'better-sqlite3';
import { S3Client } from '@aws-sdk/client-s3';
import { compareDatabases, BOOT_MUTATION_ALLOWLIST } from '../src/db-compare.mjs';
import { generateAdminToken } from '../src/admin-token.mjs';
import { makeS3ImageChecker, makeHttpImageChecker, checkContent } from '../src/content-check.mjs';

const USAGE =
  'usage: validate-migration.mjs --source-db <file> --target-db <file> --public-url <url> --bucket <bucket> [--image-check s3|http] [--region <region>]';

const KNOWN_FLAGS = new Set([
  'source-db',
  'target-db',
  'public-url',
  'bucket',
  'image-check',
  'region',
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      throw new Error(`expected a --flag, got: ${raw}`);
    }
    const flag = raw.replace(/^--/, '');
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`unknown flag: --${flag}`);
    }
    args[flag] = argv[i + 1];
  }
  return args;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(1);
  }
  const {
    'source-db': sourceDbPath,
    'target-db': targetDbPath,
    'public-url': publicUrl,
    bucket,
    'image-check': imageCheck = 's3',
    region = 'us-east-1',
  } = parsed;

  if (!sourceDbPath || !targetDbPath || !publicUrl || !bucket) {
    console.error(USAGE);
    process.exit(1);
  }
  if (imageCheck !== 's3' && imageCheck !== 'http') {
    console.error(`--image-check must be "s3" or "http", got: ${imageCheck}`);
    console.error(USAGE);
    process.exit(1);
  }
  const adminApiKey = process.env.GHOST_ADMIN_API_KEY;
  if (!adminApiKey) {
    console.error('GHOST_ADMIN_API_KEY env var is required');
    process.exit(1);
  }

  const source = new Database(sourceDbPath, { readonly: true });
  const target = new Database(targetDbPath, { readonly: true });

  let dbResult;
  let expected;
  try {
    console.log('== database comparison ==');
    dbResult = compareDatabases({ source, target, allowlist: BOOT_MUTATION_ALLOWLIST });
    if (dbResult.ok) {
      console.log('ok: no differences outside the boot-mutation allowlist');
    } else {
      for (const d of dbResult.differences) {
        console.log(`DIFF ${d.kind} ${d.name}: ${d.detail}`);
      }
    }

    // The Admin API's *unfiltered* post total includes drafts, and matching
    // it from SQL would mean replicating Ghost's exact filter — that was
    // rejected. What replaced it: a *filtered* published-post count,
    // compared against the Admin API rather than skipped. This is the only
    // comparison in the whole gate that checks what Ghost is actually
    // serving instead of the store dump — if Ghost failed to restore from
    // the store and booted a fresh, empty database without ever writing
    // back, the dump comparison above still equals the source (both are
    // empty-vs-empty or whatever the store happened to hold), but this count
    // would not. Ghost 5+ keeps pages in the same `posts` table as posts, so
    // `type = 'post'` is needed alongside `status = 'published'` or a
    // published page count would inflate the source side. Users and tags
    // have no such ambiguity and stay unfiltered.
    expected = {
      posts: source
        .prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'published' AND type = 'post'")
        .get().n,
      users: source.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      tags: source.prepare('SELECT COUNT(*) AS n FROM tags').get().n,
    };
  } finally {
    source.close();
    target.close();
  }

  const base = publicUrl.replace(/\/$/, '');
  const [keyId, secretHex] = adminApiKey.split(':');
  const token = generateAdminToken({ keyId, secretHex });

  // Deliberately not derived from --public-url: pre-cutover, --public-url is
  // the Lightsail service's own auto-generated URL, while every image URL
  // Ghost renders is under the real site domain (GHOST_URL) on every boot,
  // pre- and post-cutover alike. makeS3ImageChecker matches on path prefix,
  // not host, for exactly that reason — see its doc comment.
  const imageChecker =
    imageCheck === 'http'
      ? makeHttpImageChecker()
      : makeS3ImageChecker({ bucket, s3Client: new S3Client({ region }) });

  console.log(`== content check (images via ${imageCheck}) ==`);
  const contentResult = await checkContent({
    adminBase: `${base}/blog/ghost/api/admin`,
    token,
    expected,
    imageChecker,
    filters: { posts: 'status:published+type:post' },
  });
  if (contentResult.ok) {
    console.log(
      `ok: post/user/tag counts match, every image on the recent posts resolves ` +
        `(checked ${contentResult.postsChecked} posts, ${contentResult.imagesChecked} images)`
    );
  } else {
    for (const d of contentResult.differences) {
      console.log(`DIFF count ${d.resource}: expected ${d.expected}, got ${d.actual}`);
    }
    for (const m of contentResult.missingImages) {
      console.log(`MISSING image on post ${m.postId}: ${m.url}`);
    }
  }
  if (contentResult.unparseableImages.length > 0) {
    console.log('== unparseable image URLs (could not even be checked) ==');
    for (const u of contentResult.unparseableImages) {
      console.log(`  UNPARSEABLE on post ${u.postId}: ${u.url} (${u.error})`);
    }
  }
  if (contentResult.skippedExternalImages.length > 0) {
    console.log('== externally-hosted images (not checked against the bucket) ==');
    for (const s of contentResult.skippedExternalImages) {
      console.log(`  SKIPPED on post ${s.postId}: ${s.url}`);
    }
  }

  console.log('== visual check (human) ==');
  console.log(`  home:  ${base}/blog/`);
  console.log(`  admin: ${base}/blog/ghost/`);
  console.log('  open a recent post with images and confirm they render');

  if (!dbResult.ok || !contentResult.ok) {
    console.error('VALIDATION FAILED — do not move traffic');
    process.exit(1);
  }
  console.log('VALIDATION PASSED');
}

main().catch((err) => {
  console.error(`validation failed to run: ${err.message}`);
  process.exit(1);
});
