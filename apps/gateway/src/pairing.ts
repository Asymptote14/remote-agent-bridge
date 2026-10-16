import type { FastifyBaseLogger } from 'fastify';
import { devices, pairings, pairingAttempts } from './state.js';

/**
 * Pairing codes: the one-time secret that binds a phone account to a computer.
 *
 * A code is short lived (60s), single use, and bound to a device id. It is
 * deliberately never sent over the Agent WebSocket — the operator reads it from
 * the local /setup page — so holding the agent slot is not enough to obtain one.
 */

export function issuePairing(deviceId: string, log: FastifyBaseLogger): { code: string; expires_in: number } | undefined {
  const now = Date.now();
  for (const [code, pairing] of pairings) if (pairing.expires <= now) pairings.delete(code);
  const device = devices.get(deviceId);
  if (!device) return undefined;
  if (device.pairing) pairings.delete(device.pairing);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  device.pairing = code;
  pairings.set(code, { deviceId, expires: Date.now() + 60_000 });
  // The pairing code is no longer pushed over the Agent WebSocket. It stays on
  // the Gateway until the operator fetches it from the local /setup page.
  log.info({ device_id: deviceId }, 'pairing code issued (visible on local /setup page only)');
  return { code, expires_in: 60 };
}

function pairingAttemptKey(request: { ip?: string }): string {
  return request.ip || 'unknown';
}

export function canTryPairing(request: { ip?: string }): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const key = pairingAttemptKey(request);
  const current = pairingAttempts.get(key);
  if (!current || current.resetAt <= now) {
    pairingAttempts.set(key, { count: 0, resetAt: now + 5 * 60_000 });
    return { allowed: true };
  }
  if (current.count >= 5) return { allowed: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  return { allowed: true };
}

export function recordPairingFailure(request: { ip?: string }) {
  const now = Date.now();
  const key = pairingAttemptKey(request);
  const current = pairingAttempts.get(key);
  if (!current || current.resetAt <= now) pairingAttempts.set(key, { count: 1, resetAt: now + 5 * 60_000 });
  else current.count += 1;
}

/** A successful pairing clears that source's failure counter. */
export function clearPairingFailures(request: { ip?: string }) {
  pairingAttempts.delete(pairingAttemptKey(request));
}
