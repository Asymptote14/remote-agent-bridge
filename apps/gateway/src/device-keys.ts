import { createPublicKey, randomBytes, verify } from 'node:crypto';

/**
 * Device identity keys.
 *
 * A device proves who it is by signing a per-connection nonce with an Ed25519
 * private key that never leaves the computer. The Gateway stores only the
 * public half, so stealing `state.json` no longer yields credentials that can
 * impersonate the device — which is exactly what the old bearer token allowed.
 */

/** How long a challenge stays valid. Short enough to bound replay surface. */
export const CHALLENGE_TTL_MS = 2 * 60_000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Accept only a syntactically valid Ed25519 SPKI key. Returns the normalised
 * base64 form so the stored value and later comparisons are byte-stable.
 */
export function normalizePublicKey(value: unknown): string | undefined {
  const encoded = String(value ?? '').trim();
  if (encoded.length < 32 || encoded.length > 512 || !BASE64.test(encoded)) return undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return undefined;
    return encoded;
  } catch {
    return undefined;
  }
}

/**
 * Ed25519 signs the message directly, so there is no digest algorithm to pass
 * (the `null` argument). Anything malformed or non-Ed25519 is simply false.
 */
export function verifyDeviceSignature(nonce: string, publicKey: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(nonce, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** One challenge per connection, single use, expiring. */
export function issueChallenge(): { nonce: string; expires_at: number } {
  return { nonce: randomBytes(32).toString('base64'), expires_at: Date.now() + CHALLENGE_TTL_MS };
}
