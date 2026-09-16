import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hotp } from 'otplib';
import { deriveOTC } from '../src/otc-derive.mjs';

test('deriveOTC reproduces the exact counter/HOTP derivation Ghost core uses', () => {
  const secretHex = crypto.randomBytes(20).toString('hex');
  const tokenId = 'a1b2c3d4-0000-0000-0000-000000000000';
  const tokenValue = 'some-random-token-value';

  // Independently recompute what Ghost's SingleUseTokenProvider#deriveOTC does,
  // from the algorithm description, not by importing Ghost core -- proves this
  // module matches the spec, not just itself.
  const msg = `${tokenId}|${tokenValue}`;
  const digest = crypto.createHash('sha256').update(msg).digest();
  const counter = digest.readUInt32BE(0);
  const expected = hotp.generate(secretHex, counter);

  assert.equal(deriveOTC(secretHex, tokenId, tokenValue), expected);
});

test('deriveOTC is deterministic for the same inputs', () => {
  const secretHex = crypto.randomBytes(20).toString('hex');
  const a = deriveOTC(secretHex, 'id-1', 'token-1');
  const b = deriveOTC(secretHex, 'id-1', 'token-1');
  assert.equal(a, b);
});

test('deriveOTC produces a different code for a different token id', () => {
  const secretHex = crypto.randomBytes(20).toString('hex');
  const a = deriveOTC(secretHex, 'id-1', 'token-1');
  const b = deriveOTC(secretHex, 'id-2', 'token-1');
  assert.notEqual(a, b);
});
