import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { normalizeInfobipWebhookPayload } from '../src/services/infobipWebhookNormalizer.js';

function hmacSignature(body, secret, algorithm = 'sha256') {
  return createHmac(algorithm, secret).update(Buffer.from(body)).digest('hex');
}

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
    sourceSender: '5571900000000',
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
      replyId: null,
      status: 'received',
      createdAt: '2026-09-19T12:00:00.000+0000',
    },
  }]);
});

test('the old public agenda path is disabled and retries never reach the bot twice', async () => {
  const providerMessageId = 'infobip-appointment-request-1';
  const payload = inboundPayload({
    messageId: providerMessageId,
    message: { type: 'TEXT', text: 'AGENDAR | FISIOTERAPIA | MOISES | 2026-12-01 | 07:30' },
  });
  const stored = new Set();
  const appointmentCalls = [];
  const botCalls = [];
  const database = {
    persistWebhookMessage: async ({ message }) => {
      const isNew = !stored.has(message.infobipMessageId);
      stored.add(message.infobipMessageId);
      return { message: isNew ? { id: 'stored-1' } : null };
    },
    findPersistedMessageIdByInfobipId: async () => { appointmentCalls.push('lookup'); return 'stored-1'; },
    listAvailableAppointmentSlots: async () => { appointmentCalls.push('slots'); return []; },
    createAppointmentRequest: async () => { appointmentCalls.push('request'); return null; },
  };
  const app = createApp({
    database,
    infobipWebhookToken: 'receiver-token',
    whatsappSender: 'clinic-sender',
    appointmentConfirmationUtcOffset: '-03:00',
    bot: { handleInbound: async (message) => botCalls.push(message), handleTeamReply: async () => {} },
  });

  await withServer(app, async (baseUrl) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer receiver-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { accepted: 1, ignored: 0 });
    }
  });

  assert.deepEqual(appointmentCalls, []);
  assert.equal(botCalls.length, 1);
  assert.equal(botCalls[0].infobipMessageId, providerMessageId);
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

test('inbound webhook rejects unauthenticated requests unless the POC bypass is enabled', async () => {
  const calls = [];
  const app = createApp({
    database: { persistWebhookMessage: async (message) => calls.push(message) },
    infobipWebhookToken: 'receiver-token',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(coexistenceEchoPayload()),
    });

    assert.equal(response.status, 401);
  });

  assert.equal(calls.length, 0);
});

test('POC bypass accepts an unauthenticated message and the bot answers it', async () => {
  const persisted = [];
  const botCalls = [];
  const app = createApp({
    database: {
      persistWebhookMessage: async (normalized) => {
        persisted.push(normalized);
        return { message: { id: 1 } };
      },
    },
    infobipWebhookToken: 'receiver-token',
    whatsappSender: '5571900000000',
    appointmentConfirmationUtcOffset: '-03:00',
    bot: { handleInbound: async (message) => botCalls.push(message), handleTeamReply: async () => {} },
    allowUnauthenticatedInbound: true,
  });
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(inboundPayload()),
      });

      assert.equal(response.status, 200);
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(persisted.length, 1);
  assert.equal(botCalls.length, 1);
  assert.equal(botCalls[0].body, 'Preciso remarcar a consulta.');
});

test('inbound webhook authenticates Infobip HMAC against the exact raw request body', async () => {
  const calls = [];
  const secret = 'test-signing-secret';
  const body = JSON.stringify(inboundPayload());
  const app = createApp({
    database: { persistWebhookMessage: async (message) => calls.push(message) },
    infobipWebhookHmacSecret: secret,
    infobipWebhookHmacAlgorithm: 'HMAC_SHA_256',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Hub-Signature': hmacSignature(body, secret) },
      body,
    });

    assert.equal(response.status, 200);
  });
  assert.equal(calls.length, 1);
});

test('inbound webhook rejects missing, malformed, or incorrect HMAC before persistence', async () => {
  const calls = [];
  const body = JSON.stringify(inboundPayload());
  const app = createApp({
    database: { persistWebhookMessage: async (message) => calls.push(message) },
    infobipWebhookHmacSecret: 'test-signing-secret',
  });

  await withServer(app, async (baseUrl) => {
    for (const signature of [undefined, 'not-a-signature', hmacSignature(body, 'wrong-secret')]) {
      const headers = { 'content-type': 'application/json' };
      if (signature !== undefined) headers['X-Hub-Signature'] = signature;
      const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, { method: 'POST', headers, body });
      assert.equal(response.status, 401);
    }
  });
  assert.equal(calls.length, 0);
});

test('an absent webhook token cannot authenticate as the literal undefined bearer value', async () => {
  let persisted = 0;
  const app = createApp({
    database: { persistWebhookMessage: async () => { persisted += 1; } },
    infobipWebhookHmacSecret: 'test-hmac-secret',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: { authorization: 'Bearer undefined', 'content-type': 'application/json' },
      body: JSON.stringify(inboundPayload()),
    });

    assert.equal(response.status, 401);
    assert.equal(persisted, 0);
  });
});

test('a configured HMAC cannot be bypassed with a valid legacy bearer token', async () => {
  let persisted = 0;
  const app = createApp({
    database: { persistWebhookMessage: async () => { persisted += 1; } },
    infobipWebhookToken: 'legacy-token',
    infobipWebhookHmacSecret: 'current-hmac-secret',
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer legacy-token',
        'X-Hub-Signature': hmacSignature(JSON.stringify(inboundPayload()), 'incorrect-secret'),
        'content-type': 'application/json',
      },
      body: JSON.stringify(inboundPayload()),
    });

    assert.equal(response.status, 401);
    assert.equal(persisted, 0);
  });
});
