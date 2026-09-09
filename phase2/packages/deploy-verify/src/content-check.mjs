import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { getResourceTotal, listRecentPosts } from './admin-api-client.mjs';

const IMG_SRC = /<img[^>]+src=["']([^"']+)["']/gi;

export function extractImageUrls(post) {
  const urls = [];
  if (post.feature_image) urls.push(post.feature_image);
  for (const match of String(post.html ?? '').matchAll(IMG_SRC)) {
    urls.push(match[1]);
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
 */
export function makeS3ImageChecker({ bucket, s3Client }) {
  return async (url) => {
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
  const missingImages = [];
  for (const post of posts) {
    for (const url of extractImageUrls(post)) {
      if (!(await imageChecker(url))) {
        missingImages.push({ postId: post.id, url });
      }
    }
  }

  return { ok: differences.length === 0 && missingImages.length === 0, differences, missingImages };
}
