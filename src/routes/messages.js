import { Router } from 'express';
import { hasExpectedBearerToken } from '../middleware/bearerToken.js';
import { InfobipMessagesApiError } from '../services/infobipMessagesClient.js';

function createMessagesRouter({ client, sender, apiToken } = {}) {
  const router = Router();

  router.post('/validate', async (request, response, next) => {
    if (client === undefined || typeof sender !== 'string' || sender === '' ||
      typeof apiToken !== 'string' || apiToken === '') {
      return response.status(503).json({
        error: {
          code: 'MESSAGES_API_NOT_CONFIGURED',
          message: 'Messages validation is not configured.',
        },
      });
    }

    if (!hasExpectedBearerToken(request, apiToken)) {
      return response.status(401).json({
        error: {
          code: 'UNAUTHORIZED_API_REQUEST',
          message: 'API authorization failed.',
        },
      });
    }

    try {
      const validation = await client.validateTextMessage({
        sender,
        to: request.body?.to,
        text: request.body?.text,
        sendAt: request.body?.sendAt,
      });

      return response.status(200).json({ validation });
    } catch (error) {
      if (error instanceof TypeError) {
        return response.status(400).json({
          error: {
            code: 'INVALID_MESSAGE_REQUEST',
            message: 'Message validation request is invalid.',
          },
        });
      }

      if (error instanceof InfobipMessagesApiError) {
        return response.status(502).json({
          error: {
            code: 'INFOBIP_VALIDATION_FAILED',
            message: 'Infobip rejected the message validation request.',
          },
        });
      }

      return next(error);
    }
  });

  return router;
}

export { createMessagesRouter };
