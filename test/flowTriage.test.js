import assert from 'node:assert/strict';
import test from 'node:test';

import { triageFlow } from '../src/services/bot/flows/triage.js';

const NEW_CPF = '52998224725';
const EXISTING_CPF = '11144477735';

function makeRepos({ leadFails = false } = {}) {
  const calls = { leads: [], created: [], linked: [] };
  const catalog = {
    async listServices() {
      return [
        { id: 1, name: 'Fisioterapia' },
        { id: 2, name: 'Pilates' },
        { id: 3, name: 'Massagem' },
      ];
    },
    async listInsurancePlans() {
      return [{ id: 7, name: 'Plano Saúde X' }];
    },
  };
  const patients = {
    async upsertLead(args) {
      calls.leads.push(args);
      if (leadFails) throw new Error('db down');
      return { leadId: 55 };
    },
    async findPatientByCpf(cpf) {
      return cpf === EXISTING_CPF ? { id: 9, firstName: 'Ana' } : null;
    },
    async createPatient(args) {
      calls.created.push(args);
      return { id: 21 };
    },
    async linkContact(args) {
      calls.linked.push(args);
      return {};
    },
  };
  return { repos: { catalog, appointments: {}, patients }, calls };
}

function makeCtx(repos, state, extra = {}) {
  return {
    waId: '5511999990000',
    now: new Date('2026-11-18T12:00:00Z'),
    config: { cpfMaxAttempts: 3 },
    state,
    patient: null,
    inBusinessHours: true,
    repos,
    ...extra,
  };
}

function pick(step, value) {
  return {
    kind: 'list_reply',
    text: 'x',
    replyId: `triage:${step}|${value}`,
    intent: null,
    reply: { flow: 'triage', step, value },
  };
}

function typed(value) {
  return { kind: 'text', text: value, replyId: null, intent: null, reply: null };
}

function stateOf(result, cpfAttempts = 0) {
  return { ...result.next, cpfAttempts };
}

test('caminho completo cadastra o paciente e segue para booking', async () => {
  const { repos, calls } = makeRepos();
  let r = await triageFlow.start(makeCtx(repos, null));
  assert.equal(r.next.step, 'choose_service');
  assert.equal(r.events[0].stepKey, 'triage:choose_service');

  r = await triageFlow.handle(makeCtx(repos, stateOf(r)), pick('service', '1'));
  assert.equal(r.next.step, 'choose_payment');
  assert.equal(r.next.context.serviceId, 1);
  const buttons = r.replies.at(-1).buttons.map((b) => b.id);
  assert.deepEqual(buttons, ['triage:payment|convenio', 'triage:payment|avulso', 'triage:payment|pacote']);

  r = await triageFlow.handle(makeCtx(repos, stateOf(r)), pick('payment', 'convenio'));
  assert.equal(r.next.step, 'choose_insurance');
  r = await triageFlow.handle(makeCtx(repos, stateOf(r)), pick('insurance', '7'));
  assert.equal(r.next.step, 'ask_origin');
  assert.deepEqual(r.next.context.payment, { method: 'Convênio', insuranceId: 7 });

  r = await triageFlow.handle(makeCtx(repos, stateOf(r)), pick('origin', 'medico'));
  assert.equal(r.next.step, 'ask_name');
  assert.equal(r.next.context.channel, 'Médico');

  r = await triageFlow.handle(makeCtx(repos, stateOf(r)), typed('  Maria   da Silva '));
  assert.equal(r.next.step, 'ask_cpf');
  assert.equal(r.next.context.name, 'Maria da Silva');
  assert.equal(r.next.cpfAttempts, 0);

  r = await triageFlow.handle(makeCtx(repos, stateOf(r)), typed('529.982.247-25'));
  assert.equal(r.next.flow, 'booking');
  assert.equal(r.next.step, 'choose_day');
  assert.deepEqual(r.next.context, {
    serviceId: 1,
    payment: { method: 'Convênio', insuranceId: 7 },
    patient: { id: 21, firstName: 'Maria' },
    newPatient: true,
  });
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].cpf, NEW_CPF);
  assert.equal(calls.created[0].name, 'Maria da Silva');
  assert.equal(calls.created[0].channel, 'Médico');
  assert.equal(calls.created[0].leadId, 55);
  assert.deepEqual(calls.linked.at(-1), { waId: '5511999990000', patientId: 21, leadId: 55 });
  assert.ok(calls.leads.length >= 5);
  assert.ok(calls.leads.every((l) => l.outsideBusinessHours === false));
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes(NEW_CPF));
  assert.ok(!serialized.includes('Maria da Silva'));
});

test('fora do horário marca o lead e falha de lead é tolerada', async () => {
  const { repos, calls } = makeRepos({ leadFails: true });
  const r = await triageFlow.start(makeCtx(repos, null, { inBusinessHours: false }));
  assert.equal(r.next.step, 'choose_service');
  assert.equal(calls.leads[0].outsideBusinessHours, true);
});

test('nome vazio, curto, com números ou longo é recusado', async () => {
  const { repos, calls } = makeRepos();
  const state = { flow: 'triage', step: 'ask_name', context: { serviceId: 1, channel: 'Outro' } };
  for (const bad of ['   ', 'A', 'Maria 123', 'x'.repeat(81), '@@@']) {
    const r = await triageFlow.handle(makeCtx(repos, state), typed(bad));
    assert.equal(r.next.step, 'ask_name', bad);
    assert.equal(r.misunderstood, true);
    assert.equal(r.next.context.name, undefined);
  }
  const r = await triageFlow.handle(makeCtx(repos, state), { kind: 'list_reply', text: 'x', reply: null });
  assert.equal(r.next.step, 'ask_name');
  assert.equal(calls.created.length, 0);
});

