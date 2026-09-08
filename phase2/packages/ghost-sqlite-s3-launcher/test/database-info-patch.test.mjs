import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findDatabaseInfoPaths } from '../src/database-info-patch.mjs';

test('findDatabaseInfoPaths finds every @tryghost/database-info copy under .pnpm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbinfo-test-'));
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  const versionDirs = [
    '@tryghost+database-info@0.3.35',
    '@tryghost+database-info@2.3.12',
    'some-other-package@1.0.0',
  ];
  for (const dir of versionDirs) {
    const target = path.join(pnpmDir, dir, 'node_modules', '@tryghost', 'database-info');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'index.js'), 'module.exports = {};');
  }

  const found = findDatabaseInfoPaths(root);

  assert.equal(found.length, 2);
  assert.ok(found.every((p) => p.endsWith('database-info/index.js')));
  assert.ok(found.some((p) => p.includes('0.3.35')));
  assert.ok(found.some((p) => p.includes('2.3.12')));
});

test('findDatabaseInfoPaths returns empty array when .pnpm is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbinfo-test-empty-'));
  assert.deepEqual(findDatabaseInfoPaths(root), []);
});
