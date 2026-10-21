import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeApp } from '../src/bootstrap.js';

test('runtime creates the PostgreSQL adapter only when DATABASE_URL is configured', () => {
  let databaseOptions;
  const database = { verifySchema: async () => {} };

  const { app, config } = createRuntimeApp({
    env: { DATABASE_URL: ' postgres://neon.example/chatmanager ' },
    createDatabaseFactory: (options) => {
      databaseOptions = options;
      return database;
    },
  });

  assert.equal(typeof app, 'function');
  assert.equal(config.databaseUrl, 'postgres://neon.example/chatmanager');
  assert.deepEqual(databaseOptions, {
    connectionString: 'postgres://neon.example/chatmanager',
  });
});

test('runtime remains safely disconnected when no database or Infobip configuration exists', () => {
  let databaseCreated = false;
  let clientCreated = false;

  const { app, config } = createRuntimeApp({
    env: {},
    createDatabaseFactory: () => {
      databaseCreated = true;
    },
    createInfobipMessagesClientFactory: () => {
      clientCreated = true;
    },
  });

  assert.equal(typeof app, 'function');
  assert.equal(config.databaseUrl, undefined);
  assert.equal(databaseCreated, false);
  assert.equal(clientCreated, false);
});

test('runtime inbound webhook temporarily accepts unauthenticated requests until an Infobip-compatible auth is chosen', async () => {
  const calls = [];
  const { app } = createRuntimeApp({
    env: {
      DATABASE_URL: 'postgres://neon.example/chatmanager',
      INFOBIP_WEBHOOK_TOKEN: 'receiver-token',
    },
    createDatabaseFactory: () => ({ persistWebhookMessage: async (message) => calls.push(message) }),
  });
  const server = app.listen(0);

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: [] }),
    });

    assert.equal(response.status, 202);
    assert.equal(calls.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('runtime wires the FAQ bot as soon as database and Infobip sending are configured', async () => {
  const sends = [];
  const databaseOnly = {
    DATABASE_URL: 'postgres://neon.example/chatmanager',
    INFOBIP_WEBHOOK_TOKEN: 'receiver-token',
  };
  const fullyConfigured = {
    ...databaseOnly,
    INFOBIP_BASE_URL: 'https://tenant.example',
    INFOBIP_API_KEY: 'secret',
    INFOBIP_WHATSAPP_SENDER: 'clinic-sender',
  };
  const factories = {
    createDatabaseFactory: () => ({
      persistWebhookMessage: async () => ({ message: { id: 'stored' } }),
      getFaqBotContext: async () => ({ lastBotMessageType: null, teamRepliedRecently: false }),
      persistOutboundMessage: async () => ({ message: { id: 'stored' } }),
    }),
    createInfobipMessagesClientFactory: () => ({
      sendWhatsAppInteractiveList: async (message) => {
        sends.push(message);
        return { messageId: `bot-${sends.length}` };
      },
    }),
  };
  const payload = {
    results: [{
      from: '5571999990000',
      messageId: 'in-1',
      receivedAt: '2026-10-21T12:00:00.000+0000',
      message: { type: 'TEXT', text: 'Oi' },
    }],
  };

  for (const env of [databaseOnly, fullyConfigured]) {
    const { app } = createRuntimeApp({ env, ...factories });
    const server = app.listen(0);

    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/infobip/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      assert.equal(response.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  assert.equal(sends.length, 1);
  assert.equal(sends[0].sender, 'clinic-sender');
  assert.equal(sends[0].to, '5571999990000');
});
