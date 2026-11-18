// T17: testes de aceite ponta a ponta pela rota do webhook, com pool falso
// (createDatabase, stateStore, handoffs e bot_config reais em cima dele),
// cliente Infobip falso e dados de clínica falsos.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import {
  createBot,
  maskCpfDeep,
  maskCpfInText,
  stepKeysForReplies,
} from '../src/services/bot/index.js';
import { createBotSender } from '../src/services/bot/sender.js';
import { createDatabase } from '../src/services/database.js';
import { flowEventForMessage, toBotStepKey } from '../src/services/whatsappFlowEvents.js';

const WA_ID = '5571999990000';
// Quarta-feira, 18/11/2026, 10:00 em America/Bahia (dentro do horário humano).
const NOW = new Date('2026-11-18T13:00:00Z');
const CPF_TEXT = 'Meu CPF é 529.982.247-25';
const CPF_DIGITS = '52998224725';
const SILENT_LOGGER = { error() {}, warn() {}, info() {} };

// --- pool falso ---------------------------------------------------------------

function createFakePool() {
  const queries = [];
  const db = {
    contacts: new Map(),
    conversation: { id: 'conv-1', current_intent: 'unknown' },
    intents: [],
    messages: [],
    flowEvents: [],
    state: new Map(),
    handoffs: [],
  };
  let nextMessageId = 1;
  let nextHandoffId = 1;

  function handoffRow(h) {
    return { ...h };
  }

  async function query(input, maybeValues) {
    const text = typeof input === 'string' ? input : input.text;
    const values = (typeof input === 'string' ? maybeValues : input.values) ?? [];
    queries.push({ text, values });
    const sql = text.replace(/\s+/g, ' ').trim();

    if (/^(begin|commit|rollback)$/.test(sql)) return { rows: [] };
    if (sql.startsWith('select key, value from bot_config')) return { rows: [] };

    if (sql.startsWith('insert into contacts')) {
      db.contacts.set(values[0], { wa_id: values[0], profile_name: values[1] });
      return { rows: [{ wa_id: values[0], profile_name: values[1], last_message_at: values[2] }] };
    }
    if (sql.startsWith('insert into conversations')) {
      return { rows: [{ id: db.conversation.id, wa_id: values[0], status: 'open', last_message_at: values[1] }] };
    }
    if (sql.startsWith('update conversations set current_intent')) {
      db.conversation.current_intent = values[1];
      db.intents.push(values[1]);
      return { rows: [] };
    }
    if (sql.startsWith('insert into messages')) {
      const [infobipMessageId, waId, conversationId, direction, sentVia, body, messageType, status] = values;
      if (infobipMessageId !== null && db.messages.some((m) => m.infobip_message_id === infobipMessageId)) {
        return { rows: [] };
      }
      const row = {
        id: `msg-${nextMessageId++}`,
        infobip_message_id: infobipMessageId,
        wa_id: waId,
        conversation_id: conversationId,
        direction,
        sent_via: sentVia,
        body,
        message_type: messageType,
        status,
        error_code: null,
        created_at: NOW,
      };
      db.messages.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('insert into whatsapp_flow_events')) {
      db.flowEvents.push({ messageId: values[0], eventType: values[2], stepKey: values[3], source: values[4] });
      return { rows: [] };
    }

    if (sql.startsWith('select wa_id, flow, step, context')) {
      const row = db.state.get(values[0]);
      return { rows: row && row.expires_at > values[1] ? [row] : [] };
    }
    if (sql.startsWith('insert into conversation_state')) {
      db.state.set(values[0], {
        wa_id: values[0],
        flow: values[1],
        step: values[2],
        context: JSON.parse(values[3]),
        cpf_attempts: values[4],
        misunderstood_count: values[5],
        expires_at: values[6],
        updated_at: NOW,
      });
      return { rows: [] };
    }
    if (sql.startsWith('delete from conversation_state')) {
      db.state.delete(values[0]);
      return { rows: [] };
    }

    if (sql.startsWith('select id, wa_id, reason') && sql.includes('from handoffs')) {
      const open = db.handoffs.find((h) => h.wa_id === values[0] && h.closed_at === null);
      return { rows: open ? [handoffRow(open)] : [] };
    }
    if (sql.startsWith('insert into handoffs')) {
      if (db.handoffs.some((h) => h.wa_id === values[0] && h.closed_at === null)) return { rows: [] };
      const row = {
        id: `handoff-${nextHandoffId++}`,
        wa_id: values[0],
        reason: values[1],
        in_business_hours: values[2],
        requested_at: NOW,
        first_team_reply_at: null,
        closed_at: null,
      };
      db.handoffs.push(row);
      return { rows: [handoffRow(row)] };
    }
    if (sql.startsWith('update handoffs set first_team_reply_at')) {
      const open = db.handoffs.find((h) => h.wa_id === values[0] && h.closed_at === null && h.first_team_reply_at === null);
      if (!open) return { rows: [] };
      open.first_team_reply_at = values[1];
      return { rows: [handoffRow(open)] };
    }
    if (sql.startsWith('update handoffs set closed_at')) {
      const open = db.handoffs.find((h) => h.wa_id === values[0] && h.closed_at === null);
      if (!open) return { rows: [] };
      open.closed_at = values[1];
      return { rows: [handoffRow(open)] };
    }

    throw new Error(`Unexpected SQL in fake pool: ${sql.slice(0, 80)}`);
  }

  return {
    db,
    queries,
    query,
    async connect() {
      return { query, release() {} };
    },
  };
}

