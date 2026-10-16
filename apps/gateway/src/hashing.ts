import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password and bearer-token hashing.
 *
 * It lives in its own module because both the credential store and the request
 * authenticator need it, and neither should have to import the other.
 */
export const hash = (value: string, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(value, salt, 32).toString('hex')}`;

export const valid = (value: string, stored: string) => {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest || !/^[0-9a-f]+$/i.test(digest) || digest.length % 2 !== 0) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(value, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
