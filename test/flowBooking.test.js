import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bookingFlow,
  formatMoney,
  formatShortDay,
  formatWhen,
  matchChoice,
  paymentOptions,
} from '../src/services/bot/flows/booking.js';
import { createBotEngine, parseReplyId } from '../src/services/bot/engine.js';
import { normalizeReplies } from '../src/services/bot/replies.js';

const WA_ID = '5571999990000';
// Quarta-feira, 18/11/2026, 10:00 em America/Bahia.
const NOW = new Date('2026-11-18T13:00:00Z');
const PATIENT = Object.freeze({ id: 501, firstName: 'Ana' });
const CONFIG = Object.freeze({
  timezone: 'America/Bahia',
  bookingHorizonDays: 21,
  rescheduleMinNoticeHours: 24,
});

const SERVICES = [
  { id: 1, name: 'Fisioterapia ambulatorial', durationMin: 50, slotCapacity: 2, professionals: [{ id: 1, name: 'Carla' }, { id: 2, name: 'Diego' }] },
  { id: 2, name: 'RPG', durationMin: 50, slotCapacity: 1, professionals: [{ id: 3, name: 'Rita' }] },
  { id: 3, name: 'Pilates', durationMin: 50, slotCapacity: 4, professionals: [{ id: 4, name: 'Paula' }] },
  { id: 4, name: 'Massagem', durationMin: 50, slotCapacity: 1, professionals: [{ id: 5, name: 'Marta' }] },
];
const PLANS = [{ id: 1, name: 'Convênio A' }, { id: 2, name: 'Convênio B' }];
const PRICES = [
  { serviceId: 1, kind: 'avulso', amount: 150 },
  { serviceId: 1, kind: 'pacote', amount: 1200 },
  { serviceId: 2, kind: 'avulso', amount: 160 },
  { serviceId: 2, kind: 'pacote', amount: 1300 },
  { serviceId: 3, kind: 'mensalidade', amount: 320 },
  { serviceId: 3, kind: 'pacote', amount: 999 },
  { serviceId: 4, kind: 'avulso', amount: 120 },
  { serviceId: 4, kind: 'pacote', amount: 500 },
];
const FAQ = [
  { slug: 'endereco', question: 'Onde?', answer: 'Rua das Acácias, 123.' },
  { slug: 'o_que_levar', question: 'O que levar?', answer: 'Documento com foto.' },
];

const TIMES_27 = [
  { hour: 8, professionalId: 1, professionalName: 'Carla', remaining: 2 },
  { hour: 9, professionalId: 2, professionalName: 'Diego', remaining: 1 },
  { hour: 8, professionalId: 2, professionalName: 'Diego', remaining: 1 },
];

function createRepos(overrides = {}) {
  const calls = { days: [], times: [], book: [], upcoming: [], leads: [] };
  const days = overrides.days ?? (() => [
    { date: '2026-11-27', freeSlots: 3 },
    { date: '2026-11-30', freeSlots: 1 },
  ]);
  const times = overrides.times ?? (({ serviceId, date, professionalId }) => {
    if (date !== '2026-11-27') return [];
    if (serviceId !== 1) {
      const [pro] = SERVICES.find((s) => s.id === serviceId).professionals;
      return [{ hour: 8, professionalId: pro.id, professionalName: pro.name, remaining: 1 }];
    }
    return TIMES_27.filter((t) => professionalId === null || t.professionalId === professionalId);
  });
  const upcoming = overrides.upcoming ?? [];
  const book = overrides.book ?? ((args) => ({
    ok: true,
    appointment: {
      id: 9001, patientId: args.patientId, serviceId: args.serviceId, date: args.date, hour: args.hour,
      sessionValue: args.paymentMethod === 'Particular avulso' ? 150 : null,
    },
  }));
  const repos = {
    catalog: {
      listServices: async () => SERVICES,
      listInsurancePlans: async () => PLANS,
      listPrices: async () => PRICES,
      listFaqEntries: async () => FAQ,
    },
    appointments: {
      listAvailableDays: async (args) => { calls.days.push(args); return days(args); },
      listAvailableTimes: async (args) => { calls.times.push(args); return times(args); },
      listUpcoming: async (args) => { calls.upcoming.push(args); return typeof upcoming === 'function' ? upcoming() : upcoming; },
      book: async (args) => { calls.book.push(args); return book(args); },
    },
    patients: {
      upsertLead: async (args) => {
        calls.leads.push(args);
        if (overrides.leadFails) throw new Error('lead down');
        return { leadId: 1 };
      },
    },
  };
  return { repos, calls };
}

