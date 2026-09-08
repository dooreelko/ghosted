import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMailConfig } from '../src/mail-config.mjs';

test('buildMailConfig produces Ghost SMTP transport config', () => {
  const result = buildMailConfig({ user: 'robots@the-well-architected-cloud.com', pass: 'secret-token' });

  assert.deepEqual(result, {
    transport: 'SMTP',
    options: {
      service: 'ProtonMail',
      host: 'smtp.protonmail.ch',
      port: 587,
      secure: false,
      auth: {
        user: 'robots@the-well-architected-cloud.com',
        pass: 'secret-token',
      },
    },
  });
});
