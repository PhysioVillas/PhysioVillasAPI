import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REMINDER_SQL,
  buildReminderMessage,
  createReminderRepository,
  maskWaId,
  normalizeHoursBefore,
  parseReminderValue,
  readReminderSettings,
  reminderKey,
  reminderParameters,
  reminderReplyId,
  reminderSendAt,
  scheduleReminders,
  templateButtonReplyId,
} from '../src/services/bot/reminders.js';
import { createBotEngine, inboundFromNormalizedMessage } from '../src/services/bot/engine.js';
import { buildTemplateMessage } from '../src/services/infobipMessagesClient.js';
import { normalizeInfobipWebhookPayload } from '../src/services/infobipWebhookNormalizer.js';

const WA_ID = '5571999990000';
const OTHER_WA_ID = '5571988887777';
// Quarta-feira, 18/11/2026, 10:00 em America/Bahia.
const NOW = new Date('2026-11-18T13:00:00Z');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function marker(text) {
  return /\/\* (t19:[a-z_]+) \*\//.exec(text)?.[1] ?? text.trim();
}

function createFakePool(handlers = {}) {
  const calls = [];
  const clientCalls = [];
  let released = 0;
  async function run(target, query, values) {
    const text = typeof query === 'string' ? query : query.text;
    const params = typeof query === 'string' ? values : query.values;
    const name = marker(text);
    target.push({ name, text, values: params });
    const handler = handlers[name];
    return handler ? handler(params) : { rows: [] };
  }
  return {
    calls,
    clientCalls,
    get released() {
      return released;
    },
    query: (query, values) => run(calls, query, values),
    async connect() {
      return {
        query: (query, values) => run(clientCalls, query, values),
        release() {
          released += 1;
        },
      };
    },
  };
}

