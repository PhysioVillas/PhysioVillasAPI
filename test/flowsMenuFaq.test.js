import assert from 'node:assert/strict';
import test from 'node:test';
import { menuFlow } from '../src/services/bot/flows/menu.js';
import { faqFlow, formatBRL } from '../src/services/bot/flows/faq.js';
import { WHATSAPP_LIMITS, normalizeReplies } from '../src/services/bot/replies.js';

const NOW = new Date('2026-11-18T15:00:00Z');

function fakeCatalog(overrides = {}) {
  const calls = { holidays: [] };
  return {
    calls,
    async listServices() {
      return [
        { id: 1, name: 'Pilates', durationMin: 60, slotCapacity: 4, professionals: [{ id: 1, name: 'Marina' }] },
        {
          id: 2, name: 'Fisioterapia', durationMin: 60, slotCapacity: 1,
          professionals: [{ id: 2, name: 'Paulo' }, { id: 3, name: 'Lia' }, { id: 4, name: 'Caio' }],
        },
      ];
    },
    async listInsurancePlans() {
      return [{ id: 1, name: 'Convênio A' }, { id: 2, name: 'Convênio B' }];
    },
    async listPrices() {
      return [
        { serviceId: 1, kind: 'mensalidade', amount: 280 },
        { serviceId: 2, kind: 'pacote', amount: 1000 },
        { serviceId: 2, kind: 'avulso', amount: 120.5 },
      ];
    },
    async listHolidays(range) {
      calls.holidays.push(range);
      return ['2026-12-08'];
    },
    async listFaqEntries() {
      return [
        { slug: 'endereco', question: 'Onde?', answer: 'Rua das Acácias, 123.' },
        { slug: 'o_que_levar', question: 'Levar?', answer: 'Documento com foto.' },
        { slug: 'primeira_consulta', question: 'Primeira?', answer: 'Dura 60 minutos.' },
        { slug: 'politica_cancelamento', question: 'Cancelar?', answer: 'Até 24 horas antes.' },
        { slug: 'formas_pagamento', question: 'Pagar?', answer: 'PIX e cartão.' },
        { slug: 'sobre_servico_1', question: 'Pilates?', answer: 'Turmas pequenas.' },
      ];
    },
    async getOpeningHours() {
      return [1, 2, 3, 4, 5].map((weekday) => ({ weekday, firstHour: 8, lastHour: 17 }))
        .concat([{ weekday: 6, firstHour: 8, lastHour: 12 }]);
    },
    ...overrides,
  };
}

const ctxOf = (extra = {}) => ({
  waId: '5571999990000',
  now: NOW,
  config: { timezone: 'America/Bahia' },
  state: null,
  patient: null,
  inBusinessHours: true,
  repos: { catalog: fakeCatalog() },
  ...extra,
});

const listInput = (id) => {
  const [head, value] = id.split('|');
  const [flow, step] = head.split(':');
  return { kind: 'list_reply', text: '', replyId: id, intent: null, reply: { flow, step, value } };
};
const textInput = (text, intent = null) => ({ kind: 'text', text, replyId: null, intent, reply: null });

test('menu: lista com 7 linhas, títulos e ids dentro dos limites', async () => {
  const result = await menuFlow.start(ctxOf());
  const [list] = result.replies;
  assert.equal(list.type, 'list');
  const rows = list.sections.flatMap((s) => s.rows);
  assert.deepEqual(rows.map((r) => r.id), [
    'menu:main|booking', 'menu:main|my_appointments', 'menu:main|services', 'menu:main|insurance',
    'menu:main|hours_address', 'menu:main|first_visit', 'menu:main|human',
  ]);
  assert.deepEqual(rows.map((r) => r.title), [
    'Agendar consulta', 'Minhas consultas', 'Serviços e valores', 'Convênios aceitos',
    'Horários e endereço', 'Primeira consulta', 'Falar com a equipe',
  ]);
  for (const row of rows) {
    assert.ok(Array.from(row.title).length <= WHATSAPP_LIMITS.rowTitle);
    assert.ok(Array.from(row.description).length <= WHATSAPP_LIMITS.rowDescription);
  }
  assert.ok(Array.from(list.buttonTitle).length <= WHATSAPP_LIMITS.listButtonTitle);
  assert.ok(Array.from(list.body).length <= WHATSAPP_LIMITS.interactiveBody);
  assert.equal(list.body, 'Olá! Aqui é o atendimento da PhysioVilas. Toque em "Ver opções" e escolha o assunto.');
  assert.deepEqual(result.events, [{ stepKey: 'menu:show' }]);
  assert.deepEqual(result.next, { flow: 'menu', step: 'main', context: {} });
  assert.deepEqual(normalizeReplies(result.replies), result.replies);
});

