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

function buildTextMessage({ sender, to, text, sendAt }) {
  if (!sender || !to || !text) {
    throw new TypeError('sender, to, and text are required.');
  }

  if (sendAt !== undefined && (
    typeof sendAt !== 'string' || Number.isNaN(Date.parse(sendAt))
  )) {
    throw new TypeError('sendAt must be a valid ISO 8601 timestamp when provided.');
  }

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
  if (!sender || !to || !templateName || !language) {
    throw new TypeError('sender, to, templateName, and language are required.');
  }

  if (!Array.isArray(parameters) || parameters.some((value) => (
    typeof value !== 'string' || value.trim() === ''
  ))) {
    throw new TypeError('parameters must be an array of non-empty strings.');
  }

  if (sendAt !== undefined && (
    typeof sendAt !== 'string' || Number.isNaN(Date.parse(sendAt))
  )) {
    throw new TypeError('sendAt must be a valid ISO 8601 timestamp when provided.');
  }

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

  async function validateMessage(message) {
    const response = await fetchImpl(
      `${normalizedBaseUrl}/messages-api/1/messages/validate`,
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
    return validateMessage(buildTextMessage(message));
  }

  async function validateTemplateMessage(message) {
    return validateMessage(buildTemplateMessage(message));
  }

  return { validateTemplateMessage, validateTextMessage };
}

export {
  InfobipMessagesApiError,
  buildTextMessage,
  buildTemplateMessage,
  createInfobipMessagesClient,
};