// Simula o engine: guarda o `next` como estado e repassa o paciente.
function createDriver({ repos, patient = PATIENT, inBusinessHours = true } = {}) {
  const driver = {
    state: null,
    patient,
    ctx() {
      return {
        waId: WA_ID,
        now: NOW,
        config: CONFIG,
        state: driver.state,
        patient: driver.patient,
        inBusinessHours,
        repos,
      };
    },
    apply(result) {
      normalizeReplies(result.replies); // respeita os limites do WhatsApp
      if (result.next && result.next.flow === 'booking') {
        driver.state = { flow: 'booking', step: result.next.step, context: result.next.context };
      } else {
        driver.state = null;
      }
      return result;
    },
    async start(state = null) {
      driver.state = state;
      return driver.apply(await bookingFlow.start(driver.ctx()));
    },
    async click(id) {
      const input = { kind: 'list_reply', text: null, replyId: id, intent: null, reply: parseReplyId(id) };
      return driver.apply(await bookingFlow.handle(driver.ctx(), input));
    },
    async type(text) {
      const input = { kind: 'text', text, replyId: null, intent: null, reply: null };
      return driver.apply(await bookingFlow.handle(driver.ctx(), input));
    },
  };
  return driver;
}

function lastInteractive(result) {
  return result.replies.filter((r) => r.type !== 'text').at(-1);
}

function rowIds(result) {
  return lastInteractive(result).sections.flatMap((s) => s.rows.map((r) => r.id));
}

function buttonIds(result) {
  return lastInteractive(result).buttons.map((b) => b.id);
}

function allText(result) {
  return result.replies.map((r) => r.text ?? r.body).join('\n');
}

test('exports the flow contract', () => {
  assert.equal(bookingFlow.name, 'booking');
  assert.equal(typeof bookingFlow.start, 'function');
  assert.equal(typeof bookingFlow.handle, 'function');
});

test('formatting helpers', () => {
  assert.equal(formatWhen('2026-11-27', 8), 'sexta-feira, 27 de novembro, às 08:00');
  assert.equal(formatShortDay('2026-11-30'), 'seg, 30/11');
  assert.equal(formatMoney(1200), 'R$ 1.200,00');
  assert.equal(formatMoney(150.5), 'R$ 150,50');
});

