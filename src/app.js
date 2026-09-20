import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { errorHandler, notFoundHandler } from './middleware/errorHandlers.js';
import { openApiDocument } from './openapi.js';
import { createHealthRouter } from './routes/health.js';
import { createInfobipWebhooksRouter } from './routes/infobipWebhooks.js';
import { createMessagesRouter } from './routes/messages.js';

function createApp({
  database,
  infobipWebhookToken,
  messagesClient,
  whatsappSender,
  chatManagerApiToken,
} = {}) {
  const app = express();

  app.use(express.json({ limit: '64kb' }));
  app.get('/docs.json', (_request, response) => response.json(openApiDocument));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
    customSiteTitle: 'ChatManager API Docs',
  }));
  app.use('/health', createHealthRouter({ database }));
  app.use('/webhooks/infobip', createInfobipWebhooksRouter({
    database,
    webhookToken: infobipWebhookToken,
  }));
  app.use('/messages', createMessagesRouter({
    client: messagesClient,
    sender: whatsappSender,
    apiToken: chatManagerApiToken,
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();

export { app, createApp };
export default app;
