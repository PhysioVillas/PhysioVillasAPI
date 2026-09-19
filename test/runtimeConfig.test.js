import assert from 'node:assert/strict';
import test from 'node:test';
import { getRuntimeConfig, requireInfobipConfig } from '../src/config/runtimeConfig.js';

test('runtime configuration has safe defaults and does not require integrations at startup', () => {
  assert.deepEqual(getRuntimeConfig({}), {
    port: 3000,
    databaseUrl: undefined,
    chatManagerApiToken: undefined,
    infobip: {
      apiKey: undefined,
      baseUrl: undefined,
      whatsappSender: undefined,
      webhookToken: undefined,
    },
  });
});

test('runtime configuration trims supplied values and validates the port', () => {
  const config = getRuntimeConfig({
    PORT: ' 8080 ',
    DATABASE_URL: ' postgres://database ',
    CHATMANAGER_API_TOKEN: ' internal-token ',
    INFOBIP_BASE_URL: ' https://tenant.example ',
    INFOBIP_API_KEY: ' secret ',
    INFOBIP_WHATSAPP_SENDER: ' sender ',
    INFOBIP_WEBHOOK_TOKEN: ' receiver-token ',
  });

  assert.equal(config.port, 8080);
  assert.equal(config.databaseUrl, 'postgres://database');
  assert.equal(config.chatManagerApiToken, 'internal-token');
  assert.equal(config.infobip.webhookToken, 'receiver-token');
  assert.deepEqual(requireInfobipConfig(config), {
    baseUrl: 'https://tenant.example',
    apiKey: 'secret',
    whatsappSender: 'sender',
  });
  assert.throws(() => getRuntimeConfig({ PORT: 'bad' }), /PORT must be an integer/);
});

test('Infobip configuration reports missing variable names without their values', () => {
  assert.throws(
    () => requireInfobipConfig(getRuntimeConfig({ INFOBIP_API_KEY: 'secret' })),
    /INFOBIP_BASE_URL, INFOBIP_WHATSAPP_SENDER/,
  );
});
