import { networkInterfaces } from 'node:os';
import { readRuntimeConfig, validSetupToken } from '@rab/config';
import { valid } from './hashing.js';
import { port } from './runtime.js';
import { users } from './state.js';

/**
 * Who is allowed to do what, and how a failed attempt is throttled.
 *
 * The load-bearing idea here is that loopback is NOT proof of locality: every
 * tunnel client this project supports forwards to 127.0.0.1, so a request that
 * crossed a tunnel arrives looking local. Anything privileged therefore also
 * requires the setup token, which only a process that can read this machine's
 * data directory can present.
 */
/** Per-IP failure tracking for the login endpoint (5 failures / 5 minutes). */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const loginLocks = new Map<string, number>();
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_LOCK_MS = 10 * 60_000;

function loginKey(request: { ip?: string }): string {
  return request.ip || 'unknown';
}
export function loginBlocked(request: { ip?: string }): { blocked: boolean; retryAfter?: number } {
  const key = loginKey(request);
  const lockedUntil = loginLocks.get(key);
  const now = Date.now();
  if (lockedUntil && lockedUntil > now) return { blocked: true, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
  if (lockedUntil) loginLocks.delete(key);
  return { blocked: false };
}
export function recordLoginFailure(request: { ip?: string }) {
  const key = loginKey(request);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else current.count += 1;
  if (current && current.count >= LOGIN_MAX_FAILURES) {
    loginLocks.set(key, now + LOGIN_LOCK_MS);
    loginAttempts.delete(key);
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) if (entry.resetAt < now) loginAttempts.delete(key);
  for (const [key, until] of loginLocks) if (until < now) loginLocks.delete(key);
}, 60_000).unref();
export const auth = (request: { headers: Record<string, string | string[] | undefined> }) => {
  const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
  return [...users.entries()].find(([, user]) => valid(token, user.tokenHash))?.[0];
};
const isLoopback = (request: { ip?: string }) => request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1';

/**
 * Loopback alone does NOT prove locality, because the tunnel clients this
 * project supports forward to 127.0.0.1 — so every request that crosses a
 * tunnel arrives looking local. Privileged setup endpoints (pairing, provider
 * file paths, network config) additionally require the setup token, which
 * only a process that can read the data directory on this machine has.
 * Browser requests carry it in `x-rab-setup-token`; the operator can read it
 * from `<dataDir>/setup-token` or see it on the local setup page.
 */
export function requireLocalOperator(request: { ip?: string; headers: Record<string, string | string[] | undefined> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (!isLoopback(request)) {
    reply.code(403).send({ error: 'setup_is_local_only' });
    return false;
  }
  const presented = String(request.headers['x-rab-setup-token'] ?? '').trim();
  if (!validSetupToken(presented)) {
    reply.code(403).send({ error: 'setup_token_required', hint: `Open http://127.0.0.1:${port}/setup on this computer to load the setup token, or send it in the x-rab-setup-token header.` });
    return false;
  }
  return true;
}

/** Loopback check only. Never a security boundary on its own — see requireLocalOperator. */
const localOnly = isLoopback;

/** A successful sign-in clears that source's failure counter. */
export function clearLoginFailures(request: { ip?: string }) {
  loginAttempts.delete(loginKey(request));
}

function lanAccessUrls(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.add(`http://${entry.address}:${port}`);
    }
  }
  return [...addresses].sort();
}

/** Sakura tunnel traffic crosses the public internet, so plain HTTP is never accepted. */
export const publicUrlHttpsEnforced = true;

export function accessUrls(): string[] {
  const config = readRuntimeConfig();
  if (config.networkMode === 'local') return [`http://127.0.0.1:${port}`];
  if (config.networkMode === 'sakura' && config.publicUrl) {
    const normalized = config.publicUrl.replace(/\/$/, '');
    if (publicUrlHttpsEnforced && !/^https:\/\//i.test(normalized)) return [`http://127.0.0.1:${port}`];
    return [normalized];
  }
  if (config.networkMode === 'lan') return lanAccessUrls();
  return [`http://127.0.0.1:${port}`];
}

export function originFor(request: { headers: Record<string, string | string[] | undefined> }): string {
  return String(request.headers.origin ?? '').replace(/\/$/, '');
}

export function isAllowedOrigin(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  const origin = originFor(request);
  if (!origin) return true;
  const hostHeader = String(request.headers.host ?? '').trim();
  const configured = readRuntimeConfig().publicUrl.trim().replace(/\/$/, '');
  return origin === `http://${hostHeader}` || origin === `https://${hostHeader}` ||
    (configured.length > 0 && origin === configured) ||
    origin === `http://127.0.0.1:${port}` || origin === `https://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` || origin === `https://localhost:${port}`;
}
