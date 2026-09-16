import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { S3Client } from '@aws-sdk/client-s3';
import {
  createS3ObjectStore,
  createManifestStore,
  createSegmentStore,
  createLeaseStore,
  dumpStoreToSqliteFile,
} from '@ghost-phase2/sqlite-s3';
import { deriveOTC } from './otc-derive.mjs';

/**
 * End-to-end sign-in smoke test via the 6-digit one-time-code path -- the
 * exact flow that froze in the moth s0f42 incident (magic-link email -> code
 * entry -> verify-otc -> redirect). sendMagicLinkSmoke (mail-smoke-test.mjs)
 * only proves the email SEND was accepted; this proves a member can actually
 * complete sign-in with the code Ghost would have emailed them, without
 * reading any inbox -- the code is derived from the DB-stored token row plus
 * the members_otc_secret setting, via the same HOTP algorithm Ghost core
 * itself uses (see otc-derive.mjs).
 */
// Default dump implementation: materialise the live S3-backed store into a
// local SQLite file. Injectable so tests can substitute a fixture writer and
// exercise the rest of this flow (otc-ref correlation, HOTP derivation,
// verify-otc, signin-redirect) without touching real S3.
async function dumpLiveDb({ bucket, region, dbPath }) {
  const objectStore = createS3ObjectStore({ bucket, client: new S3Client({ region }) });
  const manifestStore = createManifestStore(objectStore);
  const segmentStore = createSegmentStore(objectStore);
  const leaseStore = createLeaseStore(objectStore);
  await dumpStoreToSqliteFile({ manifestStore, segmentStore, leaseStore, dbPath });
}

export async function verifyOtcSignInSmoke(
  base,
  email,
  { bucket, region = 'us-east-1' },
  fetchImpl = fetch,
  dumpDb = dumpLiveDb,
) {
  const tokenResponse = await fetchImpl(`${base}/blog/members/api/integrity-token/`);
  if (!tokenResponse.ok) {
    return { ok: false, step: 'integrity-token', status: tokenResponse.status };
  }
  const integrityToken = await tokenResponse.text();

  const sendResponse = await fetchImpl(`${base}/blog/members/api/send-magic-link/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, emailType: 'signin', integrityToken, autoRedirect: false }),
  });
  if (!sendResponse.ok) {
    const detail = await sendResponse.text().catch(() => '');
    return { ok: false, step: 'send-magic-link', status: sendResponse.status, detail };
  }
  const sendBody = await sendResponse.json().catch(() => ({}));
  const otcRef = sendBody.otc_ref;
  if (!otcRef) {
    return { ok: false, step: 'send-magic-link', detail: 'response had no otc_ref' };
  }

  let tmpDir;
  let otc;
  try {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'deploy-verify-otc-'));
    const dbPath = path.join(tmpDir, 'ghost.db');
    await dumpDb({ bucket, region, dbPath });

    const db = new Database(dbPath, { readonly: true });
    try {
      const tokenRow = db.prepare('SELECT token FROM tokens WHERE uuid = ?').get(otcRef);
      if (!tokenRow) {
        return { ok: false, step: 'db-read', detail: `no tokens row found for otc_ref ${otcRef}` };
      }
      const secretRow = db.prepare("SELECT value FROM settings WHERE key = 'members_otc_secret'").get();
      if (!secretRow?.value) {
        return { ok: false, step: 'db-read', detail: 'members_otc_secret setting not found' };
      }
      otc = deriveOTC(secretRow.value, otcRef, tokenRow.token);
    } finally {
      db.close();
    }
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const verifyResponse = await fetchImpl(`${base}/blog/members/api/verify-otc/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otc, otcRef }),
  });
  if (!verifyResponse.ok) {
    const detail = await verifyResponse.text().catch(() => '');
    return { ok: false, step: 'verify-otc', status: verifyResponse.status, detail };
  }
  const verifyBody = await verifyResponse.json().catch(() => ({}));
  const redirectUrl = verifyBody.redirectUrl;
  if (!redirectUrl) {
    return { ok: false, step: 'verify-otc', detail: 'response had no redirectUrl' };
  }

  // Hitting the redirect URL is what actually completes sign-in (sets the
  // member session cookie) -- verify-otc alone only proves the code was
  // accepted, not that the resulting session establishes. Ghost's own
  // members frontend handles this token GET directly (200, not a 3xx --
  // confirmed against the real incident's own access logs), so a plain
  // fetch is enough; no redirect-following needed.
  const signinResponse = await fetchImpl(redirectUrl);
  if (!signinResponse.ok) {
    return { ok: false, step: 'signin-redirect', status: signinResponse.status };
  }
  const setCookie = signinResponse.headers?.get?.('set-cookie') ?? signinResponse.headers?.['set-cookie'];
  if (!setCookie) {
    return { ok: false, step: 'signin-redirect', detail: 'no member session cookie set' };
  }

  return { ok: true };
}
