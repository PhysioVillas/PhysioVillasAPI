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

// WhatsApp interactive limits enforced by Meta/Infobip. A request that
// exceeds any of them is rejected upstream, so they are checked locally first.
const WHATSAPP_LIMITS = {
  bodyText: 1024,
  headerText: 60,
  footerText: 60,
  listActionTitle: 20,
  listSectionTitle: 24,
  listRows: 10,
  listRowId: 200,
  listRowTitle: 24,
  listRowDescription: 72,
  buttons: 3,
  buttonId: 256,
  buttonTitle: 20,
};

function characterCount(value) {
  return Array.from(value).length;
}

function requireText(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required.`);
  }

  if (maxLength !== undefined && characterCount(value) > maxLength) {
    throw new TypeError(`${name} must have at most ${maxLength} characters.`);
  }

  return value;
}

function requirePlainTitle(value, name, maxLength) {
  requireText(value, name, maxLength);

  if (/\p{Extended_Pictographic}|[*_~`]/u.test(value)) {
    throw new TypeError(`${name} must not contain emojis or markdown.`);
  }

  return value;
}

function requireUnique(values, name) {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${name} must be unique.`);
  }
}

function buildInteractiveFrame({ sender, to, header, body, footer }) {
  const content = {
    body: { text: requireText(body, 'body', WHATSAPP_LIMITS.bodyText) },
  };

  if (header !== undefined) {
    content.header = { type: 'TEXT', text: requireText(header, 'header', WHATSAPP_LIMITS.headerText) };
  }

  if (footer !== undefined) {
    content.footer = { text: requireText(footer, 'footer', WHATSAPP_LIMITS.footerText) };
  }

  return {
    from: requireText(sender, 'sender'),
    to: requireText(to, 'to'),
    content,
  };
}

function buildWhatsAppTextMessage({ sender, to, text }) {
  return {
    from: requireText(sender, 'sender'),
    to: requireText(to, 'to'),
    content: { text: requireText(text, 'text', 4096) },
  };
}

function buildInteractiveListMessage({ sender, to, header, body, footer, buttonTitle, sections }) {
  const message = buildInteractiveFrame({ sender, to, header, body, footer });

  if (!Array.isArray(sections) || sections.length === 0) {
    throw new TypeError('sections must be a non-empty array.');
  }

  const rows = sections.flatMap((section) => (Array.isArray(section?.rows) ? section.rows : []));

  if (rows.length < 1 || rows.length > WHATSAPP_LIMITS.listRows) {
    throw new TypeError(`A list must have between 1 and ${WHATSAPP_LIMITS.listRows} rows in total.`);
  }

  requireUnique(rows.map((row) => row?.id), 'row ids');

  message.content.action = {
    title: requirePlainTitle(buttonTitle, 'buttonTitle', WHATSAPP_LIMITS.listActionTitle),
    sections: sections.map((section) => {
      if (!Array.isArray(section?.rows) || section.rows.length === 0) {
        throw new TypeError('Each section must have at least one row.');
      }

      const built = {
        rows: section.rows.map((row) => {
          const builtRow = {
            id: requireText(row.id, 'row id', WHATSAPP_LIMITS.listRowId),
            title: requireText(row.title, 'row title', WHATSAPP_LIMITS.listRowTitle),
          };

          if (row.description !== undefined) {
            builtRow.description = requireText(
              row.description,
              'row description',
              WHATSAPP_LIMITS.listRowDescription,
            );
          }

          return builtRow;
        }),
      };

      if (section.title !== undefined) {
        built.title = requireText(section.title, 'section title', WHATSAPP_LIMITS.listSectionTitle);
      } else if (sections.length > 1) {
        throw new TypeError('section title is required when a list has more than one section.');
      }

      return built;
    }),
  };

  return message;
}

function buildInteractiveButtonsMessage({ sender, to, header, body, footer, buttons }) {
  const message = buildInteractiveFrame({ sender, to, header, body, footer });

  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > WHATSAPP_LIMITS.buttons) {
    throw new TypeError(`buttons must have between 1 and ${WHATSAPP_LIMITS.buttons} items.`);
  }

  requireUnique(buttons.map((button) => button?.id), 'button ids');
  requireUnique(buttons.map((button) => button?.title), 'button titles');

  message.content.action = {
    buttons: buttons.map((button) => ({
      type: 'REPLY',
      id: requireText(button.id, 'button id', WHATSAPP_LIMITS.buttonId).trim(),
      title: requirePlainTitle(button.title, 'button title', WHATSAPP_LIMITS.buttonTitle),
    })),
  };

  return message;
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

  // Session replies (inside the 24-hour window) through the dedicated
  // WhatsApp API, used by the FAQ bot. They return a single
  // { to, messageCount, messageId, status } receipt.
  async function sendWhatsAppText(message) {
    return requestMessagesApi('/whatsapp/1/message/text', buildWhatsAppTextMessage(message));
  }

  async function sendWhatsAppInteractiveList(message) {
    return requestMessagesApi('/whatsapp/1/message/interactive/list', buildInteractiveListMessage(message));
  }

  async function sendWhatsAppInteractiveButtons(message) {
    return requestMessagesApi('/whatsapp/1/message/interactive/buttons', buildInteractiveButtonsMessage(message));
  }

  return {
    sendTemplateMessage,
    sendTextMessage,
    sendWhatsAppInteractiveButtons,
    sendWhatsAppInteractiveList,
    sendWhatsAppText,
    validateTemplateMessage,
    validateTextMessage,
  };
}

export {
  InfobipMessagesApiError,
  WHATSAPP_LIMITS,
  buildInteractiveButtonsMessage,
  buildInteractiveListMessage,
  buildTextMessage,
  buildTemplateMessage,
  buildWhatsAppTextMessage,
  createInfobipMessagesClient,
  validateSendAt,
};
