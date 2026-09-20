import { createApp } from './app.js';
import { getRuntimeConfig, requireInfobipConfig } from './config/runtimeConfig.js';
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
  });

  return { app, config };
}

export { createRuntimeApp };
