import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';

async function withServer(app, callback) {
  const server = app.listen(0);

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function inboundPayload(overrides = {}) {
  return {
    results: [{
      from: '5571999990000',
      receivedAt: '2026-09-19T12:00:00.000+0000',
      messageId: 'infobip-inbound-1',
      message: { type: 'TEXT', text: 'Preciso remarcar a consulta.' },
      contact: { name: 'Paciente de teste' },
      ...overrides,
    }],
  };
}

test('inbound webhook remains unavailable until both persistence and an authorization token are configured', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inboundPayload()),
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: 'Webhook receiver is not configured.',
      },
    });
  });
});

test('inbound webhook rejects an invalid authorization header without persisting data', async () => {
  const calls = [];
  const app = createApp({
    database: { persistWebhookMessage: async (message) => calls.push(message) },
    infobipWebhookToken: 'receiver-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inboundPayload()),
    });

    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });
});

test('inbound webhook normalizes a documented WhatsApp inbound event and persists it once', async () => {
  const calls = [];
  const app = createApp({
    database: { persistWebhookMessage: async (message) => calls.push(message) },
    infobipWebhookToken: 'receiver-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer receiver-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(inboundPayload()),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: 1, ignored: 0 });
  });

  assert.deepEqual(calls, [{
    contact: {
      waId: '5571999990000',
      profileName: 'Paciente de teste',
      lastMessageAt: '2026-09-19T12:00:00.000+0000',
    },
    message: {
      infobipMessageId: 'infobip-inbound-1',
      waId: '5571999990000',
      direction: 'in',
      body: 'Preciso remarcar a consulta.',
      messageType: 'text',
      status: 'received',
      createdAt: '2026-09-19T12:00:00.000+0000',
    },
  }]);
});

test('inbound webhook acknowledges unsupported events without storing their raw payload', async () => {
  const calls = [];
  const app = createApp({
    database: { persistWebhookMessage: async (message) => calls.push(message) },
    infobipWebhookToken: 'receiver-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer receiver-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ results: [{ messageId: 'delivery-only-event' }] }),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 0, ignored: 1 });
  });

  assert.equal(calls.length, 0);
});

test('inbound webhook reports malformed JSON without exposing parser details', async () => {
  const app = createApp({
    database: { persistWebhookMessage: async () => undefined },
    infobipWebhookToken: 'receiver-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer receiver-token',
        'content-type': 'application/json',
      },
      body: '{invalid',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'INVALID_JSON',
        message: 'Request body must be valid JSON.',
      },
    });
  });
});
