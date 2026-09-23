import { Router } from 'express';
import { hasExpectedBearerToken } from '../middleware/bearerToken.js';
import { InfobipMessagesApiError } from '../services/infobipMessagesClient.js';

function createMessagesRouter({ client, database, sender, apiToken } = {}) {
  const router = Router();

  function isConfigured() {
    return client === undefined || typeof sender !== 'string' || sender === '' ||
      typeof apiToken !== 'string' || apiToken === '';
  }

  function rejectUnavailable(response, operation = 'validation') {
    return response.status(503).json({
      error: {
        code: 'MESSAGES_API_NOT_CONFIGURED',
        message: operation === 'send'
          ? 'Messages sending is not configured.'
          : 'Messages validation is not configured.',
      },
    });
  }

  function isSendConfigured() {
    return !isConfigured() &&
      typeof client.sendTextMessage === 'function' &&
      typeof client.sendTemplateMessage === 'function' &&
      typeof database?.persistOutboundMessage === 'function';
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

  function mapInfobipError(error, response, next, operation) {
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
          code: operation === 'send' ? 'INFOBIP_SEND_FAILED' : 'INFOBIP_VALIDATION_FAILED',
          message: operation === 'send'
            ? 'Infobip rejected the message send request.'
            : 'Infobip rejected the message validation request.',
          upstreamStatus: error.status,
          details: error.details,
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
      return mapInfobipError(error, response, next, 'validate');
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
      return mapInfobipError(error, response, next, 'validate');
    }
  });

  async function sendMessage(request, response, next, { method, type, body }) {
    if (!isSendConfigured()) {
      return rejectUnavailable(response, 'send');
    }

    if (rejectUnauthorized(request, response)) {
      return undefined;
    }

    const { to, sendAt } = request.body ?? {};

    let providerResponse;

    try {
      providerResponse = await client[method]({
        sender,
        to,
        ...body(request.body ?? {}),
        sendAt,
      });
    } catch (error) {
      return mapInfobipError(error, response, next, 'send');
    }

    const receipt = providerResponse?.messages?.[0];
    const messageId = typeof receipt?.messageId === 'string'
      ? receipt.messageId.trim()
      : '';
    const status = typeof receipt?.status?.name === 'string' && receipt.status.name.trim() !== ''
      ? receipt.status.name.trim()
      : 'accepted';

    if (messageId === '') {
      return response.status(502).json({
        error: {
          code: 'INFOBIP_INVALID_RESPONSE',
          message: 'Infobip did not return a message identifier. Do not retry automatically.',
        },
      });
    }

    try {
      const stored = await database.persistOutboundMessage({
        infobipMessageId: messageId,
        waId: to,
        body: type === 'template' ? `template:${request.body.templateName}` : request.body.text,
        messageType: type,
        status,
      });

      return response.status(202).json({
        messageId,
        status,
        scheduled: sendAt !== undefined,
        persisted: Boolean(stored?.message),
      });
    } catch {
      return response.status(202).json({
        messageId,
        status,
        scheduled: sendAt !== undefined,
        persisted: false,
        warning: 'Infobip accepted the message, but the receipt was not persisted. Do not retry; reconcile this messageId manually.',
      });
    }
  }

  router.post('/send', async (request, response, next) => sendMessage(request, response, next, {
    method: 'sendTextMessage',
    type: 'text',
    body: ({ text }) => ({ text }),
  }));

  router.post('/templates/send', async (request, response, next) => sendMessage(request, response, next, {
    method: 'sendTemplateMessage',
    type: 'template',
    body: ({ templateName, language, parameters }) => ({
      templateName,
      language,
      parameters,
    }),
  }));

  return router;
}

export { createMessagesRouter };
