import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { normalizeInfobipWebhookPayload } from '../src/services/infobipWebhookNormalizer.js';

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

// Shape captured from a real smb_message_echoes event on 2026-09-25; every
// identifier and number below is a fictitious fixture value.
function coexistenceEchoPayload({ echoOverrides = {}, extraChanges = [] } = {}) {
  return {
    entry: [{
      id: 100000000000001,
      changes: [{
        value: {
          messagingProduct: 'whatsapp',
          metadata: { displayPhoneNumber: '5571900000000', phoneNumberId: '100000000000002' },
          contacts: [{ waId: '557188887777', userId: 'BR.0000000000000001' }],
          messageEchoes: [{
            from: '5571900000000',
            to: '557188887777',
            id: 'wamid.test-echo-1',
            toUserId: 'BR.0000000000000001',
            timestamp: '1790362521',
            text: { body: 'Resposta da clínica' },
            type: 'text',
            ...echoOverrides,
          }],
        },
        field: 'smb_message_echoes',
      }, ...extraChanges],
    }],
  };
}

const expectedCoexistenceEcho = {
  contact: {
    waId: '557188887777',
    profileName: null,
    lastMessageAt: '2026-09-25T18:55:21.000Z',
  },
  message: {
    infobipMessageId: 'wamid.test-echo-1',
    waId: '557188887777',
    direction: 'out',
    sentVia: 'business_app',
    body: 'Resposta da clínica',
    messageType: 'text',
    status: 'sent',
    createdAt: '2026-09-25T18:55:21.000Z',
  },
};

test('coexistence echo normalization is deterministic so the message id deduplicates retries', () => {
  const first = normalizeInfobipWebhookPayload(coexistenceEchoPayload());
  const second = normalizeInfobipWebhookPayload(coexistenceEchoPayload());

  assert.deepEqual(first, { inboundMessages: [expectedCoexistenceEcho], deliveryReports: [], ignored: 0 });
  assert.deepEqual(second, first);
});

test('coexistence echo without a text body is still recorded with its message type', () => {
  const normalized = normalizeInfobipWebhookPayload(coexistenceEchoPayload({
    echoOverrides: { type: 'IMAGE', text: undefined, image: { id: 'media-1' } },
  }));

  assert.equal(normalized.inboundMessages.length, 1);
  assert.equal(normalized.inboundMessages[0].message.body, null);
  assert.equal(normalized.inboundMessages[0].message.messageType, 'image');
  assert.equal(normalized.ignored, 0);
});

test('coexistence echo with an unparseable timestamp leaves createdAt to the database default', () => {
  const normalized = normalizeInfobipWebhookPayload(coexistenceEchoPayload({
    echoOverrides: { timestamp: '2026-09-25' },
  }));

  assert.equal(normalized.inboundMessages[0].message.createdAt, null);
  assert.equal(normalized.inboundMessages[0].contact.lastMessageAt, null);
});

test('inbound webhook persists a coexistence echo as an outbound Business App message', async () => {
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
      body: JSON.stringify(coexistenceEchoPayload()),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: 1, ignored: 0 });
  });

  assert.deepEqual(calls, [expectedCoexistenceEcho]);
});

test('inbound webhook ignores unmapped entry[] change fields without failing', async () => {
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
      body: JSON.stringify({
        entry: [{
          id: 100000000000001,
          changes: [{ value: { messagingProduct: 'whatsapp' }, field: 'history' }],
        }],
      }),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 0, ignored: 1 });
  });

  assert.equal(calls.length, 0);
});

test('coexistence normalization handles several changes and echoes in one delivery', () => {
  const payload = coexistenceEchoPayload({
    extraChanges: [{ value: {}, field: 'history' }],
  });
  payload.entry[0].changes[0].value.messageEchoes.push({
    ...payload.entry[0].changes[0].value.messageEchoes[0],
    id: 'wamid.test-echo-2',
  });

  const normalized = normalizeInfobipWebhookPayload(payload);

  assert.deepEqual(
    normalized.inboundMessages.map(({ message }) => message.infobipMessageId),
    ['wamid.test-echo-1', 'wamid.test-echo-2'],
  );
  assert.equal(normalized.ignored, 1);
});

test('webhook normalization does not double-count a result with both known shapes', () => {
  const normalized = normalizeInfobipWebhookPayload(inboundPayload({
    doneAt: '2026-09-20T14:00:00.000+0000',
    status: { name: 'DELIVERED_TO_HANDSET' },
  }));

  assert.equal(normalized.inboundMessages.length, 1);
  assert.equal(normalized.deliveryReports.length, 1);
  assert.equal(normalized.ignored, 0);
});

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

test('inbound webhook records a documented delivery update without retaining its raw payload', async () => {
  const calls = [];
  const app = createApp({
    database: {
      persistWebhookMessage: async () => undefined,
      recordDeliveryStatus: async (report) => calls.push(report),
    },
    infobipWebhookToken: 'receiver-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer receiver-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        results: [{
          messageId: 'infobip-outbound-1',
          doneAt: '2026-09-20T14:00:00.000+0000',
          status: { groupName: 'DELIVERED', name: 'DELIVERED_TO_HANDSET' },
          error: { name: 'NO_ERROR' },
          price: { pricePerMessage: 1, currency: 'EUR' },
        }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: 1, ignored: 0 });
  });

  assert.deepEqual(calls, [{
    infobipMessageId: 'infobip-outbound-1',
    status: 'delivered_to_handset',
    errorCode: 'NO_ERROR',
    statusUpdatedAt: '2026-09-20T14:00:00.000+0000',
  }]);
});

test('debug-log route is disabled by default and does not leak whether capture is possible', async () => {
  const app = createApp({
    database: { persistWebhookMessage: async () => undefined },
    infobipWebhookToken: 'receiver-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/debug-log`, {
      headers: { authorization: 'Bearer receiver-token' },
    });

    assert.equal(response.status, 404);
  });
});

test('debug-log route requires the webhook bearer token even when capture is enabled', async () => {
  const app = createApp({
    database: { persistWebhookMessage: async () => undefined },
    infobipWebhookToken: 'receiver-token',
    captureUnmappedWebhookPayloads: true,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/debug-log`);

    assert.equal(response.status, 401);
  });
});

test('debug-log route captures unmapped payloads in memory without persisting them', async () => {
  const app = createApp({
    database: { persistWebhookMessage: async () => undefined },
    infobipWebhookToken: 'receiver-token',
    captureUnmappedWebhookPayloads: true,
  });

  await withServer(app, async (baseUrl) => {
    const unmappedPayload = { results: [{ messageId: 'unmapped-event' }] };

    const postResponse = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer receiver-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(unmappedPayload),
    });

    assert.equal(postResponse.status, 202);

    const debugResponse = await fetch(`${baseUrl}/webhooks/infobip/debug-log`, {
      headers: { authorization: 'Bearer receiver-token' },
    });

    assert.equal(debugResponse.status, 200);
    const body = await debugResponse.json();
    assert.equal(body.capturedPayloads.length, 1);
    assert.deepEqual(body.capturedPayloads[0].payload, unmappedPayload);
  });
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

test('inbound webhook accepts unauthenticated requests only when the capture bypass is explicitly enabled', async () => {
  const calls = [];
  const app = createApp({
    database: { persistWebhookMessage: async (message) => calls.push(message) },
    infobipWebhookToken: 'receiver-token',
    allowUnauthenticatedInbound: true,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(coexistenceEchoPayload()),
    });

    assert.equal(response.status, 200);
  });

  assert.equal(calls.length, 1);
});
