import { WebSocket } from 'ws';
import { envelope, type AgentProviderInfo, type SessionCreate, type SessionEvent, type SessionSwitch } from '@rab/protocol';
import { devices, pendingCommands } from './state.js';

/**
 * The single agent slot.
 *
 * Exactly one socket at a time may act as this machine's Agent. Until that
 * socket is bound (paired) the Gateway routes nothing to it, so an unproven
 * peer holds the slot but stays blind.
 *
 * The state is one mutable object rather than module-level `let`s because the
 * socket handler assigns it while the route modules read it, and an ES module
 * import is a read-only binding: a plain export could not be reassigned.
 */

export type AgentInfo = {
  device_id: string;
  platform: string;
  interaction_mode: string;
  capabilities: string[];
  providers: AgentProviderInfo[];
};

export const slot: {
  agent: WebSocket | undefined;
  info: AgentInfo | undefined;
  deviceId: string | undefined;
  /** Whether the socket currently holding the agent slot proved its device identity. */
  authenticated: boolean;
  /** Whether the socket holding the agent slot proved it runs on this machine. */
  local: boolean;
  /**
   * The public key presented (and proven, by signing the challenge) by the
   * socket in the slot. Pairing stores this, so the device is bound to a key it
   * demonstrably holds rather than to a secret that had to be transmitted.
   */
  publicKey: string | undefined;
  /** How the current socket authenticated, for the operator UI. */
  authMode: 'device_key' | 'token' | 'unbound';
  queuePaused: boolean;
} = { agent: undefined, info: undefined, deviceId: undefined, authenticated: false, local: false, publicKey: undefined, authMode: 'unbound', queuePaused: false };

/** Only a bound (paired) agent may receive commands or tasks. Unbound
 * connections stay blind: the plan requires they receive no data at all. */
export function isAgentBound() {
  const device = slot.deviceId ? devices.get(slot.deviceId) : undefined;
  return Boolean(slot.agent?.readyState === WebSocket.OPEN && slot.authenticated && device?.owner && (device.auth_public_key || device.auth_token_hash));
}

export function agentOwner() {
  return isAgentBound() ? devices.get(slot.deviceId!)?.owner : undefined;
}

export function requireAgent(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, owner: string) {
  if (!isAgentBound()) {
    reply.code(503).send({ error: 'agent_offline' });
    return false;
  }
  if (agentOwner() !== owner) {
    reply.code(403).send({ error: 'device_not_authorized' });
    return false;
  }
  return true;
}

export function sendSessionCommand(requestId: string, type: 'session.create' | 'session.switch', payload: SessionCreate | SessionSwitch): Promise<SessionEvent> {
  return new Promise((resolve, reject) => {
    if (!isAgentBound()) {
      reject(new Error('agent_offline'));
      return;
    }
    const socket = slot.agent!;
    if (pendingCommands.size >= 16) {
      reject(new Error('session_operation_busy'));
      return;
    }
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error('session_operation_timeout'));
    }, 5_000);
    pendingCommands.set(requestId, {
      socket, sessionId: payload.session_id, providerId: payload.provider_id,
      action: type === 'session.create' ? 'created' : 'switched', resolve, reject, timer,
    });
    const fail = () => {
      clearTimeout(timer);
      pendingCommands.delete(requestId);
      reject(new Error('agent_disconnected'));
    };
    try { socket.send(JSON.stringify(envelope(type, payload, requestId)), error => { if (error) fail(); }); }
    catch { fail(); }
  });
}
