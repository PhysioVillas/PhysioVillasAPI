import { Router } from 'express';
import { hasExpectedBearerToken } from '../middleware/bearerToken.js';
import { InfobipMessagesApiError } from '../services/infobipMessagesClient.js';

function createMessagesRouter({ client, sender, apiToken } = {}) {
  const router = Router();

  function isConfigured() {
    return client === undefined || typeof sender !== 'string' || sender === '' ||
      typeof apiToken !== 'string' || apiToken === '';
  }

  function rejectUnavailable(response) {
    return response.status(503).json({
      error: {
        code: 'MESSAGES_API_NOT_CONFIGURED',
        message: 'Messages validation is not configured.',
      },
    });
  }

  function rejectUnauthorized(request, response) {
    if (hasExpectedBearerToken(request, apiToken)) {
      return false;
    }

    response.status(401).json({
      error: {
        code: 'UNAUTHORIZED_API_REQUEST',
        message: 'API authorization failed.',
      },
    });
    return true;
  }

  function mapValidationError(error, response, next) {
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

  router.post('/validate', async (request, response, next) => {
    if (isConfigured()) {
      return rejectUnavailable(response);
    }

    if (rejectUnauthorized(request, response)) {
      return undefined;
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
      return mapValidationError(error, response, next);
    }
  });

  router.post('/templates/validate', async (request, response, next) => {
    if (isConfigured()) {
      return rejectUnavailable(response);
    }

    if (rejectUnauthorized(request, response)) {
      return undefined;
    }

    try {
      const validation = await client.validateTemplateMessage({
        sender,
        to: request.body?.to,
        templateName: request.body?.templateName,
        language: request.body?.language,
        parameters: request.body?.parameters,
        sendAt: request.body?.sendAt,
      });

      return response.status(200).json({ validation });
    } catch (error) {
      return mapValidationError(error, response, next);
    }
  });

  return router;
}

export { createMessagesRouter };
