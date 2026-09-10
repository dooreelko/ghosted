#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { checkUrls } from '../src/http-smoke-test.mjs';
import { generateAdminToken } from '../src/admin-token.mjs';
import { uploadImage, createDraftPost, getPost, deletePost } from '../src/admin-api-client.mjs';
import { deleteS3Object } from '../src/s3-object-delete.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

async function main() {
  const { 'public-url': publicUrl, bucket } = parseArgs(process.argv.slice(2));
  if (!publicUrl || !bucket) {
    console.error('usage: verify.mjs --public-url <url> --bucket <bucket>');
    process.exit(1);
  }
  const adminApiKey = process.env.GHOST_ADMIN_API_KEY;
  if (!adminApiKey) {
    console.error('GHOST_ADMIN_API_KEY env var is required');
    process.exit(1);
  }
  const base = publicUrl.replace(/\/$/, '');

  const smoke = await checkUrls([`${base}/blog/`, `${base}/blog/ghost/`]);
  if (!smoke.ok) {
    console.log(JSON.stringify({ ok: false, step: 'http-smoke-test', detail: smoke.results }));
    process.exit(1);
  }

  const [keyId, secretHex] = adminApiKey.split(':');
  const token = generateAdminToken({ keyId, secretHex });
  const adminBase = `${base}/blog/ghost/api/admin`;

  let postId;
  let imageUrl;
  let roundtripFailure = null;
  try {
    const fixturePath = fileURLToPath(new URL('../fixtures/test-pixel.png', import.meta.url));
    const buffer = await readFile(fixturePath);
    const image = await uploadImage(adminBase, token, { buffer, filename: 'test-pixel.png' });
    imageUrl = image.url;

    // uploadImage writes directly to S3 under the app's own runtime role --
    // it proves nothing about whether a public visitor can read the image
    // back through CloudFront's OAC-gated bucket policy, which is a
    // separate permission entirely. Fetch the image over its real public
    // URL to close that gap (see i8hlt: a bucket-policy regression once
    // broke every image on the site while this roundtrip kept passing).
    const imageCheck = await checkUrls([imageUrl]);
    if (!imageCheck.ok) {
      throw new Error(`uploaded image is not publicly reachable through the CDN: ${JSON.stringify(imageCheck.results)}`);
    }

    const draft = await createDraftPost(adminBase, token, {
      title: `deploy-verify roundtrip ${new Date().toISOString()}`,
      featureImageUrl: imageUrl,
    });
    postId = draft.id;

    const readBack = await getPost(adminBase, token, postId);
    if (readBack.status !== 'draft') {
      throw new Error(`expected draft status, got ${readBack.status}`);
    }
  } catch (err) {
    roundtripFailure = err;
  } finally {
    if (postId) {
      await deletePost(adminBase, token, postId).catch((err) =>
        console.error(`cleanup: failed to delete test post ${postId}: ${err.message}`),
      );
    }
    if (imageUrl) {
      const s3Client = new S3Client({ region: 'us-east-1' });
      await deleteS3Object(bucket, imageUrl, s3Client).catch((err) =>
        console.error(`cleanup: failed to delete test image ${imageUrl}: ${err.message}`),
      );
    }
  }

  if (roundtripFailure) {
    console.log(JSON.stringify({ ok: false, step: 'admin-api-roundtrip', detail: roundtripFailure.message }));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true }));
}

main();
