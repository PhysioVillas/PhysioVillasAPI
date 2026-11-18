import { getRuntimeConfig, requireInfobipConfig } from './config/runtimeConfig.js';
import { createApp } from './appFactory.js';
import { createDatabase } from './services/database.js';
import { createFaqBot } from './services/faqBot.js';
import { createInfobipMessagesClient } from './services/infobipMessagesClient.js';

function createRuntimeApp({
  env = process.env,
  createDatabaseFactory = createDatabase,
  createInfobipMessagesClientFactory = createInfobipMessagesClient,
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
  // The FAQ bot answers every patient as soon as persistence and Infobip
  // sending are configured (decided 2026-10-21 while the system has no real
  // patients yet; there is no env switch or number allowlist).
  const faqBot = database !== undefined && messagesClient !== undefined
    ? createFaqBot({
      client: messagesClient,
      database,
      sender: infobipMessagesConfig.whatsappSender,
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
    faqBot,
    chatManagerApiToken: config.chatManagerApiToken,
    captureUnmappedWebhookPayloads: database !== undefined && config.infobip.webhookToken !== undefined,
    // ⚠️ POC — WEBHOOK SEM AUTENTICAÇÃO (restaurado em 2026-11-18).
    // Este sistema ainda é uma prova de conceito em teste: nenhum cliente ou
    // paciente real usa este número. A validação HMAC (infobipWebhookAuth.js)
    // ainda não foi configurada/validada na Vercel e na subscription da
    // Infobip, e sem isso todo webhook voltava 401 e o bot parou de responder.
    // Enquanto isso, o webhook aceita requisições não autenticadas. Requisições
    // sem autenticação NÃO recebem permissão para a agenda (comandos de
    // consulta continuam bloqueados); só o FAQ/menu e a persistência funcionam.
    // Decisão de 2026-11-18: fica assim ATÉ O FIM DA POC (apresentação para
    // investidores; ver "POC decisions" no CLAUDE.md e plan.md). Os fluxos de
    // agenda do bot sobre clinica_simulada vão rodar sem autenticação.
    // REMOVER esta linha antes de qualquer uso com clientes reais.
    allowUnauthenticatedInbound: true,
  });

  return { app, config };
}

export { createRuntimeApp };
