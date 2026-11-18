import { Router } from 'express';
import { hasExpectedBearerToken } from '../middleware/bearerToken.js';
import { isAuthenticatedInfobipWebhook } from '../middleware/infobipWebhookAuth.js';
import { maskCpfDeep, maskNormalizedMessage } from '../services/bot/index.js';
import { normalizeInfobipWebhookPayload } from '../services/infobipWebhookNormalizer.js';

const MAX_CAPTURED_PAYLOADS = 20;

// The inbound message is already persisted: a bot failure is logged (no PII)
// and the webhook still succeeds, because a retry would not trigger the bot
// again.
async function runBot(task, label) {
  try {
    await task();
  } catch (error) {
    console.error(label, {
      name: error?.name ?? 'Error',
      upstreamStatus: error?.status,
    });
  }
}

function createInfobipWebhooksRouter({
  database,
  webhookToken,
  webhookHmacSecret,
  webhookHmacAlgorithm,
  bot,
  captureUnmappedPayloads = false,
  allowUnauthenticatedInbound = false,
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
    // porque o sistema ainda é uma POC sem clientes reais. Os fluxos do bot
    // (inclusive a agenda em clinica_simulada) rodam sem autenticação até o
    // fim da POC; o caminho antigo de agenda em `public` está desligado.
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
      // The old agenda path in `public` (appointmentService) is disabled
      // since T17: scheduling now runs in the bot flows over
      // clinica_simulada, which do not require an authenticated webhook
      // (POC decision). The files stay in the repository.
      for (const normalized of inboundMessages) {
        // The CPF is masked before anything is stored; the bot gets the
        // original text only in memory.
        const persisted = await database.persistWebhookMessage(maskNormalizedMessage(normalized));

        // Only a newly stored message triggers the bot: an Infobip retry of
        // the same messageId hits `on conflict do nothing`, returns no row
        // and never produces a second reply.
        if (bot === undefined || !persisted?.message) {
          continue;
        }

        if (normalized.message.direction === 'in') {
          await runBot(() => bot.handleInbound(normalized.message), 'Bot reply failed.');
        } else if (normalized.message.sentVia === 'business_app') {
          await runBot(() => bot.handleTeamReply(normalized.message), 'Bot team reply tracking failed.');
        }
      }

      for (const report of deliveryReports) {
        await database.recordDeliveryStatus(report);
      }

      const accepted = inboundMessages.length + deliveryReports.length;

      if (captureUnmappedPayloads && ignored > 0) {
        capturedPayloads.push({ capturedAt: new Date().toISOString(), payload: maskCpfDeep(request.body) });

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
