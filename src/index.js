import { createApp } from './app.js';
import { getRuntimeConfig, requireInfobipConfig } from './config/runtimeConfig.js';
import { createDatabase } from './services/database.js';
import { createInfobipMessagesClient } from './services/infobipMessagesClient.js';

const config = getRuntimeConfig();
const database = config.databaseUrl === undefined
  ? undefined
  : createDatabase({ connectionString: config.databaseUrl });
const hasInfobipMessagesConfig = config.infobip.baseUrl !== undefined &&
  config.infobip.apiKey !== undefined && config.infobip.whatsappSender !== undefined;
const infobipMessagesConfig = hasInfobipMessagesConfig
  ? requireInfobipConfig(config)
  : undefined;
const messagesClient = infobipMessagesConfig === undefined
  ? undefined
  : createInfobipMessagesClient(infobipMessagesConfig);
const app = createApp({
  database,
  infobipWebhookToken: config.infobip.webhookToken,
  messagesClient,
  whatsappSender: infobipMessagesConfig?.whatsappSender,
  chatManagerApiToken: config.chatManagerApiToken,
});

app.listen(config.port, () => {
  console.log(`ChatManager API listening on port ${config.port}`);
});
