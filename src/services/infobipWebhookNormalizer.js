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

function normalizeInfobipWebhookPayload(payload) {
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
