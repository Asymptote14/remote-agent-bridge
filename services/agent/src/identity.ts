import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { dataDir } from '@rab/config';

/**
 * This computer's device identity.
 *
 * The Ed25519 private key is generated here on first run and never leaves the
 * machine — not at pairing, not on reconnect. The Gateway only ever stores the
 * public half, so a stolen `state.json` cannot be used to impersonate this
 * device. `token` is retained solely to migrate a device that was bound before
 * device keys existed; a key-bound device is never sent one again.
 */
export type DeviceIdentity = {
  device_id: string;
  token?: string;
  /** Base64 PKCS8 Ed25519 private key. Never transmitted. */
  private_key?: string;
  /** Base64 SPKI Ed25519 public key. Sent in `agent.hello`. */
  public_key?: string;
};

const identityPath = join(dataDir, 'agent-identity.json');

function readStoredIdentity(): DeviceIdentity {
  if (!existsSync(identityPath)) return { device_id: '' };
  try {
    return JSON.parse(readFileSync(identityPath, 'utf8')) as DeviceIdentity;
  } catch {
    return { device_id: '' };
  }
}

export function saveIdentity(identity: DeviceIdentity) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(identityPath, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(identityPath, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
}

export function loadIdentity(deviceId: string): DeviceIdentity {
  mkdirSync(dataDir, { recursive: true });
  const identity: DeviceIdentity = { ...readStoredIdentity(), device_id: deviceId };
  if (identity.private_key && identity.public_key) {
    try { chmodSync(identityPath, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
    return identity;
  }
  const pair = generateKeyPairSync('ed25519');
  identity.private_key = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  identity.public_key = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  saveIdentity(identity);
  console.log('Generated a new Ed25519 device key; the private half never leaves this computer.');
  return identity;
}

/** Sign the Gateway's per-connection nonce. Ed25519 has no separate digest. */
export function signChallenge(identity: DeviceIdentity, nonce: string): string | undefined {
  if (!identity.private_key) return undefined;
  try {
    const key = createPrivateKey({ key: Buffer.from(identity.private_key, 'base64'), format: 'der', type: 'pkcs8' });
    return sign(null, Buffer.from(nonce, 'utf8'), key).toString('base64');
  } catch {
    console.error('Stored device key is unreadable. Revoke this computer on the phone, delete .rab/agent-identity.json, then pair it again.');
    return undefined;
  }
}