test('menu: saudação com o primeiro nome do paciente', async () => {
  const result = await menuFlow.start(ctxOf({ patient: { id: 1, firstName: 'Ana' } }));
  assert.match(result.replies[0].body, /^Olá, Ana! /);
});

test('menu: roteamento das opções', async () => {
  const route = async (id) => menuFlow.handle(ctxOf(), listInput(id));
  assert.deepEqual((await route('menu:main|booking')).next, { flow: 'booking', step: 'choose_service', context: {} });
  assert.deepEqual((await route('menu:main|my_appointments')).next, { flow: 'my_appointments', step: 'start', context: {} });
  for (const topic of ['services', 'insurance', 'hours_address', 'first_visit']) {
    assert.deepEqual((await route(`menu:main|${topic}`)).next, { flow: 'faq', step: topic, context: {} });
  }
  const human = await route('menu:main|human');
  assert.deepEqual(human.handoff, { reason: 'patient_request' });
  assert.equal(human.next, null);
  const show = await route('menu:main|show');
  assert.equal(show.replies[0].type, 'list');
  assert.equal(show.misunderstood, undefined);
});

test('menu: texto com intenção é encaminhado; texto desconhecido reexibe o menu', async () => {
  assert.deepEqual((await menuFlow.start(ctxOf(), textInput('quanto custa', 'prices'))).next,
    { flow: 'faq', step: 'services', context: {} });
  assert.deepEqual((await menuFlow.handle(ctxOf(), textInput('endereço', 'address'))).next,
    { flow: 'faq', step: 'hours_address', context: {} });
  assert.deepEqual((await menuFlow.handle(ctxOf(), textInput('quero marcar', 'book'))).next,
    { flow: 'booking', step: 'choose_service', context: {} });
  assert.deepEqual((await menuFlow.handle(ctxOf(), textInput('cancelar', 'cancel'))).next,
    { flow: 'my_appointments', step: 'start', context: {} });
  const unknown = await menuFlow.handle(ctxOf(), textInput('blá'));
  assert.equal(unknown.misunderstood, true);
  assert.match(unknown.replies[0].body, /^Não entendi sua mensagem\. /);
  const asMenu = await menuFlow.handle(ctxOf(), textInput('menu', 'menu'));
  assert.equal(asMenu.misunderstood, undefined);
});

function assertAnswerShape(result, topic) {
  assert.equal(result.replies.length, 2);
  const [text, buttons] = result.replies;
  assert.equal(text.type, 'text');
  assert.ok(Array.from(text.text).length <= WHATSAPP_LIMITS.textBody);
  assert.equal(buttons.type, 'buttons');
  assert.deepEqual(buttons.buttons, [
    { id: 'faq:answer|book', title: 'Agendar' },
    { id: 'menu:main|show', title: 'Voltar ao menu' },
    { id: 'menu:main|human', title: 'Falar com a equipe' },
  ]);
  for (const button of buttons.buttons) {
    assert.ok(Array.from(button.title).length <= WHATSAPP_LIMITS.buttonTitle);
  }
  assert.deepEqual(result.events, [{ stepKey: `faq:${topic}` }]);
  assert.equal(result.next, null);
  assert.deepEqual(normalizeReplies(result.replies), result.replies);
  return text.text;
}

test('faq: formatBRL em pt-BR', () => {
  assert.equal(formatBRL(120), 'R$ 120,00');
  assert.equal(formatBRL(120.5), 'R$ 120,50');
  assert.equal(formatBRL(1234.5), 'R$ 1.234,50');
});

test('faq: serviços e valores', async () => {
  const result = await faqFlow.start(ctxOf({ state: { flow: 'faq', step: 'services', context: {} } }));
  assert.equal(assertAnswerShape(result, 'services'), [
    'Nossos serviços e valores:',
    '',
    '*Pilates*',
    '60 min por sessão · 4 vagas por horário',
    'Profissionais: Marina',
    'mensalidade: R$ 280,00',
    'Turmas pequenas.',
    '',
    '*Fisioterapia*',
    '60 min por sessão · 1 vaga por horário',
    'Profissionais: Paulo, Lia e Caio',
    'avulso (por sessão): R$ 120,50',
    'pacote: R$ 1.000,00',
  ].join('\n'));
});

