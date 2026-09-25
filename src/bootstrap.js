import { getRuntimeConfig, requireInfobipConfig } from './config/runtimeConfig.js';
import { createApp } from './appFactory.js';
import { createDatabase } from './services/database.js';
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
  const app = createApp({
    database,
    infobipWebhookToken: config.infobip.webhookToken,
    messagesClient,
    whatsappSender: infobipMessagesConfig?.whatsappSender,
    chatManagerApiToken: config.chatManagerApiToken,
    captureUnmappedWebhookPayloads: database !== undefined && config.infobip.webhookToken !== undefined,
    // allowUnauthenticatedInbound was enabled only to capture the real
    // smb_message_echoes payload on 2026-09-25 and has been reverted; the
    // inbound webhook requires the Bearer token again (default false).
  });

  return { app, config };
}

export { createRuntimeApp };
