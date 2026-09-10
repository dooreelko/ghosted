import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateAdminToken } from '../src/admin-token.mjs';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

test('generateAdminToken produces a valid HS256 JWT with the expected claims', () => {
  const nowMs = 1_800_000_000_000; // fixed instant
  const token = generateAdminToken({ keyId: 'abc123', secretHex: 'deadbeef' }, nowMs);

  const [headerB64, payloadB64, sigB64] = token.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT', kid: 'abc123' });
  assert.equal(payload.aud, '/admin/');
  assert.equal(payload.iat, Math.floor(nowMs / 1000));
  assert.equal(payload.exp, Math.floor(nowMs / 1000) + 300);

  const expectedSig = crypto
    .createHmac('sha256', Buffer.from('deadbeef', 'hex'))
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  assert.equal(sigB64, expectedSig);
});