function settings(overrides = {}) {
  return {
    enabled: true,
    allowedWaIds: new Set([WA_ID]),
    templateName: 'lembrete_consulta',
    language: 'pt_BR',
    windowMinutes: 60,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  const startsAt = new Date(NOW.getTime() + 24.5 * 3600000);
  return {
    appointmentId: 30400,
    patientId: 7,
    hoursBefore: 24,
    date: '2026-11-19',
    hour: 10,
    startsAt,
    sendAt: reminderSendAt(startsAt, 24),
    waId: WA_ID,
    conversationId: 'c-1',
    createdByBot: true,
    linkDispatch: true,
    firstName: 'Ana',
    alreadyScheduled: false,
    key: reminderKey(30400, 24),
    ...overrides,
  };
}

function fakeRepository(candidates = [], { reserveResult } = {}) {
  const calls = { list: [], reserve: [], mark: [], template: [] };
  return {
    calls,
    async listCandidates(args) {
      calls.list.push(args);
      return candidates;
    },
    async findTemplateId(args) {
      calls.template.push(args);
      return 'tpl-1';
    },
    async reserve(item, options) {
      calls.reserve.push({ item, options });
      return reserveResult === undefined ? { messageId: `m-${item.key}`, dispatchId: `d-${item.key}` } : reserveResult;
    },
    async markResult(reservation, options) {
      calls.mark.push({ reservation, options });
    },
  };
}

function fakeClient({ fail } = {}) {
  const sent = [];
  return {
    sent,
    async sendTemplateMessage(message) {
      sent.push(message);
      if (fail) {
        throw Object.assign(new Error('Infobip Messages API request failed.'), { status: 400 });
      }
      return { messages: [{ messageId: 'ib-123', status: { name: 'PENDING' } }] };
    },
  };
}

const silentLogger = { error() {}, warn() {} };

// ---------------------------------------------------------------------------
// Configuração e funções puras
// ---------------------------------------------------------------------------

test('reminder settings are off by default and read the documented env vars', () => {
  const defaults = readReminderSettings({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.allowedWaIds.size, 0);
  assert.equal(defaults.templateName, 'lembrete_consulta');
  assert.equal(defaults.language, 'pt_BR');
  assert.equal(defaults.windowMinutes, 60);

  assert.equal(readReminderSettings({ BOT_REMINDERS_ENABLED: '1' }).enabled, false);
  const on = readReminderSettings({
    BOT_REMINDERS_ENABLED: 'TRUE',
    BOT_REMINDERS_ALLOWED_WA_IDS: ` ${WA_ID}, ,${OTHER_WA_ID} `,
    BOT_REMINDER_TEMPLATE_NAME: 'physiovilas_appointment_reminder_v1',
    BOT_REMINDER_TEMPLATE_LANGUAGE: 'pt_BR',
    BOT_REMINDERS_WINDOW_MINUTES: '15',
  });
  assert.equal(on.enabled, true);
  assert.deepEqual([...on.allowedWaIds], [WA_ID, OTHER_WA_ID]);
  assert.equal(on.templateName, 'physiovilas_appointment_reminder_v1');
  assert.equal(on.windowMinutes, 15);

  for (const value of ['0', '2', 'abc', '20000']) {
    assert.throws(() => readReminderSettings({ BOT_REMINDERS_WINDOW_MINUTES: value }), TypeError);
  }
});

test('pure helpers: key, sendAt, parameters, hours and masking', () => {
  assert.equal(reminderKey(30400, 24), 'BOT_REMINDER_30400_24H');
  assert.equal(reminderKey('30400', 4), 'BOT_REMINDER_30400_4H');
  assert.equal(reminderSendAt(new Date('2026-11-19T13:00:00Z'), 24), '2026-11-18T13:00:00Z');
  assert.equal(reminderSendAt('2026-11-19T13:00:00.000Z', 4), '2026-11-19T09:00:00Z');
  assert.deepEqual(reminderParameters({ firstName: 'Ana', date: '2026-11-19', hour: 9 }), ['Ana', '19/11/2026', '09:00']);
  assert.deepEqual(reminderParameters({ firstName: null, date: '2026-11-19', hour: 14 }), ['paciente', '19/11/2026', '14:00']);
  assert.deepEqual(normalizeHoursBefore([4, '24', 24, 0, -1, 'x']), [24, 4]);
  assert.deepEqual(normalizeHoursBefore(null), []);
  assert.equal(maskWaId(WA_ID), '***0000');
  assert.equal(maskWaId('12'), '****');
});

test('reminder payload uses only the confirmed template contract plus sendAt', () => {
  const sendAt = reminderSendAt(new Date(Date.now() + 26 * 3600000), 24);
  const args = buildReminderMessage({
    sender: '557130000000',
    candidate: candidate({ sendAt, date: '2026-11-19', hour: 9 }),
    settings: settings(),
  });
  assert.deepEqual(buildTemplateMessage(args), {
    messages: [{
      channel: 'WHATSAPP',
      sender: '557130000000',
      destinations: [{ to: WA_ID }],
      content: { body: { type: 'TEXT', 1: 'Ana', 2: '19/11/2026', 3: '09:00' } },
      template: { templateName: 'lembrete_consulta', language: 'pt_BR' },
      sendAt,
    }],
  });
  // Nada de botões, messageId próprio ou CPF no payload (não confirmados).
  const dump = JSON.stringify(buildTemplateMessage(args));
  assert.doesNotMatch(dump, /buttons|messageId|cpf/i);
});

test('reminder reply ids follow the my_appointments prefix convention', () => {
  assert.equal(reminderReplyId('confirm'), 'my_appointments:reminder|confirm');
  assert.equal(reminderReplyId('cancel', 30400), 'my_appointments:reminder|cancel:30400');
  assert.throws(() => reminderReplyId('other'), RangeError);
  assert.deepEqual(parseReminderValue('confirm'), { action: 'confirm', appointmentId: null });
  assert.deepEqual(parseReminderValue('reschedule:30400'), { action: 'reschedule', appointmentId: 30400 });
  assert.equal(parseReminderValue('confirm:abc'), null);
  assert.equal(parseReminderValue(undefined), null);
});

test('template quick reply payload or title maps to the reminder ids', () => {
  assert.equal(templateButtonReplyId(null, 'Confirmo'), 'my_appointments:reminder|confirm');
  assert.equal(templateButtonReplyId('Remarcar', 'Remarcar'), 'my_appointments:reminder|reschedule');
  assert.equal(templateButtonReplyId(null, ' CANCELAR '), 'my_appointments:reminder|cancel');
  assert.equal(
    templateButtonReplyId('my_appointments:reminder|confirm:30400', 'Confirmo'),
    'my_appointments:reminder|confirm:30400',
  );
  assert.equal(templateButtonReplyId('opaque-payload', 'Confirmo'), 'my_appointments:reminder|confirm');
  assert.equal(templateButtonReplyId('opaque-payload', 'Outro'), 'opaque-payload');
  assert.equal(templateButtonReplyId(null, 'Outro'), null);
});

// ---------------------------------------------------------------------------
// Roteamento do clique (normalizador → engine → fluxo), sem estado
// ---------------------------------------------------------------------------

test('a template BUTTON inbound is normalized and reaches my_appointments without state', async () => {
  const normalized = normalizeInfobipWebhookPayload({
    results: [{
      from: WA_ID,
      to: '557130000000',
      messageId: 'in-1',
      receivedAt: '2026-11-18T13:00:00.000+0000',
      message: { type: 'BUTTON', text: 'Confirmo', payload: 'Confirmo' },
    }],
  });
  assert.equal(normalized.inboundMessages.length, 1);
  const { message } = normalized.inboundMessages[0];
  assert.equal(message.messageType, 'button');
  assert.equal(message.replyId, 'Confirmo');

  const inbound = inboundFromNormalizedMessage(message);
  assert.equal(inbound.kind, 'button_reply');
  assert.equal(inbound.replyId, 'my_appointments:reminder|confirm');

  const seen = [];
  const flow = (name) => ({
    name,
    async start() {
      return { replies: [{ type: 'text', text: name }], next: null };
    },
    async handle(ctx, input) {
      seen.push({ name, state: ctx.state, reply: input.reply });
      return { replies: [{ type: 'text', text: name }], next: null };
    },
  });
  const engine = createBotEngine({
    flows: { menu: flow('menu'), faq: flow('faq'), booking: flow('booking'), my_appointments: flow('my_appointments'), triage: flow('triage') },
    stateStore: { async getActive() { return null; }, async save() {}, async clear() {} },
    handoffs: { async getOpen() { return null; }, async open() {}, async closeOpen() {} },
    config: { timezone: 'America/Bahia', humanSupportHours: { start: '08:00', end: '18:00', days: [0, 1, 2, 3, 4, 5, 6] } },
    clock: () => NOW,
    logger: silentLogger,
    repos: {},
  });
  const output = await engine.handle(inbound);
  assert.equal(output.flow, 'my_appointments');
  assert.deepEqual(seen, [{ name: 'my_appointments', state: null, reply: { flow: 'my_appointments', step: 'reminder', value: 'confirm' } }]);
});

test('interactive and text inbound keep their previous reply ids', () => {
  assert.equal(
    inboundFromNormalizedMessage({ waId: WA_ID, messageType: 'interactive_button_reply', body: 'Cancelar', replyId: 'my_appointments:action|cancel' }).replyId,
    'my_appointments:action|cancel',
  );
  assert.equal(inboundFromNormalizedMessage({ waId: WA_ID, messageType: 'text', body: 'Confirmo', replyId: null }).replyId, null);
});

// ---------------------------------------------------------------------------
// Repositório (pool falso)
// ---------------------------------------------------------------------------

test('candidate query selects Agendado appointments in the reminder window with a known wa_id', async () => {
  const sql = REMINDER_SQL.candidates;
  assert.match(sql, /a\.status = 'Agendado'/);
  assert.match(sql, /make_interval\(hours => h\.horas\) > \$1::timestamptz \+ make_interval\(mins => \$5::int\)/);
  assert.match(sql, /make_interval\(hours => h\.horas\) <= \$1::timestamptz \+ make_interval\(mins => \$3::int\)/);
  assert.match(sql, /at time zone \$2/);
  assert.match(sql, /coalesce\(ac\.wa_id, j\.wa_id\) is not null/);
  assert.match(sql, /clinica_simulada\.jornada_contatos/);
  assert.match(sql, /clinica_simulada\.agendamento_chatbot/);
  assert.match(sql, /'BOT_REMINDER_' \|\| a\.agendamento_id \|\| '_' \|\| h\.horas \|\| 'H'/);
  assert.doesNotMatch(sql, /\bcpf\b/);

  const pool = createFakePool({
    't19:candidates': () => ({
      rows: [{
        agendamento_id: '30400',
        paciente_id: '7',
        horas: 24,
        data: '2026-11-19',
        hora: '10',
        starts_at: new Date('2026-11-19T13:00:00Z'),
        wa_id: WA_ID,
        conversation_id: 'c-1',
        pelo_bot: true,
        sem_disparo: true,
        first_name: 'Ana',
        ja_agendado: false,
      }],
    }),
  });
  const repo = createReminderRepository({ pool, clock: () => NOW });
  const rows = await repo.listCandidates({ hoursBefore: [4, 24], windowMinutes: 60 });
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].values, [NOW, 'America/Bahia', 60, [24, 4], 2, 3]);
  assert.deepEqual(rows, [{
    appointmentId: 30400,
    patientId: 7,
    hoursBefore: 24,
    date: '2026-11-19',
    hour: 10,
    startsAt: new Date('2026-11-19T13:00:00Z'),
    sendAt: '2026-11-18T13:00:00Z',
    waId: WA_ID,
    conversationId: 'c-1',
    createdByBot: true,
    linkDispatch: true,
    firstName: 'Ana',
    alreadyScheduled: false,
    key: 'BOT_REMINDER_30400_24H',
  }]);

  assert.deepEqual(await repo.listCandidates({ hoursBefore: [], windowMinutes: 60 }), []);
  assert.equal(pool.calls.length, 1);
});

