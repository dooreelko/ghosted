import fs from 'node:fs';
import path from 'node:path';

/**
 * INI content for an AWS CLI/SDK config file with one `credential_process`
 * profile. Every AWS SDK v3 client that resolves credentials via the default
 * chain (no explicit `credentials` option — this is deliberate, see
 * preload.mjs) with AWS_SDK_LOAD_CONFIG=1 and AWS_PROFILE set to this
 * profile's name will call `helperScriptPath` itself, independently, whenever
 * its own cached token nears the Expiration it printed last time. One
 * mechanism covers every client, including ones this codebase doesn't
 * construct itself (Ghost's own S3Storage adapter).
 */
export function buildAwsConfigFile({ profileName, roleArn, helperScriptPath, region }) {
  return `[profile ${profileName}]\ncredential_process = node ${helperScriptPath} ${roleArn} ${region}\n`;
}

export function writeCredentialProcessProfile({ configPath, profileName, roleArn, helperScriptPath, region }) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, buildAwsConfigFile({ profileName, roleArn, helperScriptPath, region }));
}