test('happy path: service, professional, payment, day, time, confirm, book', async () => {
  const { repos, calls } = createRepos();
  const d = createDriver({ repos });

  let r = await d.start();
  assert.equal(r.next.step, 'choose_service');
  assert.deepEqual(r.events, [{ stepKey: 'booking:choose_service' }]);
  assert.deepEqual(rowIds(r), ['booking:choose_service|1', 'booking:choose_service|2', 'booking:choose_service|3', 'booking:choose_service|4']);
  assert.equal(calls.leads[0].stage, 'service');
  assert.equal(calls.leads[0].waId, WA_ID);
  assert.equal(calls.leads[0].outsideBusinessHours, false);

  r = await d.click('booking:choose_service|1');
  assert.equal(r.next.step, 'choose_professional');
  assert.deepEqual(rowIds(r), ['booking:choose_professional|1', 'booking:choose_professional|2', 'booking:choose_professional|any']);
  assert.ok(calls.leads.some((l) => l.stage === 'service' && l.serviceInterestId === 1));

  r = await d.click('booking:choose_professional|1');
  assert.equal(r.next.step, 'choose_payment');
  assert.deepEqual(rowIds(r), [
    'booking:choose_payment|ins:1', 'booking:choose_payment|ins:2',
    'booking:choose_payment|avulso', 'booking:choose_payment|pacote',
  ]);
  assert.match(JSON.stringify(r.replies), /R\$ 150,00 por sessão/);

  r = await d.click('booking:choose_payment|avulso');
  assert.equal(r.next.step, 'choose_day');
  assert.deepEqual(r.next.context.payment, { method: 'Particular avulso', insuranceId: null });
  assert.deepEqual(rowIds(r), ['booking:choose_day|2026-11-27', 'booking:choose_day|2026-11-30']);
  assert.deepEqual(calls.days.at(-1), {
    serviceId: 1, professionalId: 1, from: '2026-11-18', horizonDays: 21, now: NOW,
  });
  assert.ok(calls.leads.some((l) => l.stage === 'time' && l.serviceInterestId === 1));

  r = await d.click('booking:choose_day|2026-11-27');
  assert.equal(r.next.step, 'choose_time');
  assert.deepEqual(rowIds(r), ['booking:choose_time|8-1', 'booking:choose_time|other_day']);

  r = await d.click('booking:choose_time|8-1');
  assert.equal(r.next.step, 'confirm');
  assert.deepEqual(buttonIds(r), ['booking:confirm|yes', 'booking:confirm|change', 'booking:confirm|cancel']);
  assert.match(allText(r), /sexta-feira, 27 de novembro, às 08:00/);
  assert.match(allText(r), /Carla/);
  assert.deepEqual(r.next.context.time, { hour: 8, professionalId: 1, professionalName: 'Carla' });

  r = await d.click('booking:confirm|yes');
  assert.equal(r.next, null);
  assert.deepEqual(r.events, [{ stepKey: 'booking:booked' }]);
  assert.deepEqual(calls.book, [{
    patientId: 501, waId: WA_ID, serviceId: 1, professionalId: 1, date: '2026-11-27', hour: 8,
    paymentMethod: 'Particular avulso', insuranceId: null, now: NOW,
  }]);
  const final = allText(r);
  assert.match(final, /Ana/);
  assert.match(final, /sexta-feira, 27 de novembro, às 08:00/);
  assert.match(final, /Fisioterapia ambulatorial/);
  assert.match(final, /Carla/);
  assert.match(final, /Particular avulso \(R\$ 150,00 por sessão\)/);
  assert.match(final, /Rua das Acácias/);
  assert.match(final, /Documento com foto/);
  assert.match(final, /24 h/);
  const booked = calls.leads.at(-1);
  assert.equal(booked.stage, 'booked');
  assert.equal(booked.booked, true);
  assert.equal(booked.patientId, 501);
});

test('skips professional step when the service has a single professional', async () => {
  const { repos } = createRepos();
  const d = createDriver({ repos });
  await d.start();
  const r = await d.click('booking:choose_service|2');
  assert.equal(r.next.step, 'choose_payment');
  assert.equal(r.next.context.professionalId, 3);
  assert.deepEqual(r.events, [{ stepKey: 'booking:choose_payment' }]);
});

test('"Sem preferência" searches every professional', async () => {
  const { repos, calls } = createRepos();
  const d = createDriver({ repos });
  await d.start();
  await d.click('booking:choose_service|1');
  await d.click('booking:choose_professional|any');
  await d.click('booking:choose_payment|pacote');
  assert.equal(calls.days.at(-1).professionalId, null);
  const r = await d.click('booking:choose_day|2026-11-27');
  assert.deepEqual(rowIds(r), [
    'booking:choose_time|8-1', 'booking:choose_time|9-2', 'booking:choose_time|8-2', 'booking:choose_time|other_day',
  ]);
});