test('reserve writes message, dispatch, event and link once per key', async () => {
  const pool = createFakePool({
    't19:reserve_message': () => ({ rows: [{ id: 'm-1' }] }),
    't19:insert_dispatch': () => ({ rows: [{ id: 'd-1' }] }),
  });
  const repo = createReminderRepository({ pool, clock: () => NOW });
  const reservation = await repo.reserve(candidate(), { templateId: 'tpl-1', now: NOW });
  assert.deepEqual(reservation, { messageId: 'm-1', dispatchId: 'd-1' });
  assert.deepEqual(pool.clientCalls.map((call) => call.name), [
    'begin', 't19:lock', 't19:reserve_message', 't19:insert_dispatch', 't19:dispatch_event', 't19:link_dispatch', 'commit',
  ]);
  const byName = Object.fromEntries(pool.clientCalls.map((call) => [call.name, call]));
  assert.deepEqual(byName['t19:lock'].values, ['BOT_REMINDER_30400_24H']);
  assert.deepEqual(byName['t19:reserve_message'].values, ['BOT_REMINDER_30400_24H', WA_ID, 'c-1', NOW]);
  assert.match(byName['t19:reserve_message'].text, /on conflict \(infobip_message_id\) do nothing/);
  assert.match(byName['t19:reserve_message'].text, /'out', 'api', null, 'template', 'pending'/);
  assert.deepEqual(byName['t19:insert_dispatch'].values, ['m-1', 'tpl-1', candidate().sendAt, NOW]);
  assert.deepEqual(byName['t19:dispatch_event'].values, ['d-1', 'created', 'reminder_24h', NOW]);
  assert.deepEqual(byName['t19:link_dispatch'].values, [30400, 'd-1']);
  assert.match(byName['t19:link_dispatch'].text, /dispatch_id is null/);
  assert.equal(pool.released, 1);
});

