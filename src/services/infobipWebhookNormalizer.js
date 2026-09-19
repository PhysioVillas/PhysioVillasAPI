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

function normalizeInfobipInboundPayload(payload) {
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    return { messages: [], ignored: 1 };
  }

  const messages = payload.results
    .map(normalizeInboundResult)
    .filter((normalized) => normalized !== null);

  return { messages, ignored: payload.results.length - messages.length };
}

export { normalizeInfobipInboundPayload };
