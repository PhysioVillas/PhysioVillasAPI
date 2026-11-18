import { Router } from 'express';
import { hasExpectedBearerToken } from '../middleware/bearerToken.js';
import { isAuthenticatedInfobipWebhook } from '../middleware/infobipWebhookAuth.js';
import { normalizeInfobipWebhookPayload } from '../services/infobipWebhookNormalizer.js';

const MAX_CAPTURED_PAYLOADS = 20;

// The inbound message is already persisted: a bot failure is logged and the
// webhook still succeeds, because a retry would not trigger the bot again.
async function replyWithFaqBot(faqBot, message) {
  try {
    await faqBot.handleInbound({
      waId: message.waId,
      messageType: message.messageType,
      replyId: message.replyId,
      body: message.body,
      ...(message.appointmentResult === undefined ? {} : { appointmentResult: message.appointmentResult }),
    });
  } catch (error) {
    console.error('FAQ bot reply failed.', {
      name: error?.name ?? 'Error',
      upstreamStatus: error?.status,
      details: error?.details,
    });
  }
}

function createInfobipWebhooksRouter({
  database,
  webhookToken,
  webhookHmacSecret,
  webhookHmacAlgorithm,
  faqBot,
  captureUnmappedPayloads = false,
  allowUnauthenticatedInbound = false,
  appointmentCommandBoundary,
  appointmentService,
} = {}) {
  const router = Router();
  const capturedPayloads = [];

  router.post('/inbound', async (request, response, next) => {
    if (database === undefined || ((typeof webhookToken !== 'string' || webhookToken === '') && (typeof webhookHmacSecret !== 'string' || webhookHmacSecret === ''))) {
      return response.status(503).json({
        error: {
          code: 'WEBHOOK_NOT_CONFIGURED',
          message: 'Webhook receiver is not configured.',
        },
      });
    }

    const webhookAuthenticated = isAuthenticatedInfobipWebhook(request, {
      webhookToken,
      hmacSecret: webhookHmacSecret,
      hmacAlgorithm: webhookHmacAlgorithm,
    });

    // allowUnauthenticatedInbound (padrão false) só é ligado em src/bootstrap.js
    // porque o sistema ainda é uma POC sem clientes reais. Mesmo assim,
    // webhookAuthenticated continua false e a agenda não recebe permissão.
    if (!webhookAuthenticated && allowUnauthenticatedInbound) {
      // Só os NOMES dos headers (sem valores), para descobrir como a Infobip
      // assina o webhook quando o HMAC for configurado.
      console.warn('POC: accepting unauthenticated Infobip webhook.', {
        headerNames: Object.keys(request.headers ?? {}),
      });
    }

    if (!webhookAuthenticated && !allowUnauthenticatedInbound) {
      return response.status(401).json({
        error: {
          code: 'UNAUTHORIZED_WEBHOOK',
          message: 'Webhook authorization failed.',
        },
      });
    }

    try {
      const { inboundMessages, deliveryReports, ignored } = normalizeInfobipWebhookPayload(request.body);
      const appointmentPrincipal = appointmentCommandBoundary?.createVerifiedWebhookPrincipal({ webhookAuthenticated });

      for (const normalized of inboundMessages) {
        let appointmentResult;
        const persisted = await database.persistWebhookMessage(normalized);
        let appointmentMessage = persisted?.message ?? null;

        // Appointment effects may have failed after message persistence
        // committed. On an authenticated retry, recover the stored row ID so
        // the appointment transaction can safely retry using its idempotency
        // key. The FAQ bot remains restricted to newly persisted messages.
        if (
          appointmentMessage === null &&
          appointmentPrincipal !== null &&
          appointmentPrincipal !== undefined &&
          appointmentService !== undefined &&
          typeof normalized.message.infobipMessageId === 'string' &&
          normalized.message.infobipMessageId !== '' &&
          typeof database.findPersistedMessageIdByInfobipId === 'function'
        ) {
          const messageId = await database.findPersistedMessageIdByInfobipId(normalized.message.infobipMessageId);
          if (messageId !== null && messageId !== undefined) {
            appointmentMessage = { id: messageId };
          }
        }

        if (
          appointmentPrincipal !== null &&
          appointmentPrincipal !== undefined &&
          appointmentService !== undefined &&
          appointmentMessage !== null
        ) {
          appointmentResult = await appointmentService.handleVerifiedWebhookMessage({
            principal: appointmentPrincipal,
            message: normalized.message,
            persistedMessage: appointmentMessage,
          });
        }

        // Only a newly stored patient message triggers the bot, so an
        // Infobip retry of the same messageId never sends a second reply.
        if (faqBot !== undefined && normalized.message.direction === 'in' && persisted?.message) {
          await replyWithFaqBot(faqBot, { ...normalized.message, appointmentResult });
        }
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