test('Pilates only offers Mensalidade and Massagem only Particular avulso', async () => {
  const { repos } = createRepos();
  const pilates = await paymentOptions({ repos }, SERVICES[2]);
  assert.deepEqual(pilates.map((o) => o.payment), [{ method: 'Mensalidade', insuranceId: null }]);
  const massagem = await paymentOptions({ repos }, SERVICES[3]);
  assert.deepEqual(massagem.map((o) => o.payment), [{ method: 'Particular avulso', insuranceId: null }]);

  const d = createDriver({ repos });
  await d.start();
  let r = await d.click('booking:choose_service|3');
  assert.equal(r.next.step, 'choose_day');
  assert.deepEqual(r.next.context.payment, { method: 'Mensalidade', insuranceId: null });
  assert.match(allText(r), /Mensalidade \(R\$ 320,00 por mês\)/);
  assert.deepEqual(r.events, [{ stepKey: 'booking:choose_day' }]);

  // Um clique forjado em "pacote" para Pilates não é aceito.
  d.state = { flow: 'booking', step: 'choose_payment', context: { serviceId: 3, professionalId: 4 } };
  r = await d.click('booking:choose_payment|pacote');
  assert.equal(r.misunderstood, true);
  assert.equal(r.next.context.payment.method, 'Mensalidade');

  await d.start();
  r = await d.click('booking:choose_service|4');
  assert.deepEqual(r.next.context.payment, { method: 'Particular avulso', insuranceId: null });
});

test('entry from triage starts at choose_day with service and payment', async () => {
  const { repos, calls } = createRepos();
  const d = createDriver({ repos });
  let r = await d.start({
    flow: 'booking',
    step: 'choose_day',
    context: { serviceId: 1, payment: { method: 'Convênio', insuranceId: 2 }, patient: PATIENT, newPatient: true },
  });
  assert.equal(r.next.step, 'choose_day');
  assert.equal(r.next.context.newPatient, true);
  assert.equal(r.next.context.professionalId, null);
  assert.equal('patient' in r.next.context, false);
  assert.equal(calls.days.at(-1).professionalId, null);

  await d.click('booking:choose_day|2026-11-27');
  r = await d.click('booking:choose_time|9-2');
  assert.match(allText(r), /Convênio B/);
  r = await d.click('booking:confirm|yes');
  assert.equal(calls.book[0].paymentMethod, 'Convênio');
  assert.equal(calls.book[0].insuranceId, 2);
  assert.equal(calls.book[0].professionalId, 2);
  assert.match(allText(r), /Convênio B/);
});

test('without a verified patient the flow goes to triage', async () => {
  const { repos, calls } = createRepos();
  const d = createDriver({ repos, patient: null });
  let r = await d.start();
  assert.deepEqual(r.next, { flow: 'triage', step: 'choose_service', context: {} });
  assert.deepEqual(r.replies, []);
  assert.equal(calls.leads.length, 0);

  r = await bookingFlow.handle(d.ctx(), {
    kind: 'list_reply', text: null, replyId: 'booking:choose_service|2', intent: null,
    reply: parseReplyId('booking:choose_service|2'),
  });
  assert.deepEqual(r.next, { flow: 'triage', step: 'choose_service', context: { serviceId: 2 } });
});

async function reachConfirm(d) {
  await d.start();
  await d.click('booking:choose_service|1');
  await d.click('booking:choose_professional|1');
  await d.click('booking:choose_payment|avulso');
  await d.click('booking:choose_day|2026-11-27');
  return d.click('booking:choose_time|8-1');
}

test('slot lost at confirmation goes back to the times of the same day', async () => {
  const { repos } = createRepos({ book: () => ({ ok: false, reason: 'slot_unavailable' }) });
  const d = createDriver({ repos });
  await reachConfirm(d);
  const r = await d.click('booking:confirm|yes');
  assert.equal(r.next.step, 'choose_time');
  assert.equal(r.next.context.date, '2026-11-27');
  assert.equal(r.next.context.time, undefined);
  assert.match(r.replies[0].text, /reservado por outra pessoa/);
  assert.deepEqual(r.events, [{ stepKey: 'booking:choose_time' }]);
});

