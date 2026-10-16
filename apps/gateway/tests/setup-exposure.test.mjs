// Regression tests for the tunnel exposure class of bug.
//
// The tunnel clients this project supports (sakura / frp-style forwarders, and
// most reverse proxies) connect to 127.0.0.1, so every request that crosses a
// tunnel arrives from loopback and looks local. Loopback must therefore never
// be the only thing standing in front of the privileged setup API: an attacker
// who reaches the tunnel could otherwise mint a pairing code and bind the
// operator's computer to their own account.
//
// The proxy below models exactly that hop. Without the setup token these all
// succeed, which is the vulnerability; with it, they are refused.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { api, FakeAgent, registerUser, startGateway } from './helpers.mjs';

/** A TCP proxy on loopback: the Gateway sees the peer as 127.0.0.1. */
function startLoopbackProxy(targetPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(client => {
      const upstream = net.connect(targetPort, '127.0.0.1');
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', () => {});
      upstream.on('error', () => {});
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

describe('setup API behind a tunnel hop', () => {
  let gateway;
  let proxy;
  let remote;

  before(async () => {
    gateway = await startGateway();
    proxy = await startLoopbackProxy(gateway.port);
    remote = `http://127.0.0.1:${proxy.port}`;
  });

  after(async () => {
    proxy?.server.close();
    if (gateway) await gateway.stop();
  });

  it('still looks local to the gateway, so IP checks alone cannot help', async () => {
    // Documents the premise of the fix: the request arrives from loopback.
    const unauthorized = await api(remote, '/api/setup/status');
    assert.equal(unauthorized.data.error, 'setup_token_required');
  });

  it('refuses to read setup state without the operator token', async () => {
    const response = await api(remote, '/api/setup/status');
    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'setup_token_required');
  });

  it('refuses to mint a pairing code without the operator token', async () => {
    const response = await api(remote, '/api/setup/pairing/renew', { method: 'POST' });
    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'setup_token_required');
  });

  it('refuses to read or rewrite provider paths without the operator token', async () => {
    const read = await api(remote, '/api/setup/providers');
    assert.equal(read.status, 403);
    const write = await api(remote, '/api/setup/providers', {
      method: 'POST',
      body: { id: 'evil', name: 'evil', transport: 'http', endpoint: 'http://attacker.invalid/' },
    });
    assert.equal(write.status, 403);
    const config = await api(remote, '/api/setup/config', { method: 'POST', body: { networkMode: 'lan' } });
    assert.equal(config.status, 403);
  });

  it('cannot bind the operator computer to an attacker account over the tunnel', async () => {
    // This is the attack the setup token exists to stop. The attacker can
    // register an account, but must not be able to obtain a pairing code.
    const attacker = await registerUser(remote, 'attacker@test.local');
    assert.ok(attacker, 'the attacker account path itself is public');

    const renew = await api(remote, '/api/setup/pairing/renew', { method: 'POST' });
    assert.equal(renew.status, 403);
    assert.equal(renew.data.code, undefined, 'no pairing code may be minted');

    const forged = await api(remote, '/api/pairings/authorize', {
      method: 'POST',
      token: attacker,
      body: { code: '000000' },
    });
    assert.equal(forged.status, 401, 'a guessed code must still be rejected');
  });

  it('accepts the operator request when the token is presented', async () => {
    const status = await api(remote, '/api/setup/status', { setupToken: gateway.setupToken });
    assert.equal(status.status, 200);
    assert.equal(status.data.gateway.port, gateway.port);

    // Issuing a code additionally requires a live, trusted Agent.
    const agent = await new FakeAgent(gateway.wsUrl, { deviceId: 'operator-agent', localProof: gateway.setupToken }).connect();
    try {
      const renew = await api(remote, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
      assert.equal(renew.status, 200);
      assert.match(String(renew.data.code), /^\d{6}$/);
    } finally {
      agent.close();
    }
  });

  it('rejects a wrong or truncated setup token', async () => {
    for (const bad of ['', 'x'.repeat(64), gateway.setupToken.slice(0, 63), gateway.setupToken.toUpperCase()]) {
      const response = await api(remote, '/api/setup/status', { setupToken: bad });
      assert.equal(response.status, 403, `token ${JSON.stringify(bad.slice(0, 8))} must not be accepted`);
    }
  });
});

describe('pairing requires a live agent and the operator token', () => {
  let gateway;

  before(async () => { gateway = await startGateway(); });
  after(async () => { if (gateway) await gateway.stop(); });

  it('refuses to issue a pairing code when no agent is connected', async () => {
    const response = await api(gateway.base, '/api/setup/pairing/renew', { method: 'POST', setupToken: gateway.setupToken });
    assert.equal(response.status, 503);
    assert.equal(response.data.error, 'agent_offline');
  });

  it('never leaks the raw device token through /health', async () => {
    const agent = await new FakeAgent(gateway.wsUrl, { deviceId: 'secret-agent', token: 'known-token', localProof: gateway.setupToken }).connect();
    try {
      const health = await api(gateway.base, '/health');
      assert.equal(health.data.agent.device_id, 'secret-agent');
      assert.equal(Object.hasOwn(health.data.agent, 'device_token'), false);
      assert.ok(!JSON.stringify(health.data).includes('known-token'));
    } finally {
      agent.close();
    }
  });
});