test('reserve returns null and writes nothing else when the key already exists', async () => {
  const pool = createFakePool();
  const repo = createReminderRepository({ pool, clock: () => NOW });
  assert.equal(await repo.reserve(candidate({ linkDispatch: false }), { now: NOW }), null);
  assert.deepEqual(pool.clientCalls.map((call) => call.name), ['begin', 't19:lock', 't19:reserve_message', 'commit']);
});

test('reserve does not link the dispatch when the appointment already has one', async () => {
  const pool = createFakePool({
    't19:reserve_message': () => ({ rows: [{ id: 'm-1' }] }),
    't19:insert_dispatch': () => ({ rows: [{ id: 'd-1' }] }),
  });
  const repo = createReminderRepository({ pool, clock: () => NOW });
  await repo.reserve(candidate({ linkDispatch: false }), { now: NOW });
  assert.ok(!pool.clientCalls.some((call) => call.name === 't19:link_dispatch'));
});

test('markResult updates dispatch and message and records the event', async () => {
  const pool = createFakePool();
  const repo = createReminderRepository({ pool, clock: () => NOW });
  await repo.markResult({ messageId: 'm-1', dispatchId: 'd-1' }, { status: 'failed', detail: '400', errorCode: '400', now: NOW });
  const byName = Object.fromEntries(pool.clientCalls.map((call) => [call.name, call]));
  assert.deepEqual(byName['t19:update_dispatch'].values, ['d-1', 'failed', NOW]);
  assert.deepEqual(byName['t19:update_message'].values, ['m-1', 'failed', '400', NOW]);
  assert.deepEqual(byName['t19:dispatch_event'].values, ['d-1', 'failed', '400', NOW]);
});

