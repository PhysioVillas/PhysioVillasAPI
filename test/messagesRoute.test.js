import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { InfobipMessagesApiError } from '../src/services/infobipMessagesClient.js';

async function withServer(app, callback) {
  const server = app.listen(0);

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function validationRequest(baseUrl, { token, body, path = '/messages/validate' }) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('message validation route stays unavailable without an internal token and Infobip client', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      body: { to: '5571999990000', text: 'Teste' },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'MESSAGES_API_NOT_CONFIGURED',
        message: 'Messages validation is not configured.',
      },
    });
  });
});

test('template validation forwards only the template contract to the validation-only client', async () => {
  const calls = [];
  const app = createApp({
    messagesClient: {
      validateTemplateMessage: async (message) => {
        calls.push(message);
        return { valid: true };
      },
    },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      token: 'internal-token',
      path: '/messages/templates/validate',
      body: {
        to: '5571999990000',
        templateName: 'appointment_reminder',
        language: 'pt_BR',
        parameters: ['Luiz', '10:00'],
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { validation: { valid: true } });
  });

  assert.deepEqual(calls, [{
    sender: 'sender',
    to: '5571999990000',
    templateName: 'appointment_reminder',
    language: 'pt_BR',
    parameters: ['Luiz', '10:00'],
    sendAt: undefined,
  }]);
});

test('message validation route rejects unauthenticated callers before validation', async () => {
  let called = false;
  const app = createApp({
    messagesClient: { validateTextMessage: async () => { called = true; } },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      body: { to: '5571999990000', text: 'Teste' },
    });

    assert.equal(response.status, 401);
  });

  assert.equal(called, false);
});

test('message validation forwards text and optional schedule to the validation-only client', async () => {
  const calls = [];
  const app = createApp({
    messagesClient: {
      validateTextMessage: async (message) => {
        calls.push(message);
        return { valid: true };
      },
    },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      token: 'internal-token',
      body: {
        to: '5571999990000',
        text: 'Teste de validação',
        sendAt: '2026-10-01T12:00:00.000Z',
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { validation: { valid: true } });
  });

  assert.deepEqual(calls, [{
    sender: 'sender',
    to: '5571999990000',
    text: 'Teste de validação',
    sendAt: '2026-10-01T12:00:00.000Z',
  }]);
});

test('message validation uses stable errors for invalid requests and Infobip validation failures', async () => {
  const invalidRequestApp = createApp({
    messagesClient: { validateTextMessage: async () => { throw new TypeError('bad input'); } },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });
  const rejectedByInfobipApp = createApp({
    messagesClient: {
      validateTextMessage: async () => {
        throw new InfobipMessagesApiError({ status: 400, details: { field: 'text' } });
      },
    },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });

  await withServer(invalidRequestApp, async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      token: 'internal-token',
      body: { to: '5571999990000', text: '' },
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_MESSAGE_REQUEST');
  });

  await withServer(rejectedByInfobipApp, async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      token: 'internal-token',
      body: { to: '5571999990000', text: 'Teste' },
    });

    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'INFOBIP_VALIDATION_FAILED');
  });
});