// --- clínica falsa ------------------------------------------------------------

function createClinicRepos() {
  const calls = { book: [], createPatient: [], findPatientByCpf: [] };
  const services = [
    { id: 1, name: 'Fisioterapia ambulatorial', durationMin: 50, slotCapacity: 2, professionals: [{ id: 1, name: 'Carla' }] },
    { id: 4, name: 'Massagem', durationMin: 50, slotCapacity: 1, professionals: [{ id: 5, name: 'Marta' }] },
  ];
  const repos = {
    catalog: {
      listServices: async () => services,
      listInsurancePlans: async () => [{ id: 1, name: 'Convênio A' }],
      listPrices: async () => [
        { serviceId: 1, kind: 'avulso', amount: 120 },
        { serviceId: 4, kind: 'avulso', amount: 140 },
      ],
      listHolidays: async () => [],
      listFaqEntries: async () => [{ slug: 'endereco', question: 'Onde?', answer: 'Rua das Acácias, 123.' }],
      getOpeningHours: async () => [],
    },
    appointments: {
      ensureScheduleHorizon: async () => {},
      listAvailableDays: async () => [{ date: '2026-11-27', freeSlots: 2 }],
      listAvailableTimes: async ({ date }) => (date === '2026-11-27'
        ? [{ hour: 8, professionalId: 5, professionalName: 'Marta', remaining: 1 }]
        : []),
      listUpcoming: async () => [],
      book: async (args) => {
        calls.book.push(args);
        return {
          ok: true,
          appointment: { id: 9001, patientId: args.patientId, serviceId: args.serviceId, date: args.date, hour: args.hour, sessionValue: 140 },
        };
      },
    },
    patients: {
      findPatientByCpf: async (cpf) => { calls.findPatientByCpf.push(cpf); return null; },
      findPatientByWaId: async () => null,
      createPatient: async (args) => { calls.createPatient.push(args); return { id: 777 }; },
      linkContact: async () => {},
      upsertLead: async () => ({ leadId: 55 }),
    },
  };
  return { repos, calls };
}

// --- Infobip falso ------------------------------------------------------------

function createFakeClient({ failOn } = {}) {
  const sent = [];
  let counter = 0;
  const record = (type) => async (message) => {
    if (failOn?.(type, sent.length)) {
      const error = new Error('Infobip down');
      error.name = 'InfobipMessagesApiError';
      error.status = 503;
      throw error;
    }
    counter += 1;
    sent.push({ type, ...message });
    return { messageId: `out-${counter}`, status: { name: 'PENDING_ACCEPTED' } };
  };
  return {
    sent,
    sendWhatsAppText: record('text'),
    sendWhatsAppInteractiveList: record('list'),
    sendWhatsAppInteractiveButtons: record('buttons'),
  };
}

// --- montagem -----------------------------------------------------------------

function setup() {
  const pool = createFakePool();
  const client = createFakeClient();
  const clinic = createClinicRepos();
  const database = createDatabase({ pool });
  const bot = createBot({
    pool,
    database,
    messagesClient: client,
    whatsappSender: 'clinic-sender',
    clock: () => NOW,
    logger: SILENT_LOGGER,
    repos: clinic.repos,
  });
  const app = createApp({
    database,
    infobipWebhookToken: 'receiver-token',
    whatsappSender: 'clinic-sender',
    bot,
    allowUnauthenticatedInbound: true,
  });
  return { pool, client, clinic, app };
}

let messageCounter = 0;

