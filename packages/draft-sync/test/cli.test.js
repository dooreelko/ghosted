import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'draft-sync.js');

test('no arguments prints usage and exits non-zero', async () => {
  await assert.rejects(execFileAsync('node', [CLI]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Usage: draft-sync/);
    return true;
  });
});

test('unknown command prints usage and exits non-zero', async () => {
  await assert.rejects(execFileAsync('node', [CLI, 'frobnicate']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Usage: draft-sync/);
    return true;
  });
});

test('pull without a slug attempts to pull all drafts (fails here on missing admin API env vars, not usage)', async () => {
  await assert.rejects(execFileAsync('node', [CLI, 'pull'], { env: { PATH: process.env.PATH } }), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /GHOST_ADMIN_API_URL/);
    return true;
  });
});
