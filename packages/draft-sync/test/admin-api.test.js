import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminApi } from '../src/admin-api.js';

test('throws when GHOST_ADMIN_API_URL is missing', () => {
  assert.throws(
    () => createAdminApi({ GHOST_ADMIN_API_KEY: '000000000000000000000000:' + '0'.repeat(64) }),
    /GHOST_ADMIN_API_URL/
  );
});

test('throws when GHOST_ADMIN_API_KEY is missing', () => {
  assert.throws(
    () => createAdminApi({ GHOST_ADMIN_API_URL: 'https://example.com' }),
    /GHOST_ADMIN_API_KEY/
  );
});

test('returns a client with posts.read/browse/edit when both env vars are set', () => {
  const api = createAdminApi({
    GHOST_ADMIN_API_URL: 'https://example.com',
    GHOST_ADMIN_API_KEY: '000000000000000000000000:' + '0'.repeat(64)
  });
  assert.equal(typeof api.posts.read, 'function');
  assert.equal(typeof api.posts.browse, 'function');
  assert.equal(typeof api.posts.edit, 'function');
});