test('confirmAttendance sets lembrete_confirmado = Sim for the patient appointment and audits', async () => {
  assert.match(REMINDER_SQL.confirm, /lembrete_confirmado = 'Sim'/);
  assert.match(REMINDER_SQL.confirm, /lembrete_enviado = coalesce\(lembrete_enviado, 'Sim'\)/);
  assert.match(REMINDER_SQL.confirm, /paciente_id = \$2 and status = 'Agendado'/);

  const pool = createFakePool({ 't19:confirm': () => ({ rows: [{ agendamento_id: '30400' }] }) });
  const repo = createReminderRepository({ pool, clock: () => NOW });
  assert.deepEqual(await repo.confirmAttendance({ patientId: 7, appointmentId: 30400 }), { ok: true, appointmentId: 30400 });
  const audit = pool.clientCalls.find((call) => call.name === 't19:audit');
  assert.deepEqual(audit.values, [30400, 'reminder_confirmed', NOW]);

  const missing = createFakePool();
  const repoMissing = createReminderRepository({ pool: missing, clock: () => NOW });
  assert.deepEqual(await repoMissing.confirmAttendance({ patientId: 7, appointmentId: 1 }), { ok: false, reason: 'not_found' });
  assert.ok(!missing.clientCalls.some((call) => call.name === 't19:audit'));
});

// ---------------------------------------------------------------------------
// Execução: flag, dry-run e envio
// ---------------------------------------------------------------------------

test('flag off only reports, even with --send', async () => {
  const repository = fakeRepository([candidate()]);
  const client = fakeClient();
  const report = await scheduleReminders({
    repository,
    settings: settings({ enabled: false }),
    botConfig: { reminderHoursBefore: [24, 4] },
    send: true,
    messagesClient: client,
    sender: '557130000000',
    clock: () => NOW,
  });
  assert.equal(report.mode, 'disabled');
  assert.deepEqual(report.items.map((item) => item.status), ['would_schedule']);
  assert.equal(client.sent.length, 0);
  assert.equal(repository.calls.reserve.length, 0);
  assert.equal(repository.calls.template.length, 0);
});

