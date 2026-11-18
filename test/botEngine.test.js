import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBotEngine,
  ENGINE_TEXTS,
  formatOpening,
  inboundFromNormalizedMessage,
  parseReplyId,
} from '../src/services/bot/engine.js';
import {
  normalizeReplies,
  normalizeRepliesWithPages,
  truncate,
  WHATSAPP_LIMITS,
} from '../src/services/bot/replies.js';

const WA_ID = '5571999990000';
// Quarta-feira, 18/11/2026, 10:00 em America/Bahia (UTC-3).
const IN_HOURS = new Date('2026-11-18T13:00:00Z');
// Quarta-feira, 20:00 em America/Bahia.
const OUT_OF_HOURS = new Date('2026-11-18T23:00:00Z');
// Sexta-feira, 20/11/2026, 20:00 em America/Bahia.
const FRIDAY_NIGHT = new Date('2026-11-20T23:00:00Z');

const CONFIG = Object.freeze({
  timezone: 'America/Bahia',
  humanSupportHours: { start: '08:00', end: '18:00', days: [0, 1, 2, 3, 4, 5, 6] },
  conversationStepTimeoutMinutes: 30,
  handoffSilenceHours: 12,
  maxMisunderstoodReplies: 3,
  cpfMaxAttempts: 3,
});

function hoursBefore(date, hours) {
  return new Date(date.getTime() - hours * 3600000);
}

function createStateStore(initial = null) {
  const store = {
    current: initial,
    saves: [],
    clears: 0,
    async getActive(waId, now) {
      assert.equal(waId, WA_ID);
      assert.ok(now instanceof Date);
      return store.current;
    },
    async save(state) {
      store.saves.push(structuredClone(state));
      store.current = structuredClone(state);
    },
    async clear() {
      store.clears += 1;
      store.current = null;
    },
  };
  return store;
}

function createHandoffs(openHandoff = null) {
  const repo = {
    current: openHandoff,
    opened: [],
    closed: [],
    async getOpen() {
      return repo.current;
    },
    async open(args) {
      repo.opened.push(args);
      repo.current = { ...args, requestedAt: new Date(), firstTeamReplyAt: null };
      return repo.current;
    },
    async closeOpen(waId, at) {
      repo.closed.push({ waId, at });
      repo.current = null;
    },
  };
  return repo;
}

