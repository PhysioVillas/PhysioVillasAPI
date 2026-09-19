import { Router } from 'express';
import { hasExpectedBearerToken } from '../middleware/bearerToken.js';
import { normalizeInfobipInboundPayload } from '../services/infobipWebhookNormalizer.js';

function createInfobipWebhooksRouter({ database, webhookToken } = {}) {
  const router = Router();

  router.post('/inbound', async (request, response, next) => {
    if (database === undefined || typeof webhookToken !== 'string' || webhookToken === '') {
      return response.status(503).json({
        error: {
          code: 'WEBHOOK_NOT_CONFIGURED',
          message: 'Webhook receiver is not configured.',
        },
      });
    }

    if (!hasExpectedBearerToken(request, webhookToken)) {
      return response.status(401).json({
        error: {
          code: 'UNAUTHORIZED_WEBHOOK',
          message: 'Webhook authorization failed.',
        },
      });
    }

    try {
      const { messages, ignored } = normalizeInfobipInboundPayload(request.body);

      for (const normalized of messages) {
        await database.persistWebhookMessage(normalized);
      }

      return response.status(messages.length > 0 ? 200 : 202).json({
        accepted: messages.length,
        ignored,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export { createInfobipWebhooksRouter };
