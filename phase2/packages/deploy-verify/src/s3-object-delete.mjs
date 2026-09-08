import { DeleteObjectCommand } from '@aws-sdk/client-s3';

export async function deleteS3Object(bucket, imageUrl, s3Client) {
  const { pathname } = new URL(imageUrl);
  let key = pathname.replace(/^\//, '');
  if (key.startsWith(`${bucket}/`)) {
    key = key.slice(bucket.length + 1);
  }
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
