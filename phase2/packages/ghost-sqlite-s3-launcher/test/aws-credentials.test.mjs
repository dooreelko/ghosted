import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAwsConfigFile } from '../src/aws-credentials.mjs';

test('buildAwsConfigFile produces a valid credential_process profile block', () => {
  const content = buildAwsConfigFile({
    profileName: 'ghost-phase2',
    roleArn: 'arn:aws:iam::699571927575:role/ghost-phase2-app-runtime',
    helperScriptPath: '/home/ghost/node_modules/@ghost-phase2/ghost-sqlite-s3-launcher/src/assume-role-credential-process.mjs',
    region: 'us-east-1',
  });

  assert.match(content, /^\[profile ghost-phase2\]$/m);
  assert.match(
    content,
    /^credential_process = node \/home\/ghost\/node_modules\/@ghost-phase2\/ghost-sqlite-s3-launcher\/src\/assume-role-credential-process\.mjs arn:aws:iam::699571927575:role\/ghost-phase2-app-runtime us-east-1$/m
  );
});
