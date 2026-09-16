import crypto from 'node:crypto';
import { hotp } from 'otplib';

/**
 * Reproduces Ghost core's SingleUseTokenProvider#deriveOTC exactly
 * (core/server/services/members/single-use-token-provider.js) so a
 * post-deploy check can derive the same 6-digit sign-in code Ghost emailed,
 * without ever reading the inbox. The OTC itself is never stored anywhere --
 * only the token row (uuid, token) and the members_otc_secret setting are,
 * and both of those are readable straight from the database.
 *
 * package.json pins `otplib` to the exact version Ghost core uses
 * (`ghost/core/package.json`) -- HOTP output is defined by the library's
 * default digit count/algorithm, and a version drift here would silently
 * derive a code Ghost's own verifyOTC rejects.
 */
export function deriveOTC(secretHex, tokenId, tokenValue) {
  const msg = `${tokenId}|${tokenValue}`;
  const digest = crypto.createHash('sha256').update(msg).digest();
  const counter = digest.readUInt32BE(0);
  return hotp.generate(secretHex, counter);
}