test('dry-run reports without writing or sending, and hides personal data', async () => {
  const repository = fakeRepository([
    candidate(),
    candidate({ appointmentId: 30401, key: reminderKey(30401, 4), hoursBefore: 4, waId: OTHER_WA_ID }),
    candidate({ appointmentId: 30402, key: reminderKey(30402, 24), alreadyScheduled: true }),
  ]);
  const client = fakeClient();
  const report = await scheduleReminders({
    repository,
    settings: settings(),
    botConfig: { get: async () => ({ reminderHoursBefore: [4, 24] }) },
    messagesClient: client,
    clock: () => NOW,
  });
  assert.equal(report.mode, 'dry_run');
  assert.deepEqual(repository.calls.list, [{ now: NOW, hoursBefore: [24, 4], windowMinutes: 60 }]);
  assert.deepEqual(report.items.map((item) => item.status), ['would_schedule', 'not_allowlisted', 'already_scheduled']);
  assert.deepEqual(report.counts, { would_schedule: 1, not_allowlisted: 1, already_scheduled: 1 });
  assert.equal(client.sent.length, 0);
  assert.equal(repository.calls.reserve.length, 0);
  const dump = JSON.stringify(report);
  assert.doesNotMatch(dump, /Ana|5571999990000|5571988887777/);
});

test('send mode schedules allowlisted reminders once, with sendAt', async () => {
  const repository = fakeRepository([
    candidate(),
    candidate({ appointmentId: 30401, key: reminderKey(30401, 24), waId: OTHER_WA_ID }),
    candidate({ appointmentId: 30402, key: reminderKey(30402, 24), alreadyScheduled: true }),
  ]);
  const client = fakeClient();
  const report = await scheduleReminders({
    repository,
    settings: settings(),
    botConfig: { reminderHoursBefore: [24, 4] },
    send: true,
    messagesClient: client,
    sender: '557130000000',
    clock: () => NOW,
    logger: silentLogger,
  });
  assert.equal(report.mode, 'send');
  assert.deepEqual(report.items.map((item) => item.status), ['scheduled', 'not_allowlisted', 'already_scheduled']);
  assert.deepEqual(repository.calls.template, [{ name: 'lembrete_consulta', language: 'pt_BR' }]);
  assert.equal(repository.calls.reserve.length, 1);
  assert.equal(repository.calls.reserve[0].options.templateId, 'tpl-1');
  assert.deepEqual(client.sent, [{
    sender: '557130000000',
    to: WA_ID,
    templateName: 'lembrete_consulta',
    language: 'pt_BR',
    parameters: ['Ana', '19/11/2026', '10:00'],
    sendAt: candidate().sendAt,
  }]);
  assert.deepEqual(repository.calls.mark.map((call) => call.options.status), ['scheduled']);
  assert.equal(repository.calls.mark[0].options.detail, 'ib-123');
});

test('send mode skips a key reserved concurrently (idempotency)', async () => {
  const repository = fakeRepository([candidate()], { reserveResult: null });
  const client = fakeClient();
  const report = await scheduleReminders({
    repository,
    settings: settings(),
    botConfig: { reminderHoursBefore: [24] },
    send: true,
    messagesClient: client,
    sender: '557130000000',
    clock: () => NOW,
  });
  assert.deepEqual(report.items.map((item) => item.status), ['already_scheduled']);
  assert.equal(client.sent.length, 0);
});

test('send mode records an Infobip failure and does not retry', async () => {
  const repository = fakeRepository([candidate()]);
  const client = fakeClient({ fail: true });
  const report = await scheduleReminders({
    repository,
    settings: settings(),
    botConfig: { reminderHoursBefore: [24] },
    send: true,
    messagesClient: client,
    sender: '557130000000',
    clock: () => NOW,
    logger: silentLogger,
  });
  assert.deepEqual(report.counts, { failed: 1 });
  assert.deepEqual(repository.calls.mark.map((call) => call.options), [
    { status: 'failed', detail: '400', errorCode: '400', now: NOW },
  ]);
  assert.equal(client.sent.length, 1);
});

test('send mode refuses without an allowlist or without a client', async () => {
  const base = {
    repository: fakeRepository([candidate()]),
    botConfig: { reminderHoursBefore: [24] },
    send: true,
    sender: '557130000000',
    clock: () => NOW,
  };
  await assert.rejects(
    scheduleReminders({ ...base, settings: settings({ allowedWaIds: new Set() }), messagesClient: fakeClient() }),
    /BOT_REMINDERS_ALLOWED_WA_IDS/,
  );
  await assert.rejects(scheduleReminders({ ...base, settings: settings() }), /messages client/);
  assert.equal(base.repository.calls.list.length, 0);
});
