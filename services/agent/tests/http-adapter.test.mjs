import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { ExecutionUnconfirmedError } from '@rab/adapter-sdk';
import { HttpAdapter } from '../dist/adapters/http.js';

const now = new Date().toISOString();
const session = { id: 'test-session', title: 'HTTP fixture', created_at: now, updated_at: now };
const messageInput = { taskId: 'task-http-fixture', sessionId: session.id, text: '测试文本', mode: 'isolated', timeoutMs: 4_000 };

async function fixture(context, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return new HttpAdapter({ id: 'fixture', name: 'HTTP Fixture', endpoint, transport: 'http', enabled: true });
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

test('validates HTTP session identity and forwards only the wire contract', async context => {
  let sent;
  const path = `/sessions/${session.id}/switch`;
  const adapter = await fixture(context, (request, response) => {
    if (request.url === path) return json(response, { error: 'no session' }, 404);
    if (request.url === '/sessions') return json(response, { session });
    if (request.url !== `/sessions/${session.id}/messages`) return json(response, {}, 400);
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { sent = JSON.parse(Buffer.concat(chunks)); json(response, { session, message: '结果' }); });
  });
  await assert.rejects(adapter.switchSession(session.id), /session_not_found/);
  const created = await adapter.createSession({ sessionId: session.id, signal: new AbortController().signal });
  assert.equal(created.provider_id, 'fixture');
  let activity = 0;
  const result = await adapter.sendMessage({ ...messageInput, signal: new AbortController().signal, onActivity: () => { activity += 1; } });
  assert.equal(result.message, '结果');
  assert.deepEqual(sent, messageInput);
  assert.ok(activity > 0);
});

test('aborts the local HTTP request without treating that as remote cancellation', async context => {
  const arrived = Promise.withResolvers();
  let allowCancel = false;
  const controller = new AbortController();
  const adapter = await fixture(context, (request, response) => {
    if (request.url.endsWith('/cancel')) return json(response, { cancelled: allowCancel });
    if (request.url.endsWith('/messages')) arrived.resolve();
  });
  const sending = adapter.sendMessage({ ...messageInput, signal: controller.signal });
  await arrived.promise;
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(sending, /fixture cancelled/);
  await assert.rejects(adapter.cancelTask(messageInput.taskId), /remote_cancellation_unconfirmed/);
  allowCancel = true;
  assert.equal(await adapter.cancelTask(messageInput.taskId), 'stopped');
});

test('rejects oversized bodies, mismatched sessions and redirects without assuming the task failed remotely', async context => {
  let responseMode = 'large';
  let redirected = false;
  const adapter = await fixture(context, (request, response) => {
    if (request.url === '/should-not-follow') { redirected = true; return json(response, {}); }
    if (responseMode === 'large') return json(response, { session, message: 'a'.repeat(300 * 1024) });
    if (responseMode === 'mismatch') return json(response, { session: { ...session, id: 'unrelated' }, message: 'unrelated' });
    response.writeHead(307, { location: '/should-not-follow' });
    response.end();
  });
  await assert.rejects(adapter.sendMessage(messageInput), error => error instanceof ExecutionUnconfirmedError && error.message === 'remote_response_too_large');
  responseMode = 'mismatch';
  await assert.rejects(adapter.sendMessage(messageInput), /remote_execution_unconfirmed/);
  responseMode = 'redirect';
  await assert.rejects(adapter.sendMessage(messageInput), /remote_execution_unconfirmed/);
  assert.equal(redirected, false);
});
