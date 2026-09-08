// Invoked by the AWS SDK's credential_process resolver (see aws-credentials.mjs)
// as: node assume-role-credential-process.mjs <roleArn> <region>. Must print
// AWS CLI's standard credential_process JSON shape to stdout and exit 0, or
// exit non-zero on failure (the SDK surfaces stderr/exit code as the
// resolution error). The region is required explicitly — this process runs
// outside the SDK's own client construction, so there's no ambient
// AWS_REGION/AWS_DEFAULT_REGION to fall back on, and an unregioned STSClient
// throws "Region is missing" immediately.
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

const roleArn = process.argv[2];
const region = process.argv[3];
if (!roleArn || !region) {
  console.error('usage: assume-role-credential-process.mjs <roleArn> <region>');
  process.exit(1);
}

const sts = new STSClient({ region });
const result = await sts.send(
  new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'ghost-phase2-launcher',
  })
);

const creds = result.Credentials;
process.stdout.write(
  JSON.stringify({
    Version: 1,
    AccessKeyId: creds.AccessKeyId,
    SecretAccessKey: creds.SecretAccessKey,
    SessionToken: creds.SessionToken,
    Expiration: creds.Expiration.toISOString(),
  }) + '\n'
);
