function readNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readTimestamp(value) {
  const timestamp = readNonEmptyString(value);

  return timestamp !== null && !Number.isNaN(Date.parse(timestamp)) ? timestamp : null;
}

function normalizeInboundResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const message = result.message;
  const waId = readNonEmptyString(result.from);
  const infobipMessageId = readNonEmptyString(result.messageId);
  const messageType = readNonEmptyString(message?.type);

  if (waId === null || infobipMessageId === null || messageType === null) {
    return null;
  }

  return {
    contact: {
      waId,
      profileName: readNonEmptyString(result.contact?.name),
      lastMessageAt: readTimestamp(result.receivedAt),
    },
    message: {
      infobipMessageId,
      waId,
      direction: 'in',
      body: readNonEmptyString(message.text),
      messageType: messageType.toLowerCase(),
      status: 'received',
      createdAt: readTimestamp(result.receivedAt),
    },
  };
}

function normalizeDeliveryStatus(value) {
  return readNonEmptyString(value)?.toLowerCase() ?? null;
}

function normalizeDeliveryReportResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const infobipMessageId = readNonEmptyString(result.messageId);
  const status = normalizeDeliveryStatus(result.status?.name ?? result.status?.groupName);

  if (infobipMessageId === null || status === null) {
    return null;
  }

  return {
    infobipMessageId,
    status,
    errorCode: readNonEmptyString(result.error?.name) ?? readNonEmptyString(result.error?.id),
    statusUpdatedAt: readTimestamp(result.doneAt),
  };
}

// Coexistence echoes carry the epoch in seconds as a string (e.g. "1790362521"),
// not the ISO 8601 used by the results[] shape.
function readEpochSecondsTimestamp(value) {
  const seconds = readNonEmptyString(value);

  if (seconds === null || !/^\d+$/.test(seconds)) {
    return null;
  }

  const date = new Date(Number(seconds) * 1000);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// A message sent from the WhatsApp Business App on the coexistence number.
// `to` is the patient and is kept exactly as received (no digit normalization).
function normalizeMessageEcho(echo) {
  if (echo === null || typeof echo !== 'object' || Array.isArray(echo)) {
    return null;
  }

  const waId = readNonEmptyString(echo.to);
  const infobipMessageId = readNonEmptyString(echo.id);
  const messageType = readNonEmptyString(echo.type);

  if (waId === null || infobipMessageId === null || messageType === null) {
    return null;
  }

  const createdAt = readEpochSecondsTimestamp(echo.timestamp);

  return {
    contact: {
      waId,
      profileName: null,
      lastMessageAt: createdAt,
    },
    message: {
      infobipMessageId,
      waId,
      direction: 'out',
      sentVia: 'business_app',
      body: readNonEmptyString(echo.text?.body),
      messageType: messageType.toLowerCase(),
      status: 'sent',
      createdAt,
    },
  };
}

// Meta-style envelope (entry[].changes[].value) observed on 2026-09-25 for the
// coexistence `smb_message_echoes` event. Other change fields (e.g. history
// sync) have no captured payload yet and are counted as ignored.
function normalizeEntryPayload(entries) {
  const inboundMessages = [];
  let ignored = 0;

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    if (changes.length === 0) {
      ignored += 1;
    }

    for (const change of changes) {
      const echoes = change?.field === 'smb_message_echoes' ? change.value?.messageEchoes : undefined;

      if (!Array.isArray(echoes) || echoes.length === 0) {
        ignored += 1;
        continue;
      }

      for (const echo of echoes) {
        const normalized = normalizeMessageEcho(echo);

        if (normalized === null) {
          ignored += 1;
        } else {
          inboundMessages.push(normalized);
        }
      }
    }
  }

  return { inboundMessages, deliveryReports: [], ignored };
}

function normalizeInfobipWebhookPayload(payload) {
  if (payload !== null && typeof payload === 'object' && Array.isArray(payload.entry)) {
    return normalizeEntryPayload(payload.entry);
  }

  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    return { inboundMessages: [], deliveryReports: [], ignored: 1 };
  }

  const normalizedResults = payload.results.map((result) => ({
    inboundMessage: normalizeInboundResult(result),
    deliveryReport: normalizeDeliveryReportResult(result),
  }));
  const inboundMessages = normalizedResults
    .map(({ inboundMessage }) => inboundMessage)
    .filter((normalized) => normalized !== null);
  const deliveryReports = normalizedResults
    .map(({ deliveryReport }) => deliveryReport)
    .filter((normalized) => normalized !== null);

  return {
    inboundMessages,
    deliveryReports,
    ignored: normalizedResults.filter(({ inboundMessage, deliveryReport }) => (
      inboundMessage === null && deliveryReport === null
    )).length,
  };
}

export { normalizeInfobipWebhookPayload };
