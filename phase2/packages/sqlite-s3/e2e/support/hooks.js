import { Before, After, BeforeAll, AfterAll, setDefaultTimeout } from '@cucumber/cucumber';
import { S3Client } from '@aws-sdk/client-s3';

// Real S3 round-trips (manifest reads/writes, segment puts) across many
// transactions, with real optimistic-concurrency retries and full-jitter
// backoff on real contention, comfortably exceed Cucumber's 5s default.
setDefaultTimeout(60_000);
import {
  CreateBucketCommand,
  PutBucketTaggingCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';

// The bucket is created ONCE for the whole feature run (not per scenario):
// the second scenario deliberately bootstraps from the database the first
// scenario left behind, so both scenarios must share one bucket. BeforeAll
// runs with no World instance, so region/client live at module scope here
// and get handed to each scenario's World via the per-scenario Before hook
// below.
const region = process.env.SQLITE_S3_E2E_REGION || 'us-east-1';
const s3Client = new S3Client({ region });
let bucketName;

// Real AWS calls, no mocking: a missing/invalid credential chain makes
// CreateBucketCommand reject, and Cucumber reports that as a failed
// hook — the suite fails loudly rather than silently skipping, per
// this suite's whole purpose (prove the real thing works end to end).
BeforeAll(async function () {
  bucketName = `sqlite-s3-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const createParams = { Bucket: bucketName };
  if (region !== 'us-east-1') {
    createParams.CreateBucketConfiguration = { LocationConstraint: region };
  }
  await s3Client.send(new CreateBucketCommand(createParams));

  await s3Client.send(
    new PutBucketTaggingCommand({
      Bucket: bucketName,
      Tagging: {
        TagSet: [
          { Key: 'purpose', Value: 'sqlite-s3-e2e-test' },
          { Key: 'throwaway', Value: 'true' },
        ],
      },
    })
  );
});

Before(function () {
  this.bucketName = bucketName;
});

After(async function () {
  // Always destroy every Knex instance a step created, even if an
  // assertion above failed — otherwise a failed scenario can leave
  // open pooled connections/file handles behind. The bucket itself
  // outlives this scenario (see BeforeAll/AfterAll above) — only the
  // per-scenario Knex instances get cleaned up here.
  await Promise.all(
    this.knexInstances.map((knex) => knex.destroy().catch(() => {}))
  );
});

AfterAll(async function () {
  if (!bucketName) return;

  // Empty the bucket (S3 refuses to delete a non-empty bucket), then
  // delete it. Best-effort: log and move on rather than failing the
  // whole run over cleanup, since the actual test assertions already
  // ran by this point.
  try {
    let continuationToken;
    do {
      const listed = await s3Client.send(
        new ListObjectsV2Command({ Bucket: bucketName, ContinuationToken: continuationToken })
      );
      const objects = listed.Contents ?? [];
      if (objects.length > 0) {
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objects.map((o) => ({ Key: o.Key })) },
          })
        );
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    await s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
  } catch (err) {
    console.error(`sqlite-s3 e2e: failed to clean up bucket ${bucketName} (leaked, delete manually):`, err);
  }
});
