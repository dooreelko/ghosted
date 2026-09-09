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
    CREATE TABLE webhooks (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT);
  `);
  db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p1', 'Hello', 'published', '2026-01-01');
  db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p2', 'World', 'draft', null);
  db.prepare('INSERT INTO users VALUES (?, ?, ?)').run('u1', 'Owner', 'owner@example.com');
  db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('s1', 'title', 'My Blog');
  db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('s2', 'db_hash', 'aaa');
  db.prepare('INSERT INTO webhooks (event) VALUES (?)').run('post.published');
  return db;
}

test('tableRowCounts counts every user table and skips sqlite internals', () => {
  const counts = tableRowCounts(makeDb());
  assert.equal(counts.posts, 2);
  assert.equal(counts.users, 1);
  assert.equal(counts.sessions, 0);
  assert.equal(counts.webhooks, 1);
  // webhooks uses INTEGER PRIMARY KEY AUTOINCREMENT, so SQLite creates a
  // sqlite_sequence table to track it. userTables' `NOT LIKE 'sqlite_%'`
  // filter must exclude it from the comparison entirely.
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

test('contentChecksum distinguishes rows that only differ in where | or = falls across columns', () => {
  // Under the old `key=value` strings joined by `|`, these two rows serialise
  // identically even though `status` and `title` hold different values: the
  // delimiter characters inside the values shift the apparent field boundary
  // ("status=c|title=a|title=b" either way). Ghost's HTML/mobiledoc/JSON
  // columns make punctuation like this the normal case, not an edge case, so
  // the encoding must not be foolable this way. This test would fail under
  // the old encoding and is the point of the fix.
  const a = new Database(':memory:');
  const b = new Database(':memory:');
  const schema = 'CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, status TEXT, published_at TEXT)';
  a.exec(schema);
  b.exec(schema);
  a.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p1', 'b', 'c|title=a', null);
  b.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run('p1', 'a|title=b', 'c', null);

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

test('compareDatabases fails on a settings key present in source but missing in target', () => {
  const source = makeDb();
  const target = makeDb();
  target.prepare('DELETE FROM settings WHERE key = ?').run('db_hash');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'setting' && d.name === 'db_hash'));
});

test('compareDatabases fails when a table exists on only one side', () => {
  const source = makeDb();
  const target = makeDb();
  target.exec('CREATE TABLE surprise (id TEXT PRIMARY KEY)');

  const result = compareDatabases({ source, target });
  assert.equal(result.ok, false);
  assert.ok(result.differences.some((d) => d.kind === 'table-set' && d.name === 'surprise'));
});
