// Agenda os lembretes de consulta (T19). Uso:
//   npm run schedule-reminders              # relatório (dry-run), não grava nada
//   npm run schedule-reminders -- --send    # agenda de verdade, SÓ se
//                                           # BOT_REMINDERS_ENABLED=true e
//                                           # BOT_REMINDERS_ALLOWED_WA_IDS definido
// Variáveis: DATABASE_URL; no envio também INFOBIP_BASE_URL, INFOBIP_API_KEY e
// INFOBIP_WHATSAPP_SENDER. Demais (template, janela): src/services/bot/reminders.js.
// A saída é JSON sem nomes nem telefones completos.

import pg from 'pg';

import { createBotConfig } from '../src/config/botConfig.js';
import { getRuntimeConfig, requireInfobipConfig } from '../src/config/runtimeConfig.js';
import { createInfobipMessagesClient } from '../src/services/infobipMessagesClient.js';
import {
  createReminderRepository,
  readReminderSettings,
  scheduleReminders,
} from '../src/services/bot/reminders.js';

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => arg !== '--send');
if (unknown.length > 0) {
  console.error('Usage: npm run schedule-reminders [-- --send]');
  process.exit(1);
}

const runtime = getRuntimeConfig();
if (!runtime.databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

let settings;
try {
  settings = readReminderSettings();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const wantsSend = args.has('--send');
if (wantsSend && !settings.enabled) {
  console.error('BOT_REMINDERS_ENABLED is not "true": nothing will be sent (report only).');
}

let messagesClient;
let sender;
if (wantsSend && settings.enabled) {
  try {
    const infobip = requireInfobipConfig(runtime);
    messagesClient = createInfobipMessagesClient({ baseUrl: infobip.baseUrl, apiKey: infobip.apiKey });
    sender = infobip.whatsappSender;
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const pool = new pg.Pool({ connectionString: runtime.databaseUrl });

try {
  const botConfig = await createBotConfig({ pool }).get();
  const repository = createReminderRepository({ pool, timezone: botConfig.timezone });
  const report = await scheduleReminders({
    repository,
    settings,
    botConfig,
    send: wantsSend,
    messagesClient,
    sender,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.counts.failed) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Reminder scheduling failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
