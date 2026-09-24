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

test('text send persists the provider receipt and forwards an optional schedule', async () => {
  const calls = [];
  const app = createApp({
    database: {
      persistOutboundMessage: async (message) => {
        calls.push(['persist', message]);
        return { message: { id: 'stored-id' } };
      },
    },
    messagesClient: {
      validateTextMessage: async () => ({ valid: true }),
      validateTemplateMessage: async () => ({ valid: true }),
      sendTextMessage: async (message) => {
        calls.push(['send', message]);
        return { messages: [{ messageId: 'provider-id', status: { name: 'MESSAGE_ACCEPTED' } }] };
      },
      sendTemplateMessage: async () => ({ messages: [{ messageId: 'unused-id' }] }),
    },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      token: 'internal-token',
      path: '/messages/send',
      body: {
        to: '5571999990000',
        text: 'Lembrete de homologação',
        sendAt: '2026-10-01T12:00:00.000Z',
      },
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      messageId: 'provider-id',
      status: 'MESSAGE_ACCEPTED',
      scheduled: true,
      persisted: true,
    });
  });

  assert.deepEqual(calls, [
    ['send', {
      sender: 'sender',
      to: '5571999990000',
      text: 'Lembrete de homologação',
      sendAt: '2026-10-01T12:00:00.000Z',
    }],
    ['persist', {
      infobipMessageId: 'provider-id',
      waId: '5571999990000',
      body: 'Lembrete de homologação',
      messageType: 'text',
      status: 'MESSAGE_ACCEPTED',
    }],
  ]);
});

test('template send persists only the template name, not template parameters', async () => {
  let persisted;
  let sent;
  const app = createApp({
    database: { persistOutboundMessage: async (message) => { persisted = message; return { message: {} }; } },
    messagesClient: {
      validateTextMessage: async () => ({ valid: true }),
      validateTemplateMessage: async () => ({ valid: true }),
      sendTextMessage: async () => ({ messages: [{ messageId: 'unused-id' }] }),
      sendTemplateMessage: async (message) => {
        sent = message;
        return { messages: [{ messageId: 'template-id' }] };
      },
    },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      token: 'internal-token',
      path: '/messages/templates/send',
      body: {
        to: '5571999990000',
        templateName: 'appointment_reminder',
        language: 'pt_BR',
        parameters: ['Nome de homologação', '10:00'],
      },
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      messageId: 'template-id',
      status: 'accepted',
      scheduled: false,
      persisted: true,
    });
  });

  assert.deepEqual(sent.parameters, ['Nome de homologação', '10:00']);
  assert.deepEqual(persisted, {
    infobipMessageId: 'template-id',
    waId: '5571999990000',
    body: 'template:appointment_reminder',
    messageType: 'template',
    status: 'accepted',
  });
});

test('message send rejects callers before contacting Infobip and fails closed without database', async () => {
  let called = false;
  const app = createApp({
    messagesClient: {
      validateTextMessage: async () => ({ valid: true }),
      validateTemplateMessage: async () => ({ valid: true }),
      sendTextMessage: async () => { called = true; },
      sendTemplateMessage: async () => { called = true; },
    },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });

  await withServer(app, async (baseUrl) => {
    const unauthorized = await validationRequest(baseUrl, {
      path: '/messages/send',
      body: { to: 'recipient', text: 'Test' },
    });
    assert.equal(unauthorized.status, 503);

    const missingDatabaseApp = createApp({
      database: { persistOutboundMessage: async () => ({ message: {} }) },
      messagesClient: {
        validateTextMessage: async () => ({ valid: true }),
        validateTemplateMessage: async () => ({ valid: true }),
        sendTextMessage: async () => { called = true; },
        sendTemplateMessage: async () => ({ messages: [{ messageId: 'id' }] }),
      },
      whatsappSender: 'sender',
      chatManagerApiToken: 'internal-token',
    });
    await withServer(missingDatabaseApp, async (configuredUrl) => {
      const unauthorizedConfigured = await validationRequest(configuredUrl, {
        path: '/messages/send',
        body: { to: 'recipient', text: 'Test' },
      });
      assert.equal(unauthorizedConfigured.status, 401);
    });
  });

  assert.equal(called, false);
});

test('message send returns Infobip status and details for an upstream rejection', async () => {
  const app = createApp({
    database: { persistOutboundMessage: async () => ({ message: {} }) },
    messagesClient: {
      validateTextMessage: async () => ({ valid: true }),
      validateTemplateMessage: async () => ({ valid: true }),
      sendTextMessage: async () => {
        throw new InfobipMessagesApiError({ status: 403, details: { message: 'scope missing' } });
      },
      sendTemplateMessage: async () => ({ messages: [{ messageId: 'unused-id' }] }),
    },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      token: 'internal-token',
      path: '/messages/send',
      body: { to: 'recipient', text: 'Test' },
    });

    assert.equal(response.status, 502);
    assert.deepEqual((await response.json()).error, {
      code: 'INFOBIP_SEND_FAILED',
      message: 'Infobip rejected the message send request.',
      upstreamStatus: 403,
      details: { message: 'scope missing' },
    });
  });
});

test('message send does not ask the caller to resend if Neon fails after provider acceptance', async () => {
  const app = createApp({
    database: { persistOutboundMessage: async () => { throw new Error('database unavailable'); } },
    messagesClient: {
      validateTextMessage: async () => ({ valid: true }),
      validateTemplateMessage: async () => ({ valid: true }),
      sendTextMessage: async () => ({
        messages: [{ messageId: 'accepted-id', status: { name: 'MESSAGE_ACCEPTED' } }],
      }),
      sendTemplateMessage: async () => ({ messages: [{ messageId: 'unused-id' }] }),
    },
    whatsappSender: 'sender',
    chatManagerApiToken: 'internal-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await validationRequest(baseUrl, {
      token: 'internal-token',
      path: '/messages/send',
      body: { to: 'recipient', text: 'Test' },
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      messageId: 'accepted-id',
      status: 'MESSAGE_ACCEPTED',
      scheduled: false,
      persisted: false,
      warning: 'Infobip accepted the message, but the receipt was not persisted. Do not retry; reconcile this messageId manually.',
    });
  });
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
    assert.deepEqual((await response.json()).error, {
      code: 'INFOBIP_VALIDATION_FAILED',
      message: 'Infobip rejected the message validation request.',
      upstreamStatus: 400,
      details: { field: 'text' },
    });
  });
});
