import { getRuntimeConfig, requireInfobipConfig } from './config/runtimeConfig.js';
import { createApp } from './appFactory.js';
import { createDatabase } from './services/database.js';
import { createBot } from './services/bot/index.js';
import { createInfobipMessagesClient } from './services/infobipMessagesClient.js';

function createRuntimeApp({
  env = process.env,
  createDatabaseFactory = createDatabase,
  createInfobipMessagesClientFactory = createInfobipMessagesClient,
  createBotFactory = createBot,
} = {}) {
  const config = getRuntimeConfig(env);
  const database = config.databaseUrl === undefined
    ? undefined
    : createDatabaseFactory({ connectionString: config.databaseUrl });
  const hasInfobipMessagesConfig = config.infobip.baseUrl !== undefined &&
    config.infobip.apiKey !== undefined && config.infobip.whatsappSender !== undefined;
  const infobipMessagesConfig = hasInfobipMessagesConfig
    ? requireInfobipConfig(config)
    : undefined;
  const messagesClient = infobipMessagesConfig === undefined
    ? undefined
    : createInfobipMessagesClientFactory(infobipMessagesConfig);
  // The bot (engine + flows, T17) answers every patient as soon as
  // persistence and Infobip sending are configured (POC with mock data; there
  // is no env switch or number allowlist). It replaced the old FAQ bot
  // (src/services/faqBot.js, kept but unused) and shares the database pool.
  const bot = database !== undefined && messagesClient !== undefined
    ? createBotFactory({
      pool: database.pool,
      database,
      messagesClient,
      whatsappSender: infobipMessagesConfig.whatsappSender,
    })
    : undefined;
  const app = createApp({
    database,
    infobipWebhookToken: config.infobip.webhookToken,
    infobipWebhookHmacSecret: config.infobip.webhookHmacSecret,
    infobipWebhookHmacAlgorithm: config.infobip.webhookHmacAlgorithm,
    messagesClient,
    whatsappSender: infobipMessagesConfig?.whatsappSender,
    appointmentConfirmationUtcOffset: config.appointmentConfirmationUtcOffset,
    bot,
    chatManagerApiToken: config.chatManagerApiToken,
    captureUnmappedWebhookPayloads: database !== undefined && config.infobip.webhookToken !== undefined,
    // ⚠️ POC — WEBHOOK SEM AUTENTICAÇÃO (restaurado em 2026-11-18).
    // Este sistema ainda é uma prova de conceito em teste: nenhum cliente ou
    // paciente real usa este número. A validação HMAC (infobipWebhookAuth.js)
    // ainda não foi configurada/validada na Vercel e na subscription da
    // Infobip, e sem isso todo webhook voltava 401 e o bot parou de responder.
    // Enquanto isso, o webhook aceita requisições não autenticadas. Requisições
    // sem autenticação chegam ao bot normalmente, inclusive aos fluxos de
    // agenda sobre clinica_simulada (o caminho antigo em `public` está
    // desligado desde o T17).
    // Decisão de 2026-11-18: fica assim ATÉ O FIM DA POC (apresentação para
    // investidores; ver "POC decisions" no CLAUDE.md e plan.md). Os fluxos de
    // agenda do bot sobre clinica_simulada vão rodar sem autenticação.
    // REMOVER esta linha antes de qualquer uso com clientes reais.
    allowUnauthenticatedInbound: true,
  });

  return { app, config };
}

export { createRuntimeApp };
