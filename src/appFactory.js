import express from 'express';
import { errorHandler, notFoundHandler } from './middleware/errorHandlers.js';
import { openApiDocument } from './openapi.js';
import { renderDocsHtml } from './routes/docsPage.js';
import { createHealthRouter } from './routes/health.js';
import { createInfobipWebhooksRouter } from './routes/infobipWebhooks.js';
import { createMessagesRouter } from './routes/messages.js';

function createApp({
  database,
  infobipWebhookToken,
  infobipWebhookHmacSecret,
  infobipWebhookHmacAlgorithm,
  messagesClient,
  whatsappSender,
  // Kept for compatibility: the old agenda path in `public` that used it is
  // disabled since T17 (appointmentService.js stays, unused).
  appointmentConfirmationUtcOffset: _appointmentConfirmationUtcOffset,
  bot,
  chatManagerApiToken,
  captureUnmappedWebhookPayloads = false,
  allowUnauthenticatedInbound = false,
} = {}) {
  const app = express();

  app.use(express.json({
    limit: '64kb',
    verify(request, _response, buffer) {
      request.rawBody = Buffer.from(buffer);
    },
  }));
  app.get('/docs.json', (_request, response) => response.json(openApiDocument));
  app.get('/docs', (_request, response) => {
    response.type('html').send(renderDocsHtml());
  });
  app.use('/health', createHealthRouter({ database }));
  app.use('/webhooks/infobip', createInfobipWebhooksRouter({
    database,
    webhookToken: infobipWebhookToken,
    webhookHmacSecret: infobipWebhookHmacSecret,
    webhookHmacAlgorithm: infobipWebhookHmacAlgorithm,
    bot,
    captureUnmappedPayloads: captureUnmappedWebhookPayloads,
    allowUnauthenticatedInbound,
  }));
  app.use('/messages', createMessagesRouter({
    client: messagesClient,
    database,
    sender: whatsappSender,
    apiToken: chatManagerApiToken,
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export { createApp };
