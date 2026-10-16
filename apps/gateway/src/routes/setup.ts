import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { getProviderConfigPath, readProviderConfigs, readRuntimeConfig, writeProviderConfigs, writeRuntimeConfig, type ProviderConfig, type RuntimeConfig } from '@rab/config';
import { app } from '../app.js';
import { slot } from '../agent-slot.js';
import { codexCandidates, workBuddyCandidates } from '../discovery.js';
import { issuePairing } from '../pairing.js';
import { host, port } from '../runtime.js';
import { accessUrls, publicUrlHttpsEnforced, requireLocalOperator } from '../security.js';
import { devices, pairings, persistState, sessions } from '../state.js';

// Everything behind the operator boundary. Every handler starts with
// requireLocalOperator, which demands loopback AND the setup token.
app.get('/api/setup/status', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  const device = slot.deviceId ? devices.get(slot.deviceId) : undefined;
  const pairing = device?.pairing ? pairings.get(device.pairing) : undefined;
  return {
    config: { ...readRuntimeConfig(), port, host },
    gateway: { host, port, url: accessUrls()[0] ?? `http://127.0.0.1:${port}`, access_urls: accessUrls(), public_url_https_enforced: publicUrlHttpsEnforced },
    warnings: readRuntimeConfig().networkMode === 'sakura' && readRuntimeConfig().publicUrl && !/^https:\/\//i.test(readRuntimeConfig().publicUrl.replace(/\/$/, ''))
      ? ['sakura_public_url_must_use_https']
      : [],
    provider_config: { path: getProviderConfigPath(), environment_override: Boolean(process.env.RAB_PROVIDERS_FILE) },
    agent: { online: slot.agent?.readyState === WebSocket.OPEN, device_id: slot.deviceId, device_name: device?.name, platform: device?.platform },
    pairing: pairing && pairing.expires > Date.now() ? { code: device?.pairing, expires_at: pairing.expires } : undefined,
  };
});
app.post<{ Body: Partial<RuntimeConfig> }>('/api/setup/config', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  const before = readRuntimeConfig();
  const previousProviders = readProviderConfigs();
  const submitted = request.body ?? {};
  // Sakura tunnels relay traffic over the public internet: reject plain http:// URLs.
  if ((submitted.networkMode ?? before.networkMode) === 'sakura' && typeof submitted.publicUrl === 'string' && submitted.publicUrl.trim() && !/^https:\/\//i.test(submitted.publicUrl.trim())) {
    return reply.code(400).send({ error: 'sakura_public_url_must_use_https' });
  }
  const next = writeRuntimeConfig(submitted);
  if (next.providersFile !== before.providersFile && !existsSync(next.providersFile)) {
    mkdirSync(join(next.providersFile, '..'), { recursive: true });
    writeFileSync(next.providersFile, JSON.stringify(previousProviders, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(next.providersFile, 0o600); } catch { /* Windows may ignore POSIX file modes. */ }
  }
  if (slot.deviceId) {
    const device = devices.get(slot.deviceId);
    if (device) device.name = next.deviceName;
  }
  return { saved: true, restart_required: next.host !== host || next.port !== port || next.providersFile !== before.providersFile, config: next };
});
app.post('/api/setup/pairing/renew', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  if (!slot.agent || slot.agent.readyState !== WebSocket.OPEN || !slot.deviceId) return reply.code(503).send({ error: 'agent_offline' });
  // Only ever mint a code for a device that is either already authenticated or
  // proven to be this machine's own Agent. Otherwise a remote peer that holds
  // the slot would receive the pairing code that the operator then authorizes,
  // binding the operator's computer to the attacker.
  if (!slot.authenticated && !slot.local) {
    return reply.code(409).send({ error: 'agent_not_trusted', hint: 'The connected device has not proven it runs on this machine. Restart the local Agent.' });
  }
  return issuePairing(slot.deviceId, app.log);
});
app.get('/api/setup/providers', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  return readProviderConfigs().map(item => ({ ...item, token: item.token ? '••••••••' : '' }));
});
app.get('/api/setup/workbuddy/detect', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  return { detected: workBuddyCandidates(), runtime: process.execPath };
});
app.get('/api/setup/codex/detect', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  return { detected: codexCandidates() };
});
app.post<{ Body: ProviderConfig }>('/api/setup/providers', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  const input = request.body ?? {} as ProviderConfig;
  const transport = input.transport;
  if (!input.id || !input.name || !['http', 'cli'].includes(transport)) return reply.code(400).send({ error: 'provider_requires_id_name_and_supported_transport' });
  if (transport === 'http' && !input.endpoint) return reply.code(400).send({ error: 'http_provider_requires_endpoint' });
  if (transport === 'cli' && !input.executable) return reply.code(400).send({ error: 'cli_provider_requires_executable' });
  const items = readProviderConfigs().filter(item => item.id !== input.id);
  const old = readProviderConfigs().find(item => item.id === input.id);
  items.push({
    ...old,
    id: input.id.trim(),
    name: input.name.trim(),
    adapter: input.adapter?.trim() || old?.adapter || (input.id.trim() === 'workbuddy' ? 'workbuddy' : undefined),
    transport,
    endpoint: input.endpoint?.trim(),
    executable: input.executable?.trim(),
    runtime: input.runtime?.trim(),
    cwd: input.cwd?.trim(),
    permissionMode: input.permissionMode || 'auto',
    sandboxMode: input.sandboxMode || old?.sandboxMode,
    token: input.token?.replace(/^•+$/, '') || old?.token || undefined,
    enabled: input.enabled !== false,
  });
  writeProviderConfigs(items);
  return { saved: true, restart_required: true };
});
app.delete<{ Params: { id: string } }>('/api/setup/providers/:id', async (request, reply) => {
  if (!requireLocalOperator(request, reply)) return;
  writeProviderConfigs(readProviderConfigs().filter(item => item.id !== request.params.id));
  return { deleted: true, restart_required: true };
});
