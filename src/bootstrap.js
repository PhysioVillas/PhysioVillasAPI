import { getRuntimeConfig, requireInfobipConfig } from './config/runtimeConfig.js';
import { createApp } from './appFactory.js';
import { createDatabase } from './services/database.js';
import { createFaqBot } from './services/faqBot.js';
import { createInfobipMessagesClient } from './services/infobipMessagesClient.js';

function createRuntimeApp({
  env = process.env,
  createDatabaseFactory = createDatabase,
  createInfobipMessagesClientFactory = createInfobipMessagesClient,
} = {}) {
  const config = getRuntimeConfig(env);
  const database = config.databaseUrl === undefined
    ? undefined
    : createDatabaseFactory({ connectionString: config.databaseUrl });
  const hasInfobipMessagesConfig = config.infobip.baseUrl !== undefined &&
    config.infobip.apiKey !== undefined && config.infobip.whatsappSender !== undefined;
  const infobipMessagesConfig = hasInfobipMessagesConfig
    ? requireInfobipConfig(config)
    : undefined;
  const messagesClient = infobipMessagesConfig === undefined
    ? undefined
    : createInfobipMessagesClientFactory(infobipMessagesConfig);
  // The FAQ bot answers every patient as soon as persistence and Infobip
  // sending are configured (decided 2026-10-21 while the system has no real
  // patients yet; there is no env switch or number allowlist).
  const faqBot = database !== undefined && messagesClient !== undefined
    ? createFaqBot({
      client: messagesClient,
      database,
      sender: infobipMessagesConfig.whatsappSender,
    })
    : undefined;
  const app = createApp({
    database,
    infobipWebhookToken: config.infobip.webhookToken,
    messagesClient,
    whatsappSender: infobipMessagesConfig?.whatsappSender,
    faqBot,
    chatManagerApiToken: config.chatManagerApiToken,
    captureUnmappedWebhookPayloads: database !== undefined && config.infobip.webhookToken !== undefined,
    // TEMPORARY (decided 2026-09-25, to be resolved next sprint): the
    // Infobip subscription only offers Basic/Hmac/OAuth, not our Bearer
    // header, so production accepts inbound webhooks without authentication
    // until a permanent mechanism is chosen (SET-07).
    allowUnauthenticatedInbound: true,
  });

  return { app, config };
}

export { createRuntimeApp };