test('CPF inválido pede de novo e no limite abre handoff identity_failure', async () => {
  const { repos, calls } = makeRepos();
  const context = { serviceId: 1, name: 'Maria Souza' };
  let r = await triageFlow.handle(
    makeCtx(repos, { flow: 'triage', step: 'ask_cpf', context, cpfAttempts: 0 }),
    typed('123.456.789-00'),
  );
  assert.equal(r.next.step, 'ask_cpf');
  assert.equal(r.next.cpfAttempts, 1);
  r = await triageFlow.handle(
    makeCtx(repos, { flow: 'triage', step: 'ask_cpf', context, cpfAttempts: 1 }),
    typed('abc'),
  );
  assert.equal(r.next.cpfAttempts, 2);
  r = await triageFlow.handle(
    makeCtx(repos, { flow: 'triage', step: 'ask_cpf', context, cpfAttempts: 2 }),
    typed('11111111111'),
  );
  assert.deepEqual(r.handoff, { reason: 'identity_failure' });
  assert.equal(r.next, null);
  assert.equal(calls.created.length, 0);
});

test('CPF já cadastrado vira paciente existente, com a mesma resposta neutra', async () => {
  const { repos, calls } = makeRepos();
  const context = { serviceId: 1, payment: { method: 'Particular avulso', insuranceId: null }, name: 'Qualquer Nome', leadId: 55 };
  const r = await triageFlow.handle(
    makeCtx(repos, { flow: 'triage', step: 'ask_cpf', context, cpfAttempts: 0 }),
    typed(EXISTING_CPF),
  );
  assert.equal(calls.created.length, 0);
  assert.deepEqual(calls.linked.at(-1), { waId: '5511999990000', patientId: 9, leadId: 55 });
  assert.deepEqual(r.next.context.patient, { id: 9, firstName: 'Ana' });
  assert.equal(r.next.context.name, undefined);
  assert.ok(!JSON.stringify(r.replies).includes('Ana'));

  const fresh = await triageFlow.handle(
    makeCtx(repos, { flow: 'triage', step: 'ask_cpf', context, cpfAttempts: 0 }),
    typed(NEW_CPF),
  );
  assert.deepEqual(r.replies, fresh.replies);
});

test('corrida de cadastro (cpf_exists) usa o paciente existente', async () => {
  const { repos } = makeRepos();
  let looked = 0;
  repos.patients.findPatientByCpf = async () => (looked++ === 0 ? null : { id: 4, firstName: 'Davi' });
  repos.patients.createPatient = async () => {
    const error = new Error('exists');
    error.code = 'cpf_exists';
    throw error;
  };
  const r = await triageFlow.handle(
    makeCtx(repos, { flow: 'triage', step: 'ask_cpf', context: { serviceId: 1, name: 'Davi X' }, cpfAttempts: 0 }),
    typed(NEW_CPF),
  );
  assert.deepEqual(r.next.context.patient, { id: 4, firstName: 'Davi' });
});

test('Pilates só oferece Mensalidade e Massagem só Particular avulso', async () => {
  const { repos } = makeRepos();
  for (const [serviceId, method] of [['2', 'Mensalidade'], ['3', 'Particular avulso']]) {
    const state = { flow: 'triage', step: 'choose_service', context: {} };
    const r = await triageFlow.handle(makeCtx(repos, state), pick('service', serviceId));
    assert.equal(r.next.step, 'ask_origin');
    assert.deepEqual(r.next.context.payment, { method, insuranceId: null });
  }
  // Opção fora das permitidas é recusada.
  const state = { flow: 'triage', step: 'choose_payment', context: { serviceId: 1 } };
  const ok = await triageFlow.handle(makeCtx(repos, state), pick('payment', 'mensalidade'));
  assert.equal(ok.next.step, 'choose_payment');
  assert.equal(ok.misunderstood, true);
});

test('serviceId pré-definido pula choose_service', async () => {
  const { repos } = makeRepos();
  const r = await triageFlow.start(makeCtx(repos, {
    flow: 'triage', step: 'choose_service', context: { serviceId: 1 },
  }));
  assert.equal(r.next.step, 'choose_payment');
  assert.equal(r.next.context.serviceId, 1);

  const pilates = await triageFlow.start(makeCtx(repos, {
    flow: 'triage', step: 'choose_service', context: { serviceId: 2 },
  }));
  assert.equal(pilates.next.step, 'ask_origin');
});

test('texto com sintomas não é tratado como dado, repete a pergunta e não faz handoff', async () => {
  const { repos, calls } = makeRepos();
  let r = await triageFlow.handle(
    makeCtx(repos, { flow: 'triage', step: 'ask_name', context: { serviceId: 1 } }),
    typed('estou com muita dor no joelho'),
  );
  assert.equal(r.next.step, 'ask_name');
  assert.equal(r.handoff, undefined);
  assert.equal(r.next.context.name, undefined);
  assert.match(r.replies[0].text, /avaliação/);

  r = await triageFlow.handle(
    makeCtx(repos, { flow: 'triage', step: 'choose_payment', context: { serviceId: 1 } }),
    typed('tenho formigamento na mão'),
  );
  assert.equal(r.next.step, 'choose_payment');
  assert.match(r.replies[0].text, /avaliação/);
  assert.equal(calls.created.length, 0);
});

test('o fluxo expõe name, start e handle', () => {
  assert.equal(triageFlow.name, 'triage');
  assert.equal(typeof triageFlow.start, 'function');
  assert.equal(typeof triageFlow.handle, 'function');
});
