import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { getResourceTotal, listRecentPosts } from './admin-api-client.mjs';

const IMG_SRC = /<img[^>]+src=["']([^"']+)["']/gi;
// Matches srcset on any element (<img srcset=...> and <picture><source
// srcset=...>), since Ghost's responsive-image and gallery cards emit both.
const SRCSET = /\bsrcset=["']([^"']+)["']/gi;

export function extractImageUrls(post) {
  const urls = [];
  if (post.feature_image) urls.push(post.feature_image);
  const html = String(post.html ?? '');
  for (const match of html.matchAll(IMG_SRC)) {
    urls.push(match[1]);
  }
  for (const match of html.matchAll(SRCSET)) {
    // Each candidate is "<url> <descriptor>", comma-separated; keep the URL.
    for (const candidate of match[1].split(',')) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

/**
 * The rendered image URL and the S3 key differ only by the leading slash —
 * that 1:1 mapping is exactly why the launcher puts `blog/` into
 * staticFileURLPrefix (see ghost-sqlite-s3-launcher/src/storage-config.mjs).
 * URL paths are percent-encoded and S3 keys are not, so decode.
 */
export function imageUrlToKey(url) {
  return decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
}

/**
 * Pre-cutover image checker. The rendered URL still resolves against the
 * PHASE 1 origin at that point, where these images exist on disk — an HTTP
 * check would pass even if the S3 sync had failed entirely. Checking the
 * bucket directly is the only check that means anything before traffic moves.
 *
 * `siteHost`, when given, limits the HeadObject check to images served from
 * the blog's own host. `imageUrlToKey` ignores the URL's host entirely, so an
 * externally-hosted image (a third-party CDN embed) would otherwise have its
 * *path* mapped onto a bucket key that legitimately does not exist and get
 * reported as a false failure — noise that trains an operator to distrust (and
 * eventually override) a real one. Such URLs are reported back to the caller
 * as `'skipped'` rather than silently treated as passing or failing.
 */
export function makeS3ImageChecker({ bucket, s3Client, siteHost }) {
  return async (url) => {
    if (siteHost && new URL(url).host !== siteHost) {
      return 'skipped';
    }
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: imageUrlToKey(url) }));
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Post-cutover image checker: exercises the real CloudFront behaviour and the
 * OAC bucket policy, which the S3 checker cannot.
 */
export function makeHttpImageChecker(fetchImpl = fetch) {
  return async (url) => {
    try {
      const response = await fetchImpl(url, { method: 'GET' });
      return response.status === 200;
    } catch {
      return false;
    }
  };
}

export async function checkContent({
  adminBase,
  token,
  expected,
  imageChecker,
  postLimit = 25,
  fetchImpl = fetch,
}) {
  const differences = [];
  for (const resource of ['posts', 'users', 'tags']) {
    if (expected[resource] === undefined) continue;
    const actual = await getResourceTotal(adminBase, token, resource, fetchImpl);
    if (actual !== expected[resource]) {
      differences.push({ resource, expected: expected[resource], actual });
    }
  }

  const posts = await listRecentPosts(adminBase, token, postLimit, fetchImpl);
  // An empty post list means the image loop below runs zero times and would
  // otherwise report a silent, unearned PASS — exactly the false PASS this
  // gate exists to prevent (wrong filter, API drift, an over-scoped token,
  // postLimit walking past a differently-sorted result). The Admin API's
  // posts total is deliberately not compared elsewhere (it counts drafts),
  // so nothing else in the pipeline would have caught this.
  if (posts.length === 0) {
    differences.push({ resource: 'posts', expected: 'at least one post to check', actual: 0 });
  }

  const missingImages = [];
  const skippedExternalImages = [];
  let imagesChecked = 0;
  for (const post of posts) {
    for (const url of extractImageUrls(post)) {
      const result = await imageChecker(url);
      if (result === 'skipped') {
        skippedExternalImages.push({ postId: post.id, url });
        continue;
      }
      imagesChecked += 1;
      if (!result) {
        missingImages.push({ postId: post.id, url });
      }
    }
  }

  return {
    ok: differences.length === 0 && missingImages.length === 0,
    differences,
    missingImages,
    skippedExternalImages,
    postsChecked: posts.length,
    imagesChecked,
  };
}
