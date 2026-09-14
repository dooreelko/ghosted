import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMagicLinkSmoke } from '../src/mail-smoke-test.mjs';

test('sendMagicLinkSmoke fetches an integrity token then sends the magic link', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/integrity-token/')) {
      return { ok: true, status: 200, text: async () => 'token-123' };
    }
    return { ok: true, status: 201 };
  };

  const result = await sendMagicLinkSmoke('https://x', 'robots@x.com', fetchImpl);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, 'https://x/blog/members/api/integrity-token/');
  assert.equal(calls[1].url, 'https://x/blog/members/api/send-magic-link/');
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    email: 'robots@x.com',
    emailType: 'signin',
    integrityToken: 'token-123',
    autoRedirect: false,
  });
});

test('sendMagicLinkSmoke reports failure when the integrity-token request fails', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => '' });
  const result = await sendMagicLinkSmoke('https://x', 'robots@x.com', fetchImpl);
  assert.deepEqual(result, { ok: false, step: 'integrity-token', status: 500 });
});

test('sendMagicLinkSmoke reports failure and detail when the send itself fails', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/integrity-token/')) {
      return { ok: true, status: 200, text: async () => 'token-123' };
    }
    return { ok: false, status: 400, text: async () => 'Bad Request.' };
  };
  const result = await sendMagicLinkSmoke('https://x', 'robots@x.com', fetchImpl);
  assert.deepEqual(result, { ok: false, step: 'send-magic-link', status: 400, detail: 'Bad Request.' });
});
