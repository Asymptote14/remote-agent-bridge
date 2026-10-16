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
  /** Whether the socket currently holding the agent slot proved its device token. */
  authenticated: boolean;
  /** Whether the socket holding the agent slot proved it runs on this machine. */
  local: boolean;
} = { agent: undefined, info: undefined, deviceId: undefined, authenticated: false, local: false };

/** Only a bound (paired) agent may receive commands or tasks. Unbound
 * connections stay blind: the plan requires they receive no data at all. */
export function isAgentBound() {
  return Boolean(slot.agent && slot.agent.readyState === WebSocket.OPEN && slot.deviceId && devices.get(slot.deviceId)?.auth_token_hash);
}

export function requireAgent(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (!isAgentBound()) {
    reply.code(503).send({ error: 'agent_offline' });
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
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error('session_operation_timeout'));
    }, 5_000);
    pendingCommands.set(requestId, { resolve, reject, timer });
    slot.agent!.send(JSON.stringify(envelope(type, payload, requestId)));
  });
}
