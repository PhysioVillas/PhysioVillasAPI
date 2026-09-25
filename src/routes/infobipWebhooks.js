import { Router } from 'express';
import { hasExpectedBearerToken } from '../middleware/bearerToken.js';
import { normalizeInfobipWebhookPayload } from '../services/infobipWebhookNormalizer.js';

const MAX_CAPTURED_PAYLOADS = 20;

function createInfobipWebhooksRouter({
  database,
  webhookToken,
  captureUnmappedPayloads = false,
  allowUnauthenticatedInbound = false,
} = {}) {
  const router = Router();
  const capturedPayloads = [];

  router.post('/inbound', async (request, response, next) => {
    if (database === undefined || typeof webhookToken !== 'string' || webhookToken === '') {
      return response.status(503).json({
        error: {
          code: 'WEBHOOK_NOT_CONFIGURED',
          message: 'Webhook receiver is not configured.',
        },
      });
    }

    // TEMPORARY (SET-04 payload capture): Infobip's subscription UI only
    // offers Basic/Hmac/OAuth, not a raw Bearer header, so the deployed
    // subscription is unauthenticated while we capture the real
    // smb_message_echoes payload. Revert this flag once the parser (API-02)
    // is implemented and a compatible auth mechanism is configured.
    if (!allowUnauthenticatedInbound && !hasExpectedBearerToken(request, webhookToken)) {
      return response.status(401).json({
        error: {
          code: 'UNAUTHORIZED_WEBHOOK',
          message: 'Webhook authorization failed.',
        },
      });
    }

    try {
      const { inboundMessages, deliveryReports, ignored } = normalizeInfobipWebhookPayload(request.body);

      for (const normalized of inboundMessages) {
        await database.persistWebhookMessage(normalized);
      }

      for (const report of deliveryReports) {
        await database.recordDeliveryStatus(report);
      }

      const accepted = inboundMessages.length + deliveryReports.length;

      if (captureUnmappedPayloads && ignored > 0) {
        capturedPayloads.push({ capturedAt: new Date().toISOString(), payload: request.body });

        if (capturedPayloads.length > MAX_CAPTURED_PAYLOADS) {
          capturedPayloads.shift();
        }
      }

      return response.status(accepted > 0 ? 200 : 202).json({
        accepted,
        ignored,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/debug-log', (request, response) => {
    if (!captureUnmappedPayloads) {
      return response.status(404).json({
        error: {
          code: 'DEBUG_LOG_DISABLED',
          message: 'Unmapped payload capture is not enabled.',
        },
      });
    }

    if (typeof webhookToken !== 'string' || webhookToken === '' || !hasExpectedBearerToken(request, webhookToken)) {
      return response.status(401).json({
        error: {
          code: 'UNAUTHORIZED_WEBHOOK',
          message: 'Webhook authorization failed.',
        },
      });
    }

    return response.status(200).json({ capturedPayloads });
  });

  return router;
}

export { createInfobipWebhooksRouter };