test('slot gone between list and click re-shows times; empty day goes back to days', async () => {
  let available = TIMES_27;
  const { repos } = createRepos({ times: () => available });
  const d = createDriver({ repos });
  await d.start();
  await d.click('booking:choose_service|2');
  await d.click('booking:choose_payment|avulso');
  await d.click('booking:choose_day|2026-11-27');
  available = TIMES_27.filter((t) => t.hour !== 8);
  let r = await d.click('booking:choose_time|8-1');
  assert.equal(r.next.step, 'choose_time');
  assert.match(r.replies[0].text, /acabou de ser preenchido/);
  available = [];
  r = await d.click('booking:choose_time|9-2');
  assert.equal(r.next.step, 'choose_day');
});

test('duplicate booking guard on time choice and on confirmation', async () => {
  const same = [{ id: 7, date: '2026-11-27', hour: 8, serviceId: 2 }];
  let upcoming = same;
  const { repos, calls } = createRepos({ upcoming: () => upcoming });
  const d = createDriver({ repos });
  let r = await reachConfirm(d);
  assert.equal(r.next.step, 'choose_time');
  assert.match(r.replies[0].text, /já tem uma consulta marcada/);

  upcoming = [];
  r = await d.click('booking:choose_time|8-1');
  assert.equal(r.next.step, 'confirm');
  upcoming = same;
  r = await d.click('booking:confirm|yes');
  assert.equal(r.next.step, 'choose_time');
  assert.equal(calls.book.length, 0);
});

test('no availability in the horizon offers another professional or the team', async () => {
  const { repos } = createRepos({ days: ({ professionalId }) => (professionalId === 1 ? [] : [{ date: '2026-11-27', freeSlots: 1 }]) });
  const d = createDriver({ repos });
  await d.start();
  await d.click('booking:choose_service|1');
  await d.click('booking:choose_professional|1');
  let r = await d.click('booking:choose_payment|avulso');
  assert.equal(r.next.step, 'no_slots');
  assert.deepEqual(buttonIds(r), ['booking:no_slots|other_professional', 'booking:no_slots|human', 'menu:main|show']);
  assert.match(allText(r), /próximos 21 dias/);
  assert.deepEqual(r.events, [{ stepKey: 'booking:no_slots' }]);

  r = await d.click('booking:no_slots|other_professional');
  assert.equal(r.next.step, 'choose_professional');
  assert.equal(r.next.context.payment.method, 'Particular avulso');
  r = await d.click('booking:choose_professional|2');
  assert.equal(r.next.step, 'choose_day', 'payment is kept when changing professional');

  d.state = { flow: 'booking', step: 'no_slots', context: { serviceId: 1, professionalId: 1, payment: { method: 'Particular avulso', insuranceId: null } } };
  r = await d.click('booking:no_slots|human');
  assert.deepEqual(r.handoff, { reason: 'patient_request' });
  assert.equal(r.next, null);
});

test('no availability for a single-professional service only offers the team', async () => {
  const { repos } = createRepos({ days: () => [] });
  const d = createDriver({ repos });
  await d.start();
  const r = await d.click('booking:choose_service|4');
  assert.equal(r.next.step, 'no_slots');
  assert.deepEqual(buttonIds(r), ['booking:no_slots|human', 'menu:main|show']);
});

test('text input matches titles, aliases and numbers; unknown text is misunderstood', async () => {
  const { repos, calls } = createRepos();
  const d = createDriver({ repos });
  await d.start();
  let r = await d.type('rpg');
  assert.equal(r.next.step, 'choose_payment');
  assert.equal(r.next.context.serviceId, 2);

  r = await d.type('banana');
  assert.equal(r.misunderstood, true);
  assert.equal(r.next.step, 'choose_payment');
  assert.deepEqual(r.events, []);

  r = await d.type('particular avulso');
  assert.equal(r.next.step, 'choose_day');
  r = await d.type('27/11');
  assert.equal(r.next.step, 'choose_time');
  r = await d.type('8h');
  assert.equal(r.next.step, 'confirm');
  r = await d.type('Sim');
  assert.equal(r.next, null);
  assert.equal(calls.book.length, 1);

  await d.start();
  r = await d.type('3');
  assert.equal(r.next.context.serviceId, 3);
  await d.start();
  r = await d.type('fisioterápia');
  assert.equal(r.next.step, 'choose_professional');
  r = await d.type('sem preferencia');
  assert.equal(r.next.context.professionalId, null);

  assert.equal(matchChoice('', [{ title: 'A' }]), null);
});

