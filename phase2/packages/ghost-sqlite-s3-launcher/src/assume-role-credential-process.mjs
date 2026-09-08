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

// Breaks a self-recursion: this script inherits AWS_PROFILE/AWS_CONFIG_FILE/
// AWS_SDK_LOAD_CONFIG from its parent (preload.mjs), and the "ghost-phase2"
// profile's credential_process points right back at this same script. Left
// alone, every invocation would spawn a child that tries the same profile-
// based resolution, spawning another child, forever. Deleting these lets the
// SDK's default chain fall through to the container's real ambient identity
// (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI on Lightsail) instead.
delete process.env.AWS_PROFILE;
delete process.env.AWS_CONFIG_FILE;
delete process.env.AWS_SDK_LOAD_CONFIG;

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
