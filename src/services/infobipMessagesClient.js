class InfobipMessagesApiError extends Error {
  constructor({ status, details }) {
    super('Infobip Messages API request failed.');
    this.name = 'InfobipMessagesApiError';
    this.status = status;
    this.details = details;
  }
}

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new TypeError('Infobip base URL is required.');
  }

  return baseUrl.trim().replace(/\/$/, '');
}

function validateSendAt(sendAt) {
  if (sendAt === undefined) {
    return;
  }

  const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

  if (
    typeof sendAt !== 'string' ||
    !timestampPattern.test(sendAt) ||
    Number.isNaN(Date.parse(sendAt))
  ) {
    throw new TypeError('sendAt must be a valid ISO 8601 timestamp when provided.');
  }

  if (Date.parse(sendAt) <= Date.now()) {
    throw new TypeError('sendAt must be in the future when provided.');
  }
}

function buildTextMessage({ sender, to, text, sendAt }) {
  if (
    typeof sender !== 'string' || sender.trim() === '' ||
    typeof to !== 'string' || to.trim() === '' ||
    typeof text !== 'string' || text.trim() === ''
  ) {
    throw new TypeError('sender, to, and text are required.');
  }

  validateSendAt(sendAt);

  const message = {
    channel: 'WHATSAPP',
    sender,
    destinations: [{ to }],
    content: {
      body: {
        type: 'TEXT',
        text,
      },
    },
  };

  if (sendAt !== undefined) {
    message.sendAt = sendAt;
  }

  return { messages: [message] };
}

function buildTemplateMessage({ sender, to, templateName, language, parameters = [], sendAt }) {
  if (
    typeof sender !== 'string' || sender.trim() === '' ||
    typeof to !== 'string' || to.trim() === '' ||
    typeof templateName !== 'string' || templateName.trim() === '' ||
    typeof language !== 'string' || language.trim() === ''
  ) {
    throw new TypeError('sender, to, templateName, and language are required.');
  }

  if (!Array.isArray(parameters) || parameters.some((value) => (
    typeof value !== 'string' || value.trim() === ''
  ))) {
    throw new TypeError('parameters must be an array of non-empty strings.');
  }

  validateSendAt(sendAt);

  const body = { type: 'TEXT' };

  parameters.forEach((value, index) => {
    body[index + 1] = value;
  });

  const message = {
    channel: 'WHATSAPP',
    sender,
    destinations: [{ to }],
    content: { body },
    template: { templateName, language },
  };

  if (sendAt !== undefined) {
    message.sendAt = sendAt;
  }

  return { messages: [message] };
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function createInfobipMessagesClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('Infobip API key is required.');
  }

  async function requestMessagesApi(path, message) {
    let response;

    try {
      response = await fetchImpl(
        `${normalizedBaseUrl}${path}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `App ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(message),
        },
      );
    } catch {
      throw new InfobipMessagesApiError({
        status: null,
        details: { code: 'INFOBIP_UNAVAILABLE' },
      });
    }

    const details = await parseJson(response);

    if (!response.ok) {
      throw new InfobipMessagesApiError({
        status: response.status,
        details,
      });
    }

    return details;
  }

  async function validateTextMessage(message) {
    return requestMessagesApi('/messages-api/1/messages/validate', buildTextMessage(message));
  }

  async function validateTemplateMessage(message) {
    return requestMessagesApi('/messages-api/1/messages/validate', buildTemplateMessage(message));
  }

  async function sendTextMessage(message) {
    return requestMessagesApi('/messages-api/1/messages', buildTextMessage(message));
  }

  async function sendTemplateMessage(message) {
    return requestMessagesApi('/messages-api/1/messages', buildTemplateMessage(message));
  }

  return {
    sendTemplateMessage,
    sendTextMessage,
    validateTemplateMessage,
    validateTextMessage,
  };
}

export {
  InfobipMessagesApiError,
  buildTextMessage,
  buildTemplateMessage,
  createInfobipMessagesClient,
  validateSendAt,
};