test('confirm buttons: change goes back to times, cancel ends without booking', async () => {
  const { repos, calls } = createRepos();
  const d = createDriver({ repos });
  await reachConfirm(d);
  let r = await d.click('booking:confirm|change');
  assert.equal(r.next.step, 'choose_time');
  assert.equal(r.next.context.date, '2026-11-27');
  await d.click('booking:choose_time|8-1');
  r = await d.click('booking:confirm|cancel');
  assert.equal(r.next, null);
  assert.equal(calls.book.length, 0);
  assert.deepEqual(r.events, [{ stepKey: 'booking:cancelled' }]);
});

test('lead failures never break the booking', async () => {
  const { repos, calls } = createRepos({ leadFails: true });
  const d = createDriver({ repos, inBusinessHours: false });
  await reachConfirm(d);
  const r = await d.click('booking:confirm|yes');
  assert.deepEqual(r.events, [{ stepKey: 'booking:booked' }]);
  assert.equal(calls.book.length, 1);
  assert.ok(calls.leads.length >= 3);
  assert.ok(calls.leads.every((l) => l.outsideBusinessHours === true));
});

test('stale click without saved context restarts at the service list', async () => {
  const { repos } = createRepos();
  const d = createDriver({ repos });
  const r = await d.click('booking:choose_time|8-1');
  assert.equal(r.next.step, 'choose_service');
});

test('runs inside the engine: paginated days and booking', async () => {
  const manyDays = Array.from({ length: 15 }, (_, i) => ({
    date: `2026-12-${String(i + 1).padStart(2, '0')}`, freeSlots: 1,
  }));
  const { repos, calls } = createRepos({
    days: () => manyDays,
    times: () => [{ hour: 10, professionalId: 3, professionalName: 'Rita', remaining: 1 }],
  });
  let saved = {
    waId: WA_ID, flow: 'booking', step: 'choose_service', context: { patient: PATIENT },
    cpfAttempts: 0, misunderstoodCount: 0, expiresAt: new Date(NOW.getTime() + 600000),
  };
  const stateStore = {
    getActive: async () => saved,
    save: async (state) => { saved = state; },
    clear: async () => { saved = null; },
  };
  const handoffs = {
    open: async () => {}, getOpen: async () => null, closeOpen: async () => {}, markFirstTeamReply: async () => {},
  };
  const menu = {
    name: 'menu',
    start: async () => ({ replies: [{ type: 'text', text: 'menu' }], next: null }),
    handle: async () => ({ replies: [], next: null }),
  };
  const engine = createBotEngine({
    flows: { menu, booking: bookingFlow }, stateStore, handoffs, config: CONFIG, clock: () => NOW, repos, logger: {},
  });
  const click = (id) => engine.handle({ waId: WA_ID, kind: 'list_reply', text: 'x', replyId: id });

  await click('booking:choose_service|2');
  let out = await click('booking:choose_payment|avulso');
  const rows = out.replies.at(-1).sections.flatMap((s) => s.rows.map((r) => r.id));
  assert.equal(rows.length, 10);
  assert.equal(rows.at(-1), 'booking:choose_day|more:2');
  out = await click('booking:choose_day|more:2');
  assert.equal(out.replies[0].sections.flatMap((s) => s.rows).length, 6);
  await click('booking:choose_day|2026-12-14');
  await click('booking:choose_time|10-3');
  out = await click('booking:confirm|yes');
  assert.deepEqual(out.events, [{ stepKey: 'booking:booked' }]);
  assert.equal(out.handoff, null);
  assert.equal(calls.book[0].date, '2026-12-14');
  assert.equal(saved, null);
});
