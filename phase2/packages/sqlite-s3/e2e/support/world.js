import { setWorldConstructor, World } from '@cucumber/cucumber';
import { S3Client } from '@aws-sdk/client-s3';

// Shared state across steps for one scenario: bucket identity, the S3
// client used to create/tear it down, and whichever Knex instances a
// step spins up (tracked so an After hook can always destroy() them,
// even if an assertion fails mid-scenario).
export class SqliteS3World extends World {
  constructor(options) {
    super(options);
    this.bucketName = null;
    this.region = process.env.SQLITE_S3_E2E_REGION || 'us-east-1';
    this.s3Client = new S3Client({ region: this.region });
    this.knexInstances = [];
  }

  trackKnex(knex) {
    this.knexInstances.push(knex);
    return knex;
  }
}

setWorldConstructor(SqliteS3World);
