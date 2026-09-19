function readOptional(env, name) {
  const value = env[name];

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readPort(env) {
  const value = readOptional(env, 'PORT');

  if (value === undefined) {
    return 3000;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('PORT must be an integer between 1 and 65535.');
  }

  return port;
}

function getRuntimeConfig(env = process.env) {
  return {
    port: readPort(env),
    databaseUrl: readOptional(env, 'DATABASE_URL'),
    chatManagerApiToken: readOptional(env, 'CHATMANAGER_API_TOKEN'),
    infobip: {
      apiKey: readOptional(env, 'INFOBIP_API_KEY'),
      baseUrl: readOptional(env, 'INFOBIP_BASE_URL'),
      whatsappSender: readOptional(env, 'INFOBIP_WHATSAPP_SENDER'),
      webhookToken: readOptional(env, 'INFOBIP_WEBHOOK_TOKEN'),
    },
  };
}

function requireInfobipConfig(config) {
  const missing = [
    ['INFOBIP_BASE_URL', config.infobip.baseUrl],
    ['INFOBIP_API_KEY', config.infobip.apiKey],
    ['INFOBIP_WHATSAPP_SENDER', config.infobip.whatsappSender],
  ]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new TypeError(`Missing required Infobip configuration: ${missing.join(', ')}.`);
  }

  return {
    baseUrl: config.infobip.baseUrl,
    apiKey: config.infobip.apiKey,
    whatsappSender: config.infobip.whatsappSender,
  };
}

export { getRuntimeConfig, requireInfobipConfig };
