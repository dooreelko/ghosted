import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  compareDatabases,
  tableRowCounts,
  contentChecksum,
  settingsMap,
  BOOT_MUTATION_ALLOWLIST,
} from '../src/db-compare.mjs';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, status TEXT, published_at TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    CREATE TABLE settings (id TEXT PRIMARY KEY, key TEXT, value TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT);
  `);
  db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p1', 'Hello', 'published', '2026-01-01');
  db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p2', 'World', 'draft', null);
  db.prepare('INSERT INTO users VALUES (?, ?, ?)').run('u1', 'Owner', 'owner@example.com');
  db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('s1', 'title', 'My Blog');
  db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('s2', 'db_hash', 'aaa');
  return db;
}

test('tableRowCounts counts every user table and skips sqlite internals', () => {
  const counts = tableRowCounts(makeDb());
  assert.equal(counts.posts, 2);
  assert.equal(counts.users, 1);
  assert.equal(counts.sessions, 0);
  assert.equal(counts.sqlite_sequence, undefined);
});

test('contentChecksum is stable across two identical databases', () => {
  assert.equal(contentChecksum(makeDb(), 'posts'), contentChecksum(makeDb(), 'posts'));
});

test('contentChecksum changes when a row changes', () => {
  const a = makeDb();
  const b = makeDb();
  b.prepare('UPDATE posts SET title = ? WHERE id = ?').run('Changed', 'p1');
  assert.notEqual(contentChecksum(a, 'posts'), contentChecksum(b, 'posts'));
});

test('contentChecksum ignores row order', () => {
  const a = makeDb();
  const b = new Database(':memory:');
  b.exec('CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, status TEXT, published_at TEXT)');
  b.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p2', 'World', 'draft', null);
  b.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p1', 'Hello', 'published', '2026-01-01');
  assert.equal(contentChecksum(a, 'posts'), contentChecksum(b, 'posts'));
});

test('settingsMap reads key/value pairs', () => {
  assert.deepEqual(settingsMap(makeDb()), { title: 'My Blog', db_hash: 'aaa' });
});

test('compareDatabases passes for two identical databases', () => {
  const result = compareDatabases({ source: makeDb(), target: makeDb() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.differences, []);
});

test('compareDatabases fails on a row-count difference in a non-allowlisted table', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('DELETE FROM posts WHERE id = ?').run('p2');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'row-count' && d.name === 'posts'));
});

test('compareDatabases allows row-count differences in allowlisted tables', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('INSERT INTO sessions VALUES (?, ?)').run('sess1', 'u1');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, true, JSON.stringify(result.differences));
});

test('compareDatabases fails on a content checksum difference', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('UPDATE posts SET title = ? WHERE id = ?').run('Tampered', 'p1');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'checksum' && d.name === 'posts'));
});

test('compareDatabases allows settings keys named in the allowlist', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('UPDATE settings SET value = ? WHERE key = ?').run('bbb', 'db_hash');

  const allowlist = { ...BOOT_MUTATION_ALLOWLIST, settingsKeys: ['db_hash'] };
  const result = compareDatabases({ source, target, allowlist });
  assert.equal(result.ok, true, JSON.stringify(result.differences));
});

test('compareDatabases fails on a settings key not named in the allowlist', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('UPDATE settings SET value = ? WHERE key = ?').run('Hijacked', 'title');

  const allowlist = { ...BOOT_MUTATION_ALLOWLIST, settingsKeys: ['db_hash'] };
  const result = compareDatabases({ source, target, allowlist });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'setting' && d.name === 'title'));
});

test('compareDatabases fails when a table exists on only one side', () => {
  const source = makeDb();
  const target = makeDb();
  target.exec('CREATE TABLE surprise (id TEXT PRIMARY KEY)');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'table-set' && d.name === 'surprise'));
});