function createLogger() {
  const entries = [];
  return {
    entries,
    error: (...args) => entries.push(['error', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
  };
}

// Fluxo falso: grava as chamadas e responde com o que o teste definir.
function fakeFlow(name, { start, handle } = {}) {
  const flow = {
    name,
    calls: [],
    async start(ctx, input) {
      flow.calls.push({ method: 'start', ctx, input });
      return start ? start(ctx, input) : { replies: [{ type: 'text', text: `${name} start` }], next: null };
    },
    async handle(ctx, input) {
      flow.calls.push({ method: 'handle', ctx, input });
      return handle ? handle(ctx, input) : { replies: [{ type: 'text', text: `${name} handle` }], next: null };
    },
  };
  return flow;
}

function setup({
  state = null,
  openHandoff = null,
  now = IN_HOURS,
  config = CONFIG,
  flows: flowOverrides = {},
} = {}) {
  const flows = {
    menu: fakeFlow('menu'),
    faq: fakeFlow('faq'),
    booking: fakeFlow('booking'),
    my_appointments: fakeFlow('my_appointments'),
    triage: fakeFlow('triage'),
    ...flowOverrides,
  };
  const stateStore = createStateStore(state);
  const handoffs = createHandoffs(openHandoff);
  const logger = createLogger();
  const sent = [];
  const engine = createBotEngine({
    flows,
    stateStore,
    handoffs,
    config,
    clock: () => now,
    sendReply: async (reply) => sent.push(reply),
    logger,
    repos: { marker: true },
  });
  return { engine, flows, stateStore, handoffs, logger, sent };
}

function text(value) {
  return { waId: WA_ID, receivedAt: IN_HOURS.toISOString(), kind: 'text', text: value, replyId: null };
}

function listReply(replyId, title = 'Opção') {
  return { waId: WA_ID, receivedAt: IN_HOURS.toISOString(), kind: 'list_reply', text: title, replyId };
}

function buttonReply(replyId, title = 'Botão') {
  return { waId: WA_ID, receivedAt: IN_HOURS.toISOString(), kind: 'button_reply', text: title, replyId };
}

function activeState(overrides = {}) {
  return {
    waId: WA_ID,
    flow: 'booking',
    step: 'choose_day',
    context: { serviceId: 3 },
    cpfAttempts: 0,
    misunderstoodCount: 0,
    expiresAt: new Date(IN_HOURS.getTime() + 10 * 60000),
    ...overrides,
  };
}

function rows(count, prefix = 'booking:choose_day') {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}|v${i + 1}`, title: `Opção ${i + 1}` }));
}

// ---------------------------------------------------------------- entrada

test('inboundFromNormalizedMessage maps webhook message types', () => {
  assert.deepEqual(
    inboundFromNormalizedMessage({
      waId: WA_ID, messageType: 'text', body: 'oi', replyId: null, createdAt: '2026-11-18T13:00:00Z',
    }),
    { waId: WA_ID, receivedAt: '2026-11-18T13:00:00Z', kind: 'text', text: 'oi', replyId: null },
  );
  assert.equal(
    inboundFromNormalizedMessage({ waId: WA_ID, messageType: 'interactive_list_reply', body: 'X', replyId: 'a:b|c' }).kind,
    'list_reply',
  );
  assert.equal(
    inboundFromNormalizedMessage({ waId: WA_ID, messageType: 'interactive_button_reply', body: 'X', replyId: 'btn_atendente' }).replyId,
    'btn_atendente',
  );
  assert.equal(inboundFromNormalizedMessage({ waId: WA_ID, messageType: 'image' }), null);
  assert.equal(inboundFromNormalizedMessage(null), null);
});

test('parseReplyId follows the <flow>:<step>|<value> convention', () => {
  assert.deepEqual(parseReplyId('booking:day|2026-11-24'), { flow: 'booking', step: 'day', value: '2026-11-24' });
  assert.deepEqual(parseReplyId('my_appointments:pick|a|b'), { flow: 'my_appointments', step: 'pick', value: 'a|b' });
  assert.equal(parseReplyId('btn_atendente'), null);
  assert.equal(parseReplyId(null), null);
});

test('invalid inbound is ignored without touching stores', async () => {
  const { engine, flows, handoffs } = setup();
  assert.deepEqual(await engine.handle({ kind: 'text', text: 'oi' }), {
    replies: [], events: [], handoff: null, flow: null, silenced: false,
  });
  assert.deepEqual(await engine.handle({ waId: WA_ID, kind: 'image' }), {
    replies: [], events: [], handoff: null, flow: null, silenced: false,
  });
  assert.equal(flows.menu.calls.length, 0);
  assert.equal(handoffs.opened.length, 0);
});

// ---------------------------------------------------------------- passo 6

test('no state starts the menu with the detected intent and never sends', async () => {
  const { engine, flows, stateStore, sent } = setup();
  const output = await engine.handle(text('qual o preço?'));

  assert.equal(flows.menu.calls.length, 1);
  const [{ method, ctx, input }] = flows.menu.calls;
  assert.equal(method, 'start');
  assert.equal(ctx.waId, WA_ID);
  assert.equal(ctx.now, IN_HOURS);
  assert.equal(ctx.state, null);
  assert.equal(ctx.patient, null);
  assert.equal(ctx.inBusinessHours, true);
  assert.deepEqual(ctx.repos, { marker: true });
  assert.equal(ctx.config, CONFIG);
  assert.deepEqual(input, { kind: 'text', text: 'qual o preço?', replyId: null, intent: 'prices', reply: null });

  assert.deepEqual(output.replies, [{ type: 'text', text: 'menu start' }]);
  assert.equal(output.flow, 'menu');
  assert.equal(output.handoff, null);
  assert.equal(output.silenced, false);
  assert.equal(stateStore.clears, 1, 'next: null clears the state');
  assert.equal(sent.length, 0, 'the engine never calls sendReply');
});

test('next saves the state with expiry, events and zeroed counters', async () => {
  const { engine, stateStore } = setup({
    flows: {
      menu: fakeFlow('menu', {
        start: () => ({
          replies: [{ type: 'text', text: 'Escolha' }],
          next: { flow: 'menu', step: 'main', context: { a: 1 } },
          events: [{ stepKey: 'menu:main' }, { nope: true }],
        }),
      }),
    },
  });
  const output = await engine.handle(text('oi'));

  assert.deepEqual(output.events, [{ stepKey: 'menu:main' }]);
  assert.equal(stateStore.saves.length, 1);
  assert.deepEqual(stateStore.saves[0], {
    waId: WA_ID,
    flow: 'menu',
    step: 'main',
    context: { a: 1 },
    cpfAttempts: 0,
    misunderstoodCount: 0,
    expiresAt: new Date(IN_HOURS.getTime() + 30 * 60000),
  });
});

test('config may be a botConfig object with get()', async () => {
  let gets = 0;
  const { engine, stateStore } = setup({
    config: { get: async () => { gets += 1; return { ...CONFIG, conversationStepTimeoutMinutes: 5 }; } },
    flows: {
      menu: fakeFlow('menu', { start: () => ({ replies: [], next: { flow: 'menu', step: 'main', context: {} } }) }),
    },
  });
  await engine.handle(text('oi'));
  assert.equal(gets, 1);
  assert.deepEqual(stateStore.saves[0].expiresAt, new Date(IN_HOURS.getTime() + 5 * 60000));
});

// ---------------------------------------------------------------- passo 5

test('active state goes to the owning flow handle with patient from context', async () => {
  const patient = { id: 42, firstName: 'Ana' };
  const { engine, flows, stateStore } = setup({
    state: activeState({ context: { serviceId: 3, patient }, cpfAttempts: 2 }),
    flows: {
      booking: fakeFlow('booking', {
        handle: () => ({
          replies: [{ type: 'text', text: 'Escolha o horário' }],
          next: { flow: 'booking', step: 'choose_time', context: { serviceId: 3, day: '2026-11-24' } },
        }),
      }),
    },
  });
  const output = await engine.handle(text('terça'));

  assert.equal(flows.menu.calls.length, 0);
  const [{ method, ctx, input }] = flows.booking.calls;
  assert.equal(method, 'handle');
  assert.equal(ctx.state.flow, 'booking');
  assert.equal(ctx.state.step, 'choose_day');
  assert.deepEqual(ctx.patient, patient);
  assert.equal(input.intent, null);
  assert.equal(output.flow, 'booking');

  const saved = stateStore.saves[0];
  assert.equal(saved.step, 'choose_time');
  assert.deepEqual(saved.context, { serviceId: 3, day: '2026-11-24', patient }, 'patient is carried');
  assert.equal(saved.cpfAttempts, 2, 'cpfAttempts kept within the same flow');
});

test('next.cpfAttempts and explicit patient: null are persisted', async () => {
  const { engine, stateStore } = setup({
    state: activeState({ flow: 'my_appointments', step: 'ask_cpf', context: { patient: { id: 1, firstName: 'X' } } }),
    flows: {
      my_appointments: fakeFlow('my_appointments', {
        handle: (ctx) => ({
          replies: [{ type: 'text', text: 'Não encontrei esse CPF.' }],
          next: { flow: 'my_appointments', step: 'ask_cpf', context: { patient: null }, cpfAttempts: ctx.state.cpfAttempts + 1 },
        }),
      }),
    },
  });
  await engine.handle(text('00000000000'));
  assert.equal(stateStore.saves[0].cpfAttempts, 1);
  assert.deepEqual(stateStore.saves[0].context, {});
});

test('expired state behaves as no state', async () => {
  const { engine, flows } = setup({
    state: activeState({ expiresAt: new Date(IN_HOURS.getTime() - 1000) }),
  });
  await engine.handle(text('terça'));
  assert.equal(flows.booking.calls.length, 0);
  assert.equal(flows.menu.calls[0].method, 'start');
  assert.equal(flows.menu.calls[0].ctx.patient, null);
});

test('state of an unknown flow falls back to the menu', async () => {
  const { engine, flows } = setup({ state: activeState({ flow: 'gone' }) });
  await engine.handle(text('oi'));
  assert.equal(flows.menu.calls[0].method, 'start');
});

// ---------------------------------------------------------------- passo 4

test('prefixed id without state is routed to the owning flow', async () => {
  const { engine, flows } = setup();
  const output = await engine.handle(listReply('booking:day|2026-11-24', '24/11'));

  assert.equal(flows.menu.calls.length, 0);
  const [{ method, ctx, input }] = flows.booking.calls;
  assert.equal(method, 'handle');
  assert.equal(ctx.state, null);
  assert.deepEqual(input.reply, { flow: 'booking', step: 'day', value: '2026-11-24' });
  assert.equal(input.kind, 'list_reply');
  assert.equal(input.intent, null, 'reply titles are not intent-detected');
  assert.equal(output.flow, 'booking');
});

test('prefixed id wins over another flow state, keeping the patient', async () => {
  const patient = { id: 7, firstName: 'Bia' };
  const { engine, flows } = setup({ state: activeState({ flow: 'faq', step: 'answer', context: { patient } }) });
  await engine.handle(buttonReply('booking:start|go'));
  assert.equal(flows.faq.calls.length, 0);
  assert.equal(flows.booking.calls[0].ctx.state, null);
  assert.deepEqual(flows.booking.calls[0].ctx.patient, patient);
});

test('prefixed id of the state flow passes the state', async () => {
  const { engine, flows } = setup({ state: activeState() });
  await engine.handle(listReply('booking:choose_day|2026-11-24'));
  assert.equal(flows.booking.calls[0].ctx.state.step, 'choose_day');
});

test('unknown prefix or legacy faq id falls through to state/menu', async () => {
  const { engine, flows } = setup();
  await engine.handle(listReply('nope:x|y'));
  await engine.handle(listReply('faq_precos'));
  assert.equal(flows.menu.calls.length, 2);
});

// ---------------------------------------------------------------- transições

test('a next of another flow starts it and merges the replies', async () => {
  const patient = { id: 9, firstName: 'Caio' };
  const { engine, flows, stateStore } = setup({
    state: activeState({ flow: 'menu', step: 'main', context: { patient } }),
    flows: {
      menu: fakeFlow('menu', {
        handle: () => ({
          replies: [{ type: 'text', text: 'Vamos agendar.' }],
          next: { flow: 'booking', step: 'choose_service', context: {} },
          events: [{ stepKey: 'menu:main' }],
        }),
      }),
      booking: fakeFlow('booking', {
        start: (ctx) => ({
          replies: [{ type: 'text', text: `Serviço? ${ctx.state.step}` }],
          next: { flow: 'booking', step: 'choose_service', context: { from: ctx.state.flow } },
          events: [{ stepKey: 'booking:choose_service' }],
        }),
      }),
    },
  });
  const output = await engine.handle(listReply('menu:main|book'));

  const [{ method, ctx, input }] = flows.booking.calls;
  assert.equal(method, 'start');
  assert.equal(input, undefined, 'chained start receives no input');
  assert.deepEqual(ctx.state.context, { patient });
  assert.deepEqual(ctx.patient, patient);
  assert.deepEqual(output.replies.map((r) => r.text), ['Vamos agendar.', 'Serviço? choose_service']);
  assert.deepEqual(output.events, [{ stepKey: 'menu:main' }, { stepKey: 'booking:choose_service' }]);
  assert.equal(output.flow, 'booking');
  assert.equal(stateStore.saves.at(-1).flow, 'booking');
  assert.deepEqual(stateStore.saves.at(-1).context, { from: 'booking', patient });
  assert.equal(stateStore.saves.at(-1).cpfAttempts, 0, 'cpfAttempts reset on flow change');
});

test('booking without patient can hand over to triage and back', async () => {
  const { engine, flows, stateStore } = setup({
    flows: {
      booking: fakeFlow('booking', {
        handle: () => ({ replies: [], next: { flow: 'triage', step: 'choose_service', context: {} } }),
      }),
      triage: fakeFlow('triage', {
        start: () => ({ replies: [{ type: 'text', text: 'Qual serviço?' }], next: { flow: 'triage', step: 'choose_service', context: {} } }),
      }),
    },
  });
  const output = await engine.handle(buttonReply('booking:start|go'));
  assert.equal(flows.triage.calls[0].method, 'start');
  assert.deepEqual(output.replies, [{ type: 'text', text: 'Qual serviço?' }]);
  assert.equal(stateStore.saves[0].flow, 'triage');
});

test('endless transitions become a bot_failure', async () => {
  const ping = () => ({ replies: [], next: { flow: 'faq', step: 'x', context: {} } });
  const pong = () => ({ replies: [], next: { flow: 'booking', step: 'x', context: {} } });
  const { engine, handoffs } = setup({
    flows: {
      menu: fakeFlow('menu', { start: ping }),
      faq: fakeFlow('faq', { start: pong }),
      booking: fakeFlow('booking', { start: ping }),
    },
  });
  const output = await engine.handle(text('oi'));
  assert.equal(output.handoff.reason, 'bot_failure');
  assert.equal(handoffs.opened[0].reason, 'bot_failure');
});

// ---------------------------------------------------------------- passo 1

test('open handoff inside the silence window keeps the bot silent', async () => {
  const { engine, flows, handoffs, stateStore } = setup({
    state: activeState(),
    openHandoff: { reason: 'payment', requestedAt: hoursBefore(IN_HOURS, 2), firstTeamReplyAt: null },
  });
  for (const inbound of [text('oi'), text('quero falar com um atendente'), buttonReply('btn_atendente'), listReply('booking:day|x')]) {
    const output = await engine.handle(inbound);
    assert.deepEqual(output, { replies: [], events: [], handoff: null, flow: null, silenced: true });
  }
  assert.equal(flows.menu.calls.length + flows.booking.calls.length, 0);
  assert.equal(handoffs.closed.length, 0);
  assert.equal(stateStore.saves.length + stateStore.clears, 0);
});

test('silence counts from the last team reply', async () => {
  const { engine } = setup({
    openHandoff: {
      reason: 'payment', requestedAt: hoursBefore(IN_HOURS, 20), firstTeamReplyAt: hoursBefore(IN_HOURS, 1).toISOString(),
    },
  });
  assert.equal((await engine.handle(text('oi'))).silenced, true);
});

for (const [label, inbound] of [['MENU text', text('MENU')], ['btn_voltar_menu', buttonReply('btn_voltar_menu')]]) {
  test(`${label} during silence closes the handoff and shows the menu`, async () => {
    const patient = { id: 1, firstName: 'Ana' };
    const { engine, flows, handoffs, stateStore } = setup({
      state: activeState({ context: { patient } }),
      openHandoff: { reason: 'payment', requestedAt: hoursBefore(IN_HOURS, 1) },
    });
    const output = await engine.handle(inbound);
    assert.deepEqual(handoffs.closed, [{ waId: WA_ID, at: IN_HOURS }]);
    assert.equal(flows.menu.calls[0].method, 'start');
    assert.equal(flows.menu.calls[0].input.intent, 'menu');
    assert.equal(flows.menu.calls[0].ctx.state, null);
    assert.deepEqual(flows.menu.calls[0].ctx.patient, patient);
    assert.equal(flows.booking.calls.length, 0);
    assert.ok(stateStore.clears >= 1);
    assert.equal(output.silenced, false);
    assert.equal(output.flow, 'menu');
  });
}

test('MENU without handoff abandons the current step', async () => {
  const { engine, flows } = setup({ state: activeState() });
  await engine.handle(text('menu'));
  assert.equal(flows.booking.calls.length, 0);
  assert.equal(flows.menu.calls[0].method, 'start');
});

test('handoff older than the silence window is closed and the bot answers', async () => {
  const { engine, flows, handoffs } = setup({
    openHandoff: { reason: 'payment', requestedAt: hoursBefore(IN_HOURS, 13) },
  });
  const output = await engine.handle(text('oi'));
  assert.equal(handoffs.closed.length, 1);
  assert.equal(flows.menu.calls.length, 1);
  assert.equal(output.silenced, false);
});

// ---------------------------------------------------------------- passos 2 e 3

test('urgency sends SAMU guidance first, then opens clinical_or_urgency', async () => {
  const { engine, flows, handoffs, stateStore } = setup({ state: activeState() });
  const output = await engine.handle(text('caí e estou sangrando'));

  assert.equal(output.replies.length, 2);
  assert.equal(output.replies[0].text, ENGINE_TEXTS.urgency);
  assert.match(output.replies[0].text, /SAMU \(192\)/);
  assert.match(output.replies[1].text, /equipe/);
  assert.match(output.replies[1].text, /MENU/);
  assert.deepEqual(handoffs.opened, [{ waId: WA_ID, reason: 'clinical_or_urgency', inBusinessHours: true }]);
  assert.deepEqual(output.handoff, { reason: 'clinical_or_urgency', inBusinessHours: true, nextOpeningAt: null });
  assert.deepEqual(output.events, [{ stepKey: 'handoff:clinical_or_urgency' }]);
  assert.equal(stateStore.clears, 1);
  assert.equal(flows.booking.calls.length, 0, 'urgency wins over the active step');
});

for (const [inbound, reason] of [
  [text('quero falar com um atendente'), 'patient_request'],
  [buttonReply('btn_atendente'), 'patient_request'],
  [listReply('menu_atendente'), 'patient_request'],
  [text('preciso do boleto'), 'payment'],
  [text('estou com uma lesão no joelho'), 'clinical_or_urgency'],
  [text('preciso de um atestado'), 'document_request'],
]) {
  test(`${inbound.text ?? inbound.replyId} → handoff ${reason}`, async () => {
    const { engine, flows, handoffs } = setup({ state: activeState() });
    const output = await engine.handle(inbound);
    assert.equal(handoffs.opened[0].reason, reason);
    assert.equal(output.handoff.reason, reason);
    assert.equal(output.replies.length, 1);
    assert.equal(
      output.replies[0].text,
      `${ENGINE_TEXTS.handoffInHours}\n\n${ENGINE_TEXTS.backToMenu}`,
    );
    assert.equal(flows.booking.calls.length + flows.menu.calls.length, 0);
  });
}

test('outside support hours the handoff text tells the next opening', async () => {
  const { engine, handoffs } = setup({ now: OUT_OF_HOURS });
  const output = await engine.handle(text('atendente'));
  assert.equal(handoffs.opened[0].inBusinessHours, false);
  assert.equal(output.handoff.inBusinessHours, false);
  assert.deepEqual(output.handoff.nextOpeningAt, new Date('2026-11-19T11:00:00Z'));
  assert.match(output.replies[0].text, /das 08:00 às 18:00, então a resposta chega amanhã às 08:00\./);
});

test('next opening on another weekday is written in full', async () => {
  const { engine } = setup({
    now: FRIDAY_NIGHT,
    config: { ...CONFIG, humanSupportHours: { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] } },
  });
  const output = await engine.handle(text('atendente'));
  assert.match(output.replies[0].text, /segunda-feira, 23\/11, às 08:00/);
});

test('formatOpening uses today, tomorrow or weekday', () => {
  const early = new Date('2026-11-18T09:00:00Z'); // 06:00 local
  assert.equal(formatOpening(new Date('2026-11-18T11:00:00Z'), early), 'hoje às 08:00');
  assert.equal(formatOpening(new Date('2026-11-19T11:00:00Z'), OUT_OF_HOURS), 'amanhã às 08:00');
  assert.equal(formatOpening(new Date('2026-11-23T11:00:00Z'), FRIDAY_NIGHT), 'segunda-feira, 23/11, às 08:00');
});

// ---------------------------------------------------------------- handoff do fluxo

test('flow handoff opens the reason, appends the team text and clears state', async () => {
  const { engine, handoffs, stateStore } = setup({
    now: OUT_OF_HOURS,
    state: activeState({ flow: 'my_appointments', step: 'pick' }),
    flows: {
      my_appointments: fakeFlow('my_appointments', {
        handle: () => ({
          replies: [{ type: 'text', text: 'Faltam menos de 24 h para a consulta.' }],
          next: { flow: 'my_appointments', step: 'pick', context: {} },
          handoff: { reason: 'late_change' },
          events: [{ stepKey: 'my_appointments:late_change' }],
        }),
      }),
    },
  });
  const output = await engine.handle(listReply('my_appointments:pick|1'));
  assert.deepEqual(handoffs.opened, [{ waId: WA_ID, reason: 'late_change', inBusinessHours: false }]);
  assert.equal(output.replies[0].text, 'Faltam menos de 24 h para a consulta.');
  assert.match(output.replies[1].text, /amanhã às 08:00/);
  assert.deepEqual(output.events, [{ stepKey: 'my_appointments:late_change' }, { stepKey: 'handoff:late_change' }]);
  assert.equal(stateStore.saves.length, 0, 'next is ignored on handoff');
  assert.equal(stateStore.clears, 1);
});

// ---------------------------------------------------------------- não entendido

function misunderstoodFlow() {
  return fakeFlow('booking', {
    handle: (_ctx, input) => (input.text === 'ok'
      ? { replies: [{ type: 'text', text: 'Certo' }], next: { flow: 'booking', step: 'choose_day', context: {} } }
      : {
        replies: [{ type: 'buttons', body: 'Não entendi. Escolha um dia.', buttons: [{ id: 'booking:choose_day|again', title: 'Ver dias' }] }],
        next: { flow: 'booking', step: 'choose_day', context: {} },
        misunderstood: true,
      }),
  });
}

test('misunderstood replies are counted and reset on understood input', async () => {
  const { engine, stateStore, handoffs } = setup({ state: activeState(), flows: { booking: misunderstoodFlow() } });
  const first = await engine.handle(text('blá'));
  assert.equal(first.replies[0].type, 'buttons');
  assert.equal(stateStore.saves.at(-1).misunderstoodCount, 1);
  await engine.handle(text('blá'));
  assert.equal(stateStore.saves.at(-1).misunderstoodCount, 2);
  await engine.handle(text('ok'));
  assert.equal(stateStore.saves.at(-1).misunderstoodCount, 0);
  assert.equal(handoffs.opened.length, 0);
});

test('reaching maxMisunderstoodReplies opens bot_failure', async () => {
  const { engine, stateStore, handoffs } = setup({
    state: activeState({ misunderstoodCount: 2 }),
    flows: { booking: misunderstoodFlow() },
  });
  const output = await engine.handle(text('blá'));
  assert.deepEqual(handoffs.opened, [{ waId: WA_ID, reason: 'bot_failure', inBusinessHours: true }]);
  assert.equal(output.replies.length, 1, 'the repeat prompt is replaced by the handoff');
  assert.ok(output.replies[0].text.startsWith(ENGINE_TEXTS.misunderstood));
  assert.equal(output.handoff.reason, 'bot_failure');
  assert.equal(stateStore.current, null);
});

// ---------------------------------------------------------------- falhas

test('a throwing flow opens bot_failure, replies generically and logs no PII', async () => {
  const { engine, handoffs, logger, stateStore } = setup({
    state: activeState(),
    flows: {
      booking: fakeFlow('booking', {
        handle: () => { throw new RangeError(`CPF 12345678909 of ${WA_ID}`); },
      }),
    },
  });
  const output = await engine.handle(text('terça'));
  assert.equal(output.handoff.reason, 'bot_failure');
  assert.ok(output.replies[0].text.startsWith(ENGINE_TEXTS.failure));
  assert.deepEqual(output.events, [{ stepKey: 'handoff:bot_failure' }]);
  assert.equal(handoffs.opened[0].reason, 'bot_failure');
  assert.equal(stateStore.current, null);
  const logged = JSON.stringify(logger.entries);
  assert.match(logged, /RangeError/);
  assert.match(logged, /"flow":"booking"/);
  assert.doesNotMatch(logged, /12345678909|5571999990000|terça/);
});

test('handle never throws, even when every store fails', async () => {
  const broken = async () => { throw new Error('db down'); };
  const logger = createLogger();
  const engine = createBotEngine({
    flows: { menu: fakeFlow('menu') },
    stateStore: { getActive: broken, save: broken, clear: broken },
    handoffs: { getOpen: broken, open: broken, closeOpen: broken },
    config: CONFIG,
    clock: () => IN_HOURS,
    logger,
  });
  const output = await engine.handle(text('oi'));
  assert.equal(output.handoff.reason, 'bot_failure');
  assert.equal(output.replies.length, 1);
  assert.equal(logger.entries.length, 3);
});

test('invalid flow output (bad reply or result) becomes bot_failure', async () => {
  for (const start of [
    () => ({ replies: [{ type: 'image' }], next: null }),
    () => ({ replies: [{ type: 'text', text: '' }], next: null }),
    () => null,
    () => ({ replies: [], next: { flow: 'menu' } }),
    () => ({ replies: [{ type: 'buttons', body: 'x', buttons: [{ id: 'a:b|1', title: 'A' }, { id: 'a:b|1', title: 'B' }] }] }),
  ]) {
    const { engine } = setup({ flows: { menu: fakeFlow('menu', { start }) } });
    assert.equal((await engine.handle(text('oi'))).handoff.reason, 'bot_failure');
  }
});

test('createBotEngine validates its dependencies', () => {
  assert.throws(() => createBotEngine({}), TypeError);
  assert.throws(() => createBotEngine({ flows: { menu: fakeFlow('menu') } }), TypeError);
});

// ---------------------------------------------------------------- limites e paginação

test('long lists are paginated with a "Ver mais" row handled by the engine', async () => {
  const { engine, flows, stateStore } = setup({
    flows: {
      booking: fakeFlow('booking', {
        handle: (ctx, input) => {
          if (input.reply?.step === 'start') {
            return {
              replies: [{ type: 'list', body: 'Escolha o dia', buttonTitle: 'Ver dias', sections: [{ title: 'Novembro', rows: rows(25) }] }],
              next: { flow: 'booking', step: 'choose_day', context: { serviceId: 3 } },
            };
          }
          return { replies: [{ type: 'text', text: `dia ${input.reply.value}` }], next: null, context: ctx.state.context };
        },
      }),
    },
  });

  const first = await engine.handle(buttonReply('booking:start|go'));
  const page1 = first.replies[0];
  const page1Rows = page1.sections.flatMap((s) => s.rows);
  assert.equal(page1Rows.length, 10);
  assert.deepEqual(page1Rows.at(-1), { id: 'booking:choose_day|more:2', title: 'Ver mais', description: 'Mostrar mais opções' });
  assert.equal(page1Rows[8].id, 'booking:choose_day|v9');
  assert.equal(page1.sections[0].title, 'Novembro');
  assert.equal(stateStore.current.context._pages.pages.length, 3);

  const callsBefore = flows.booking.calls.length;
  const second = await engine.handle(listReply('booking:choose_day|more:2', 'Ver mais'));
  assert.equal(flows.booking.calls.length, callsBefore, '"Ver mais" does not call the flow');
  const page2Rows = second.replies[0].sections.flatMap((s) => s.rows);
  assert.equal(page2Rows[0].id, 'booking:choose_day|v10');
  assert.equal(page2Rows.at(-1).id, 'booking:choose_day|more:3');

  const third = await engine.handle(listReply('booking:choose_day|more:3', 'Ver mais'));
  const page3Rows = third.replies[0].sections.flatMap((s) => s.rows);
  assert.equal(page3Rows.length, 7);
  assert.equal(page3Rows.at(-1).id, 'booking:choose_day|v25');
  assert.equal(stateStore.current.step, 'choose_day');

  // Escolher uma linha volta ao fluxo, sem enxergar a chave reservada.
  await engine.handle(listReply('booking:choose_day|v20'));
  const last = flows.booking.calls.at(-1);
  assert.deepEqual(last.ctx.state.context, { serviceId: 3 });
  assert.equal(last.input.reply.value, 'v20');
});

test('"Ver mais" without stored pages goes to the flow', async () => {
  const { engine, flows } = setup();
  await engine.handle(listReply('booking:choose_day|more:2'));
  assert.equal(flows.booking.calls[0].input.reply.value, 'more:2');
});

test('engine output is truncated to WhatsApp limits', async () => {
  const long = 'x'.repeat(5000);
  const { engine } = setup({
    flows: {
      menu: fakeFlow('menu', {
        start: () => ({
          replies: [
            { type: 'text', text: long },
            { type: 'buttons', body: long, buttons: [{ id: 'faq:a|1', title: 'Um título bem comprido demais' }] },
            {
              type: 'list',
              body: 'Menu',
              buttonTitle: 'Abrir a lista de opções',
              sections: [{ title: 'Uma seção com título enorme', rows: [{ id: 'menu:main|1', title: 'Agendar consulta agora mesmo', description: 'd'.repeat(100) }] }],
            },
          ],
          next: null,
        }),
      }),
    },
  });
  const [t, b, l] = (await engine.handle(text('oi'))).replies;
  assert.equal(Array.from(t.text).length, WHATSAPP_LIMITS.textBody);
  assert.ok(t.text.endsWith('…'));
  assert.equal(Array.from(b.body).length, WHATSAPP_LIMITS.interactiveBody);
  assert.equal(b.buttons[0].title, 'Um título bem compr…');
  assert.equal(Array.from(b.buttons[0].title).length, 20);
  assert.equal(l.buttonTitle.length, 20);
  assert.equal(l.sections[0].title.length, 24);
  assert.equal(l.sections[0].rows[0].title, 'Agendar consulta agora…');
  assert.equal(l.sections[0].rows[0].description.length, 72);
});

// ---------------------------------------------------------------- replies.js

test('truncate keeps short text and cuts long text with an ellipsis', () => {
  assert.equal(truncate('  curto  ', 10), 'curto');
  assert.equal(truncate('abcdefghij', 10), 'abcdefghij');
  assert.equal(truncate('abcdefghijk', 10), 'abcdefghi…');
  assert.equal(truncate('😀😀😀', 2), '😀…');
});

test('more than 3 buttons become a list with the same options', () => {
  const [reply] = normalizeReplies([{
    type: 'buttons',
    body: 'Escolha',
    buttons: [1, 2, 3, 4].map((n) => ({ id: `faq:x|${n}`, title: `B${n}` })),
  }]);
  assert.equal(reply.type, 'list');
  assert.deepEqual(reply.sections[0].rows.map((r) => r.id), ['faq:x|1', 'faq:x|2', 'faq:x|3', 'faq:x|4']);
  assert.equal(reply.buttonTitle, 'Ver opções');
});

test('pagination keeps section titles and limits pages to 10 rows', () => {
  const { replies, pages } = normalizeRepliesWithPages([{
    type: 'list',
    body: 'Horários',
    sections: [
      { title: 'Manhã', rows: rows(6, 'booking:choose_time') },
      { title: 'Tarde', rows: rows(6, 'booking:choose_time').map((r) => ({ ...r, id: `${r.id}t` })) },
    ],
  }], { morePrefix: 'booking:choose_time' });
  assert.equal(pages.length, 2);
  assert.deepEqual(replies[0].sections.map((s) => [s.title, s.rows.length]), [['Manhã', 6], ['Tarde', 4]]);
  assert.equal(replies[0].sections[1].rows.at(-1).id, 'booking:choose_time|more:2');
  assert.deepEqual(pages[1].sections.map((s) => [s.title, s.rows.length]), [['Tarde', 3]]);
  for (const page of pages) {
    assert.ok(page.sections.flatMap((s) => s.rows).length <= WHATSAPP_LIMITS.listMaxRows);
  }
});

test('long list without a prefix is cut to 10 rows; only one list paginates', () => {
  assert.equal(normalizeReplies([{ type: 'list', body: 'x', sections: [{ rows: rows(15) }] }])[0].sections[0].rows.length, 10);

  const { replies, pages } = normalizeRepliesWithPages([
    { type: 'list', body: 'a', sections: [{ rows: rows(12) }] },
    { type: 'list', body: 'b', sections: [{ rows: rows(12, 'faq:x') }] },
  ], { morePrefix: 'booking:choose_day' });
  assert.equal(pages.length, 2);
  assert.equal(replies[1].sections[0].rows.length, 10);
  assert.ok(replies[1].sections[0].rows.every((r) => !r.id.includes('more:')));
});

test('ids are validated, never truncated', () => {
  assert.throws(() => normalizeReplies([{ type: 'list', body: 'x', sections: [{ rows: [{ id: 'a'.repeat(201), title: 't' }] }] }]), TypeError);
  assert.throws(() => normalizeReplies([{ type: 'buttons', body: 'x', buttons: [{ id: '', title: 't' }] }]), TypeError);
  assert.throws(() => normalizeReplies([{ type: 'list', body: 'x', sections: [] }]), TypeError);
  assert.throws(() => normalizeReplies('nope'), TypeError);
});
