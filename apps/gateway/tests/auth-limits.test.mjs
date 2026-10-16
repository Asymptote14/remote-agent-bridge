// Rate limiting: login lockout and pairing attempt throttling.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, registerUser, startGateway } from './helpers.mjs';

describe('login rate limiting', () => {
  let gateway;

  before(async () => { gateway = await startGateway(); });
  after(async () => { if (gateway) await gateway.stop(); });

  it('locks the source IP after five failed logins', async () => {
    // Register first so the account exists and failures are real credential misses.
    await registerUser(gateway.base, 'victim@test.local', 'correct-horse1');

    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await api(gateway.base, '/api/auth/login', {
        method: 'POST',
        body: { email: 'victim@test.local', password: `wrong-password-${attempt}` },
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401], 'first five failures should be 401');
    assert.equal(statuses[5], 429, 'sixth attempt should be rate limited');

    // The lock applies even to valid credentials until it expires.
    const correct = await api(gateway.base, '/api/auth/login', {
      method: 'POST',
      body: { email: 'victim@test.local', password: 'correct-horse1' },
    });
    assert.equal(correct.status, 429);
    assert.ok(Number(correct.headers.get('retry-after')) > 0, 'retry-after should be advertised');
  });
});

describe('pairing attempt limiting', () => {
  let gateway;

  before(async () => { gateway = await startGateway(); });
  after(async () => { if (gateway) await gateway.stop(); });

  it('throttles repeated invalid pairing codes for the same IP', async () => {
    const token = await registerUser(gateway.base, 'pairing@test.local');
    const statuses = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await api(gateway.base, '/api/pairings/authorize', {
        method: 'POST',
        token,
        body: { code: String(100000 + attempt) },
      });
      statuses.push(response.status);
    }
    assert.ok(statuses.includes(401), 'invalid codes should be rejected');
    assert.equal(statuses.at(-1), 429, 'repeated failures should trip the limiter');
  });
});