test('faq: convênios', async () => {
  const result = await faqFlow.start(ctxOf({ state: { step: 'insurance' } }));
  assert.equal(assertAnswerShape(result, 'insurance'), [
    'Convênios aceitos: Convênio A e Convênio B.',
    'Cobrem Fisioterapia ambulatorial, RPG e Fisioterapia pélvica. Pilates é por mensalidade e Massagem é só particular.',
    '',
    'Formas de pagamento:',
    'PIX e cartão.',
  ].join('\n'));
});

test('faq: horários, feriados dos próximos 30 dias e endereço', async () => {
  const catalog = fakeCatalog();
  const result = await faqFlow.start(ctxOf({ state: { step: 'hours_address' }, repos: { catalog } }));
  assert.deepEqual(catalog.calls.holidays, [{ from: '2026-11-18', to: '2026-12-18' }]);
  assert.equal(assertAnswerShape(result, 'hours_address'), [
    'Horários de atendimento:',
    'seg a sex: horários das 8h às 17h',
    'sáb: horários das 8h às 12h',
    '',
    'Feriados nos próximos 30 dias (não atendemos):',
    '08/12 (terça-feira)',
    '',
    'Endereço:',
    'Rua das Acácias, 123.',
  ].join('\n'));
});

test('faq: sem feriados e fuso de Salvador na virada do dia', async () => {
  const catalog = fakeCatalog({ async listHolidays(range) { catalog.calls.holidays.push(range); return []; } });
  const result = await faqFlow.start(ctxOf({
    now: new Date('2026-11-19T01:30:00Z'), state: { step: 'hours_address' }, repos: { catalog },
  }));
  assert.deepEqual(catalog.calls.holidays, [{ from: '2026-11-18', to: '2026-12-18' }]);
  assert.match(result.replies[0].text, /Não há feriados nos próximos 30 dias\./);
});

test('faq: primeira consulta', async () => {
  const result = await faqFlow.start(ctxOf({ state: { step: 'first_visit' } }));
  assert.equal(assertAnswerShape(result, 'first_visit'), [
    '*Primeira consulta*', 'Dura 60 minutos.', '',
    '*O que levar*', 'Documento com foto.', '',
    '*Cancelamento e remarcação*', 'Até 24 horas antes.',
  ].join('\n'));
});

test('faq: dados ausentes viram aviso, sem inventar', async () => {
  const catalog = fakeCatalog({
    async listFaqEntries() { return []; },
    async getOpeningHours() { return []; },
    async listInsurancePlans() { return []; },
  });
  const ctx = ctxOf({ repos: { catalog } });
  assert.match((await faqFlow.start({ ...ctx, state: { step: 'first_visit' } })).replies[0].text, /Não tenho essa informação/);
  assert.match((await faqFlow.start({ ...ctx, state: { step: 'insurance' } })).replies[0].text, /Não tenho essa informação/);
  const hours = (await faqFlow.start({ ...ctx, state: { step: 'hours_address' } })).replies[0].text;
  assert.match(hours, /Horários de atendimento: Não tenho/);
  assert.match(hours, /Endereço: Não tenho/);
});

test('faq: intenções de texto livre vão direto à resposta', async () => {
  for (const [intent, topic] of [['prices', 'services'], ['insurance', 'insurance'], ['address', 'hours_address'], ['hours', 'hours_address']]) {
    const viaStart = await faqFlow.start(ctxOf(), textInput('x', intent));
    assert.deepEqual(viaStart.events, [{ stepKey: `faq:${topic}` }]);
    const viaHandle = await faqFlow.handle(ctxOf({ state: { flow: 'faq', step: 'x' } }), textInput('x', intent));
    assert.deepEqual(viaHandle.events, [{ stepKey: `faq:${topic}` }]);
  }
});

test('faq: botão Agendar vai para o booking; outra entrada volta ao menu', async () => {
  const book = await faqFlow.handle(ctxOf(), listInput('faq:answer|book'));
  assert.deepEqual(book.next, { flow: 'booking', step: 'choose_service', context: {} });
  const other = await faqFlow.handle(ctxOf(), textInput('hmm'));
  assert.equal(other.replies[0].type, 'list');
  assert.equal(other.misunderstood, true);
  assert.deepEqual(other.next, { flow: 'menu', step: 'main', context: {} });
  const noTopic = await faqFlow.start(ctxOf());
  assert.equal(noTopic.replies[0].type, 'list');
});
