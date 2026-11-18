import assert from 'node:assert/strict';
import test from 'node:test';
import { createPatientRepository, LEAD_STAGES } from '../src/services/clinic/patientRepository.js';

function createFakePool(handler = () => undefined) {
  const calls = [];
  const run = async (text, values = []) => {
    calls.push({ text, values });
    return handler(text, values) ?? { rows: [] };
  };
  const client = { query: run, release() { calls.push({ text: 'release', values: [] }); } };
  return { calls, query: run, connect: async () => client };
}

const CPF = '80590844296';
const NAME = 'Maria Segredo Silva';
const clock = () => new Date('2026-11-18T02:30:00Z'); // 23:30 de 17/11 na Bahia

const find = (pool, re) => pool.calls.find((c) => re.test(c.text));

test('findPatientByCpf compares only digits and returns id and first name', async () => {
  const pool = createFakePool(() => ({ rows: [{ paciente_id: '2680', first_name: 'Demo' }] }));
  const repo = createPatientRepository({ pool });
  assert.deepEqual(await repo.findPatientByCpf('805.908.442-96'), { id: 2680, firstName: 'Demo' });
  assert.deepEqual(pool.calls[0].values, [CPF]);
  assert.equal(await repo.findPatientByCpf('123'), null);
  assert.equal(pool.calls.length, 1);
});

test('findPatientByCpf returns null when nothing matches', async () => {
  const repo = createPatientRepository({ pool: createFakePool() });
  assert.equal(await repo.findPatientByCpf(CPF), null);
});

test('createPatient stores digits, Bahia date, links the lead and commits', async () => {
  const pool = createFakePool((text) => {
    if (/from clinica_simulada.jornada_contatos/.test(text)) return { rows: [{ lead_id: '77' }] };
    if (/insert into clinica_simulada.d_pacientes/.test(text)) return { rows: [{ paciente_id: '9001' }] };
    return undefined;
  });
  const repo = createPatientRepository({ pool, clock });
  const result = await repo.createPatient({
    name: NAME, cpf: '805.908.442-96', origin: 'Novo (lead)', channel: 'Instagram', waId: '5571',
  });
  assert.deepEqual(result, { id: 9001 });
  assert.deepEqual(find(pool, /insert into clinica_simulada.d_pacientes/).values,
    [NAME, '2026-11-17', 'Novo (lead)', 'Instagram', CPF, '77']);
  assert.ok(find(pool, /update clinica_simulada.f_leads/));
  assert.equal(pool.calls[0].text, 'begin');
  assert.ok(find(pool, /^commit$/));
});

test('createPatient reports a duplicate CPF without leaking it and rolls back', async () => {
  const pool = createFakePool();
  const repo = createPatientRepository({ pool });
  await assert.rejects(repo.createPatient({ name: NAME, cpf: CPF }), (error) => {
    assert.equal(error.code, 'cpf_exists');
    assert.ok(!error.message.includes(CPF));
    return true;
  });
  assert.ok(find(pool, /^rollback$/));
});

test('linkContact reuses the open conversation and upserts jornada_contatos', async () => {
  const pool = createFakePool((text) => (
    /select id from clinica_simulada.conversations/.test(text) ? { rows: [{ id: 'conv-1' }] } : undefined));
  const repo = createPatientRepository({ pool });
  const result = await repo.linkContact({ waId: '5571', patientId: 5, leadId: 7 });
  assert.equal(result.conversationId, 'conv-1');
  assert.deepEqual(find(pool, /insert into clinica_simulada.jornada_contatos/).values,
    ['5571', 7, 5, 'conv-1']);
  assert.ok(!find(pool, /insert into clinica_simulada.conversations/));
  assert.ok(find(pool, /insert into clinica_simulada.contacts/));
});

test('linkContact creates a conversation when none is open and keeps the journey one', async () => {
  const pool = createFakePool((text) => {
    if (/insert into clinica_simulada.conversations/.test(text)) return { rows: [{ id: 'conv-new' }] };
    if (/for update/.test(text)) return { rows: [{ conversation_id: 'conv-old', lead_id: null }] };
    return undefined;
  });
  const repo = createPatientRepository({ pool });
  const result = await repo.linkContact({ waId: '5571', patientId: 5 });
  assert.equal(result.conversationId, 'conv-old');
  assert.deepEqual(find(pool, /insert into clinica_simulada.jornada_contatos/).values,
    ['5571', null, 5, 'conv-old']);
});

test('upsertLead creates the lead with exact stage, Bahia date/hour and identification', async () => {
  const pool = createFakePool((text) => {
    if (/select id from clinica_simulada.conversations/.test(text)) return { rows: [{ id: 'c' }] };
    if (/insert into clinica_simulada.f_leads/.test(text)) return { rows: [{ lead_id: '321' }] };
    return undefined;
  });
  const repo = createPatientRepository({ pool, clock });
  const result = await repo.upsertLead({
    waId: '5571', stage: 'service', channel: 'Instagram', outsideBusinessHours: true,
  });
  assert.deepEqual(result, { leadId: 321 });
  assert.deepEqual(find(pool, /insert into clinica_simulada.f_leads/).values, [
    '2026-11-17', 23, 'Instagram', 'Declarada pelo paciente', null,
    'Sim', 'Abandonou na escolha do serviço', 'Não', 'Não', 'Não', null,
  ]);
  assert.deepEqual(find(pool, /insert into clinica_simulada.jornada_contatos/).values,
    ['5571', 321, null, 'c']);
});

test('upsertLead updates the existing lead and derives flags from the final stage', async () => {
  const pool = createFakePool((text) => {
    if (/select id from clinica_simulada.conversations/.test(text)) return { rows: [{ id: 'c' }] };
    if (/for update/.test(text)) return { rows: [{ conversation_id: 'c', lead_id: '55', paciente_id: '9' }] };
    return undefined;
  });
  const repo = createPatientRepository({ pool, clock });
  const result = await repo.upsertLead({ waId: '5571', stage: LEAD_STAGES.booked, patientId: 9 });
  assert.deepEqual(result, { leadId: 55 });
  assert.deepEqual(find(pool, /update clinica_simulada.f_leads set/).values,
    ['55', 'Agendou pelo chatbot', null, null, null, null, 'Sim', 9]);
  assert.ok(!find(pool, /insert into clinica_simulada.f_leads/));
});

test('upsertLead rejects unknown stages', async () => {
  const repo = createPatientRepository({ pool: createFakePool() });
  await assert.rejects(repo.upsertLead({ waId: '1', stage: 'qualquer' }), { code: 'invalid_stage' });
});

test('no logger call receives the CPF or the name', async () => {
  const logged = [];
  const sink = (...args) => logged.push(JSON.stringify(args));
  const logger = { info: sink, warn: sink, error: sink, debug: sink };
  const failing = createFakePool((text) => {
    if (/insert into clinica_simulada.d_pacientes/.test(text)) {
      throw Object.assign(new Error('boom'), { code: '23505' });
    }
    return undefined;
  });
  const repo = createPatientRepository({ pool: failing, logger, clock });
  await assert.rejects(repo.createPatient({ name: NAME, cpf: CPF }));
  await repo.findPatientByCpf(CPF);
  assert.ok(logged.length > 0);
  const text = logged.join(' ');
  assert.ok(!text.includes(CPF));
  assert.ok(!text.includes('Maria'));
});
