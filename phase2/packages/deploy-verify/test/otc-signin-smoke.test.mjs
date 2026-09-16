import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { hotp } from 'otplib';
import crypto from 'node:crypto';
import { verifyOtcSignInSmoke } from '../src/otc-signin-smoke.mjs';

const OTC_REF = 'a1b2c3d4-0000-0000-0000-000000000000';
const TOKEN_VALUE = 'some-random-token-value';
const SECRET_HEX = crypto.randomBytes(20).toString('hex');

function expectedOtc() {
  const digest = crypto.createHash('sha256').update(`${OTC_REF}|${TOKEN_VALUE}`).digest();
  return hotp.generate(SECRET_HEX, digest.readUInt32BE(0));
}

// Writes a real, tiny SQLite file with just the two tables/rows the flow
// reads from -- stands in for a live S3 dump so this test exercises actual
// SQL reads, not a mocked object.
function fakeDumpDb({ dbPath }) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tokens (id TEXT PRIMARY KEY, token TEXT, uuid TEXT);
    CREATE TABLE settings (id TEXT PRIMARY KEY, key TEXT, value TEXT);
  `);
  db.prepare('INSERT INTO tokens VALUES (?, ?, ?)').run('t1', TOKEN_VALUE, OTC_REF);
  db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('s1', 'members_otc_secret', SECRET_HEX);
  db.close();
}

function makeFetchImpl({ verifyOtcHandler } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/integrity-token/')) {
      return { ok: true, status: 200, text: async () => 'itoken' };
    }
    if (url.endsWith('/send-magic-link/')) {
      return { ok: true, status: 201, json: async () => ({ otc_ref: OTC_REF }) };
    }
    if (url.endsWith('/verify-otc/')) {
      if (verifyOtcHandler) return verifyOtcHandler(url, options, calls);
      const body = JSON.parse(options.body);
      assert.equal(body.otc, expectedOtc(), 'derived otc must match what Ghost would have generated');
      assert.equal(body.otcRef, OTC_REF);
      return { ok: true, status: 200, json: async () => ({ redirectUrl: 'https://x/blog/members/?token=abc&action=signin' }) };
    }
    if (url.includes('/members/?token=')) {
      return { ok: true, status: 200, headers: { get: (h) => (h === 'set-cookie' ? 'ghost-members-ssr=abc' : undefined) } };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  return { fetchImpl, calls };
}

test('verifyOtcSignInSmoke completes the full 6-digit-code flow and derives the correct code', async () => {
  const { fetchImpl } = makeFetchImpl();
  const result = await verifyOtcSignInSmoke('https://x', 'robots@x.com', { bucket: 'irrelevant' }, fetchImpl, fakeDumpDb);
  assert.deepEqual(result, { ok: true });
});

test('verifyOtcSignInSmoke reports failure when send-magic-link response has no otc_ref', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/integrity-token/')) return { ok: true, status: 200, text: async () => 'itoken' };
    if (url.endsWith('/send-magic-link/')) return { ok: true, status: 201, json: async () => ({}) };
    throw new Error(`unexpected fetch to ${url}`);
  };
  const result = await verifyOtcSignInSmoke('https://x', 'robots@x.com', { bucket: 'irrelevant' }, fetchImpl, fakeDumpDb);
  assert.equal(result.ok, false);
  assert.equal(result.step, 'send-magic-link');
});

test('verifyOtcSignInSmoke reports a structured failure when the DB dump itself throws', async () => {
  const { fetchImpl } = makeFetchImpl();
  const throwingDumpDb = async () => {
    throw new Error('S3 manifest read failed');
  };
  const result = await verifyOtcSignInSmoke('https://x', 'robots@x.com', { bucket: 'irrelevant' }, fetchImpl, throwingDumpDb);
  assert.deepEqual(result, { ok: false, step: 'db-dump', detail: 'S3 manifest read failed' });
});

test('verifyOtcSignInSmoke reports failure when the tokens row is missing for otc_ref', async () => {
  const { fetchImpl } = makeFetchImpl();
  const emptyDumpDb = ({ dbPath }) => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE tokens (id TEXT PRIMARY KEY, token TEXT, uuid TEXT); CREATE TABLE settings (id TEXT PRIMARY KEY, key TEXT, value TEXT);');
    db.close();
  };
  const result = await verifyOtcSignInSmoke('https://x', 'robots@x.com', { bucket: 'irrelevant' }, fetchImpl, emptyDumpDb);
  assert.equal(result.ok, false);
  assert.equal(result.step, 'db-read');
});

test('verifyOtcSignInSmoke reports failure when members_otc_secret is missing', async () => {
  const { fetchImpl } = makeFetchImpl();
  const noSecretDumpDb = ({ dbPath }) => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE tokens (id TEXT PRIMARY KEY, token TEXT, uuid TEXT); CREATE TABLE settings (id TEXT PRIMARY KEY, key TEXT, value TEXT);');
    db.prepare('INSERT INTO tokens VALUES (?, ?, ?)').run('t1', TOKEN_VALUE, OTC_REF);
    db.close();
  };
  const result = await verifyOtcSignInSmoke('https://x', 'robots@x.com', { bucket: 'irrelevant' }, fetchImpl, noSecretDumpDb);
  assert.equal(result.ok, false);
  assert.equal(result.step, 'db-read');
});

test('verifyOtcSignInSmoke reports failure when verify-otc rejects the derived code', async () => {
  const { fetchImpl } = makeFetchImpl({
    verifyOtcHandler: async () => ({ ok: false, status: 400, text: async () => 'INVALID_OTC' }),
  });
  const result = await verifyOtcSignInSmoke('https://x', 'robots@x.com', { bucket: 'irrelevant' }, fetchImpl, fakeDumpDb);
  assert.equal(result.ok, false);
  assert.equal(result.step, 'verify-otc');
});

test('verifyOtcSignInSmoke reports failure when the signin redirect sets no session cookie', async () => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/integrity-token/')) return { ok: true, status: 200, text: async () => 'itoken' };
    if (url.endsWith('/send-magic-link/')) return { ok: true, status: 201, json: async () => ({ otc_ref: OTC_REF }) };
    if (url.endsWith('/verify-otc/')) return { ok: true, status: 200, json: async () => ({ redirectUrl: 'https://x/blog/members/?token=abc&action=signin' }) };
    if (url.includes('/members/?token=')) return { ok: true, status: 200, headers: { get: () => undefined } };
    throw new Error(`unexpected fetch to ${url}`);
  };
  const result = await verifyOtcSignInSmoke('https://x', 'robots@x.com', { bucket: 'irrelevant' }, fetchImpl, fakeDumpDb);
  assert.equal(result.ok, false);
  assert.equal(result.step, 'signin-redirect');
});
