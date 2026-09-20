import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InfobipMessagesApiError,
  buildTemplateMessage,
  createInfobipMessagesClient,
  validateSendAt,
} from '../src/services/infobipMessagesClient.js';

const credentials = {
  baseUrl: 'https://example.api.infobip.com/',
  apiKey: 'test-key',
};

const message = {
  sender: 'sender',
  to: 'recipient',
  text: 'Validation only.',
};

test('validateTextMessage uses the validation endpoint and never the send endpoint', async () => {
  const calls = [];
  const client = createInfobipMessagesClient({
    ...credentials,
    fetchImpl: async (...args) => {
      calls.push(args);
      return {
        ok: true,
        status: 200,
        json: async () => ({ valid: true }),
      };
    },
  });

  const result = await client.validateTextMessage(message);

  assert.deepEqual(result, { valid: true });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][0],
    'https://example.api.infobip.com/messages-api/1/messages/validate',
  );
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.Authorization, 'App test-key');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    messages: [
      {
        channel: 'WHATSAPP',
        sender: 'sender',
        destinations: [{ to: 'recipient' }],
        content: {
          body: {
            type: 'TEXT',
            text: 'Validation only.',
          },
        },
      },
    ],
  });
});

test('validateTextMessage exposes a failed validation without attempting delivery', async () => {
  const client = createInfobipMessagesClient({
    ...credentials,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ violations: [{ property: 'messages[0].content' }] }),
    }),
  });

  await assert.rejects(
    client.validateTextMessage(message),
    (error) =>
      error instanceof InfobipMessagesApiError &&
      error.status === 400 &&
      error.details.violations.length === 1,
  );
});

test('validateTextMessage accepts the optional scheduling field without sending', async () => {
  let request;
  const client = createInfobipMessagesClient({
    ...credentials,
    fetchImpl: async (...args) => {
      request = args;
      return {
        ok: true,
        status: 200,
        json: async () => ({ valid: true }),
      };
    },
  });

  const futureSendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await client.validateTextMessage({
    ...message,
    sendAt: futureSendAt,
  });

  assert.equal(JSON.parse(request[1].body).messages[0].sendAt, futureSendAt);
  await assert.rejects(
    client.validateTextMessage({ ...message, sendAt: 'not-a-date' }),
    /sendAt must be a valid ISO 8601 timestamp/,
  );
});

test('schedule validation refuses a time in the past before any Infobip request', () => {
  assert.throws(
    () => validateSendAt('2000-01-01T00:00:00.000Z'),
    /must be in the future/,
  );
});

test('template validation matches the documented Messages API contract and maps parameters by placeholder order', async () => {
  const calls = [];
  const client = createInfobipMessagesClient({
    ...credentials,
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, json: async () => ({ valid: true }) };
    },
  });

  const futureSendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await client.validateTemplateMessage({
    sender: 'sender',
    to: 'recipient',
    templateName: 'appointment_reminder',
    language: 'pt_BR',
    parameters: ['Luiz', '10:00'],
    sendAt: futureSendAt,
  });

  assert.equal(calls[0][0], 'https://example.api.infobip.com/messages-api/1/messages/validate');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    messages: [{
      channel: 'WHATSAPP',
      sender: 'sender',
      destinations: [{ to: 'recipient' }],
      content: { body: { 1: 'Luiz', 2: '10:00', type: 'TEXT' } },
      template: { templateName: 'appointment_reminder', language: 'pt_BR' },
      sendAt: futureSendAt,
    }],
  });
});

test('template builder rejects invalid names and placeholder values before making a request', () => {
  assert.throws(
    () => buildTemplateMessage({ sender: 'sender', to: 'recipient', language: 'pt_BR' }),
    /templateName/,
  );
  assert.throws(
    () => buildTemplateMessage({
      sender: 'sender',
      to: 'recipient',
      templateName: 'reminder',
      language: 'pt_BR',
      parameters: ['valid', ''],
    }),
    /parameters/,
  );
});

test('the client refuses incomplete configuration before making a request', () => {
  assert.throws(
    () => createInfobipMessagesClient({ baseUrl: '', apiKey: 'test-key' }),
    /base URL is required/,
  );
  assert.throws(
    () => createInfobipMessagesClient({ baseUrl: 'https://example.test', apiKey: '' }),
    /API key is required/,
  );
});