function textPayload(text, messageId = `in-${(messageCounter += 1)}`) {
  return {
    results: [{
      from: WA_ID,
      messageId,
      receivedAt: '2026-11-18T13:00:00.000+0000',
      message: { type: 'TEXT', text },
      contact: { name: 'Paciente Teste' },
    }],
  };
}

function clickPayload(id, title = 'opção') {
  const type = 'INTERACTIVE_LIST_REPLY';
  return {
    results: [{
      from: WA_ID,
      messageId: `in-${(messageCounter += 1)}`,
      receivedAt: '2026-11-18T13:00:00.000+0000',
      message: { type, id, title },
    }],
  };
}

function buttonPayload(id, title = 'botão') {
  return {
    results: [{
      from: WA_ID,
      messageId: `in-${(messageCounter += 1)}`,
      receivedAt: '2026-11-18T13:00:00.000+0000',
      message: { type: 'INTERACTIVE_BUTTON_REPLY', id, title },
    }],
  };
}

function echoPayload(text) {
  return {
    entry: [{
      changes: [{
        field: 'smb_message_echoes',
        value: {
          messageEchoes: [{
            from: '5571900000000',
            to: WA_ID,
            id: `wamid.echo-${(messageCounter += 1)}`,
            timestamp: String(Math.floor(NOW.getTime() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

async function withServer(app, callback) {
  const server = app.listen(0);
  const originalWarn = console.warn;
  console.warn = () => {}; // aviso do bypass da POC
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return await callback(async (payload) => {
      const response = await fetch(`${baseUrl}/webhooks/infobip/inbound`, {
        method: 'POST',
        // Sem Authorization: a POC aceita webhook sem autenticação.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      return response.json();
    });
  } finally {
    console.warn = originalWarn;
    await new Promise((resolve) => server.close(resolve));
  }
}

function outbound(pool) {
  return pool.db.messages.filter((m) => m.direction === 'out' && m.sent_via === 'api');
}

function rowIds(list) {
  return list.sections.flatMap((section) => section.rows.map((row) => row.id));
}

// --- testes -------------------------------------------------------------------

test('"oi" without authentication gets the new main menu, stored as faq_menu with a bot step event', async () => {
  const { pool, client, app } = setup();

  await withServer(app, async (post) => {
    await post(textPayload('oi'));
  });

  assert.equal(client.sent.length, 1);
  const [menu] = client.sent;
  assert.equal(menu.type, 'list');
  assert.equal(menu.sender, 'clinic-sender');
  assert.equal(menu.to, WA_ID);
  assert.ok(rowIds(menu).includes('menu:main|booking'));
  assert.ok(rowIds(menu).includes('menu:main|human'));

  const [stored] = outbound(pool);
  assert.equal(stored.message_type, 'faq_menu');
  assert.equal(stored.infobip_message_id, 'out-1');
  assert.equal(pool.db.conversation.current_intent, 'faq');
  assert.deepEqual(
    pool.db.flowEvents.filter((e) => e.eventType === 'bot_step_sent').map((e) => e.stepKey),
    ['menu:show'],
  );
});

test('full booking through the webhook: triage, masked CPF, day, time and confirmation', async () => {
  const { pool, client, clinic, app } = setup();

  await withServer(app, async (post) => {
    await post(textPayload('oi'));
    await post(clickPayload('menu:main|booking', 'Agendar consulta'));
    assert.deepEqual(rowIds(client.sent.at(-1)), ['triage:service|1', 'triage:service|4']);
    assert.equal(pool.db.conversation.current_intent, 'triage');

    await post(clickPayload('triage:service|4', 'Massagem'));
    assert.ok(rowIds(client.sent.at(-1)).includes('triage:origin|instagram'));

    await post(clickPayload('triage:origin|instagram', 'Instagram'));
    await post(textPayload('Ana Teste'));
    assert.match(client.sent.at(-1).text, /CPF/);

    await post(textPayload(CPF_TEXT));
    assert.deepEqual(rowIds(client.sent.at(-1)), ['booking:choose_day|2026-11-27']);
    assert.equal(pool.db.conversation.current_intent, 'scheduling');

    await post(clickPayload('booking:choose_day|2026-11-27', '27/11'));
    assert.ok(rowIds(client.sent.at(-1)).some((id) => id.startsWith('booking:choose_time|8-5')));

    await post(clickPayload('booking:choose_time|8-5', '08:00'));
    const confirm = client.sent.at(-1);
    assert.equal(confirm.type, 'buttons');
    assert.ok(confirm.buttons.some((b) => b.id === 'booking:confirm|yes'));

    await post(buttonPayload('booking:confirm|yes', 'Confirmar'));
  });

  // O engine recebeu o CPF original (só em memória) e marcou a consulta.
  assert.deepEqual(clinic.calls.findPatientByCpf, [CPF_DIGITS]);
  assert.equal(clinic.calls.createPatient[0].cpf, CPF_DIGITS);
  assert.equal(clinic.calls.book.length, 1);
  assert.equal(clinic.calls.book[0].patientId, 777);
  assert.equal(clinic.calls.book[0].date, '2026-11-27');
  assert.equal(clinic.calls.book[0].hour, 8);
  assert.match(client.sent.at(-1).text, /consulta está marcada/);

  // A mensagem do CPF foi gravada com máscara.
  const cpfMessage = pool.db.messages.find((m) => m.direction === 'in' && m.body?.startsWith('Meu CPF'));
  assert.equal(cpfMessage.body, 'Meu CPF é ***.***.***-25');

  // Nenhum parâmetro de SQL contém o CPF, em nenhum formato.
  for (const { text, values } of pool.queries) {
    const serialized = JSON.stringify(values);
    assert.ok(!serialized.includes(CPF_DIGITS), `CPF digits in params of: ${text.trim().slice(0, 60)}`);
    assert.ok(!serialized.includes('529.982.247-25'), `formatted CPF in params of: ${text.trim().slice(0, 60)}`);
    assert.ok(!text.includes(CPF_DIGITS));
  }

  // Tipos e etapas gravados para o BI.
  const types = outbound(pool).map((m) => m.message_type);
  assert.ok(types.every((t) => ['faq_menu', 'faq_answer', 'faq_handoff'].includes(t)));
  assert.ok(!types.includes('faq_handoff'));
  const steps = pool.db.flowEvents.filter((e) => e.eventType === 'bot_step_sent').map((e) => e.stepKey);
  for (const key of ['menu:show', 'triage:choose_service', 'triage:ask_name', 'triage:ask_cpf', 'booking:choose_day', 'booking:choose_time', 'booking:confirm']) {
    assert.ok(steps.includes(key), `missing ${key} in ${steps.join(',')}`);
  }
  assert.equal(steps.at(-1), 'booking:booked');
  // Respostas sem evento próprio (ex.: o texto de introdução da triagem)
  // ficam com a chave antiga do message_type, que a migration 014 mantém.
  assert.ok(steps.every((key) => /^[a-z_]+:[a-z0-9_|:-]+$/.test(key) || /^faq_(menu|answer|handoff)$/.test(key)));
  assert.ok(pool.db.intents.every((intent) => ['faq', 'triage', 'scheduling', 'human_handoff', 'unknown'].includes(intent)));
});

test('handoff silences the bot, a team reply is tracked, and MENU reopens the menu', async () => {
  const { pool, client, app } = setup();

  await withServer(app, async (post) => {
    await post(textPayload('Quero falar com um atendente'));
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].type, 'text');
    const [handoffMessage] = outbound(pool);
    assert.equal(handoffMessage.message_type, 'faq_handoff');
    assert.equal(pool.db.conversation.current_intent, 'human_handoff');
    assert.equal(pool.db.handoffs.length, 1);
    assert.equal(pool.db.handoffs[0].reason, 'patient_request');
    assert.deepEqual(
      pool.db.flowEvents.filter((e) => e.eventType === 'bot_step_sent').map((e) => e.stepKey),
      ['handoff:patient_request'],
    );

    await post(echoPayload('Oi, aqui é a equipe da clínica'));
    assert.deepEqual(pool.db.handoffs[0].first_team_reply_at, NOW);

    await post(textPayload('oi, alguém aí?'));
    assert.equal(client.sent.length, 1, 'the bot stays silent during the handoff');

    await post(textPayload('MENU'));
    assert.equal(client.sent.length, 2);
    assert.equal(client.sent[1].type, 'list');
    assert.notEqual(pool.db.handoffs[0].closed_at, null);
    assert.equal(pool.db.conversation.current_intent, 'faq');
  });
});

test('an Infobip retry with the same messageId never produces a second reply', async () => {
  const { pool, client, app } = setup();
  const payload = textPayload('oi', 'in-duplicate');

  await withServer(app, async (post) => {
    await post(payload);
    await post(payload);
    await post(payload);
  });

  assert.equal(client.sent.length, 1);
  assert.equal(pool.db.messages.filter((m) => m.direction === 'in').length, 1);
  assert.equal(outbound(pool).length, 1);
});

test('a send failure stops the remaining replies and still answers the webhook', async () => {
  const pool = createFakePool();
  const client = createFakeClient({ failOn: (type) => type === 'list' });
  const errors = [];
  const database = createDatabase({ pool });
  const bot = createBot({
    pool,
    database,
    messagesClient: client,
    whatsappSender: 'clinic-sender',
    clock: () => NOW,
    logger: { ...SILENT_LOGGER, error: (...args) => errors.push(args) },
    repos: createClinicRepos().repos,
  });
  const app = createApp({ database, infobipWebhookToken: 'receiver-token', bot, allowUnauthenticatedInbound: true });

  await withServer(app, async (post) => {
    await post(textPayload('oi'));
  });

  assert.equal(client.sent.length, 0);
  assert.equal(outbound(pool).length, 0);
  assert.equal(errors.length, 1);
  assert.ok(!JSON.stringify(errors).includes(WA_ID), 'no phone number in logs');
});

test('the debug capture keeps unmapped payloads only with the CPF masked', () => {
  assert.equal(maskCpfInText('cpf 52998224725 e 111.444.777-35.'), 'cpf ***.***.***-25 e ***.***.***-35.');
  assert.equal(maskCpfInText('sem documento'), 'sem documento');
  assert.equal(maskCpfInText(null), null);
  assert.deepEqual(
    maskCpfDeep({ a: ['x 52998224725'], b: { c: 3, d: '529.982.247-25' } }),
    { a: ['x ***.***.***-25'], b: { c: 3, d: '***.***.***-25' } },
  );
});

test('engine events map to the sent replies (handoff text gets the handoff event)', () => {
  assert.deepEqual(stepKeysForReplies({
    replies: [{ type: 'text' }, { type: 'list' }],
    events: [{ stepKey: 'triage:ask_cpf' }, { stepKey: 'booking:choose_day' }],
    handoff: null,
  }), ['triage:ask_cpf', 'booking:choose_day']);
  assert.deepEqual(stepKeysForReplies({
    replies: [{ type: 'text' }, { type: 'text' }],
    events: [{ stepKey: 'handoff:clinical_or_urgency' }],
    handoff: { reason: 'clinical_or_urgency' },
  }), [null, 'handoff:clinical_or_urgency']);
  assert.deepEqual(stepKeysForReplies({
    replies: [{ type: 'list' }],
    events: [{ stepKey: 'menu:show' }, { stepKey: 'booking:choose_service' }],
    handoff: null,
  }), ['booking:choose_service']);
});

test('bot step keys follow the migration 014 format or fall back to the message type', () => {
  assert.equal(toBotStepKey('booking:choose_day'), 'booking:choose_day');
  assert.equal(toBotStepKey('booking:choose_day|more:2'), 'booking:choose_day|more:2');
  assert.equal(toBotStepKey('booking:day|Ação Ç'), 'booking:day');
  assert.equal(toBotStepKey('Booking:Day'), null);
  assert.equal(toBotStepKey(undefined), null);

  const base = { direction: 'out', sentVia: 'api', messageType: 'faq_answer', createdAt: null };
  assert.equal(flowEventForMessage({ ...base, botStepKey: 'handoff:payment' })[0].stepKey, 'handoff:payment');
  assert.equal(flowEventForMessage({ ...base, botStepKey: 'INVALID' })[0].stepKey, 'faq_answer');
  assert.equal(flowEventForMessage(base)[0].stepKey, 'faq_answer');
});

test('the sender maps reply types to the dedicated WhatsApp client methods in order', async () => {
  const client = createFakeClient();
  const sender = createBotSender({ client, sender: 'clinic-sender', logger: SILENT_LOGGER });
  const results = await sender.send(WA_ID, [
    { type: 'text', text: 'Olá' },
    { type: 'buttons', body: 'Escolha', buttons: [{ id: 'a:b|c', title: 'C' }] },
    { type: 'list', body: 'Lista', buttonTitle: 'Ver', sections: [{ rows: [{ id: 'a:b|d', title: 'D' }] }] },
  ]);

  assert.deepEqual(client.sent.map((m) => m.type), ['text', 'buttons', 'list']);
  assert.deepEqual(client.sent[0], { type: 'text', sender: 'clinic-sender', to: WA_ID, text: 'Olá' });
  assert.deepEqual(results.map((r) => [r.ok, r.messageId]), [[true, 'out-1'], [true, 'out-2'], [true, 'out-3']]);
});
