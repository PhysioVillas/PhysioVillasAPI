import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAppointmentRepository,
  shiftForHour,
} from '../src/services/clinic/appointmentRepository.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');

function tagOf(query) {
  const text = typeof query === 'string' ? query : query.text;
  const match = /\/\* t10:(\w+) \*\//.exec(text);
  return match ? match[1] : text.trim().toLowerCase();
}

// Banco falso em memoria para as consultas transacionais. A trava consultiva
// e simulada com uma fila: quem chega depois espera o commit/rollback de quem
// segura a mesma chave, como pg_advisory_xact_lock.
function createFakeDb({
  slot = { vagas: 1, ocupados: 0, dia_semana: 'Segunda', feriado: false, futuro: true },
  appointments = [],
  openConversation = null,
  failOn = null,
} = {}) {
  const state = {
    slot: { ...slot },
    appointments: appointments.map((row) => ({ ...row })),
    openConversation,
    nextId: 30400,
    nextConversation: 1,
    calls: [],
    events: [],
    released: 0,
  };
  const locks = new Map();

  async function acquire(key, owner) {
    while (locks.has(key) && locks.get(key).owner !== owner) {
      await locks.get(key).released;
    }
    if (!locks.has(key)) {
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      locks.set(key, { owner, released, release });
    }
  }

  function releaseAll(owner) {
    for (const [key, lock] of locks) {
      if (lock.owner === owner) {
        locks.delete(key);
        lock.release();
      }
    }
  }

  let clientSeq = 0;

  const pool = {
    state,
    query: async (query) => {
      state.calls.push({ client: 'pool', tag: tagOf(query), values: query.values });
      return { rows: [] };
    },
    connect: async () => {
      const owner = ++clientSeq;
      return {
        release: () => { state.released += 1; },
        query: async (query) => {
          const tag = tagOf(query);
          const values = query.values ?? [];
          state.calls.push({ client: owner, tag, values });
          if (failOn === tag) {
            throw new Error(`boom at ${tag}`);
          }
          switch (tag) {
            case 'begin':
              return { rows: [] };
            case 'commit':
            case 'rollback':
              state.events.push(`${owner}:${tag}`);
              releaseAll(owner);
              return { rows: [] };
            case 'lock':
              await acquire(values[0], owner);
              state.events.push(`${owner}:locked:${values[0]}`);
              return { rows: [{}] };
            case 'slot_check':
              // devolve uma copia do estado atual: o insert so muda depois
              await new Promise((resolve) => setImmediate(resolve));
              return { rows: state.slot ? [{ ...state.slot }] : [] };
            case 'insert_appointment': {
              const id = state.nextId++;
              state.slot.ocupados += 1;
              state.events.push(`${owner}:insert:${id}`);
              return {
                rows: [{
                  agendamento_id: String(id),
                  paciente_id: String(values[0]),
                  servico_id: String(values[2]),
                  profissional_id: String(values[3]),
                  data: values[6],
                  hora: String(values[7]),
                  status: 'Agendado',
                  forma_pagamento: values[4],
                  convenio_id: values[5] === null ? null : String(values[5]),
                  valor_sessao: values[13] ?? '120.00',
                  primeira_consulta: values[12] ?? 'Sim',
                  remarcacao_de: values[11] === null ? null : String(values[11]),
                }],
              };
            }
            case 'find_owned': {
              const [id, patientId] = values;
              const row = state.appointments.find((a) => Number(a.agendamento_id) === id
                && Number(a.paciente_id) === patientId && a.status === 'Agendado');
              return { rows: row ? [{ ...row }] : [] };
            }
            case 'cancel_appointment': {
              const row = state.appointments.find((a) => a.agendamento_id === values[0]);
              row.status = 'Cancelado com antecedência';
              return { rows: [{ ...row }] };
            }
            case 'open_conversation':
              return { rows: state.openConversation ? [{ ...state.openConversation }] : [] };
            case 'close_conversation':
              state.openConversation = null;
              return { rows: [] };
            case 'insert_conversation': {
              const id = `conv-new-${state.nextConversation++}`;
              state.openConversation = { id, tem_agendamento: false };
              return { rows: [{ id }] };
            }
            case 'insert_chatbot':
              if (state.openConversation?.id === values[2]) {
                state.openConversation.tem_agendamento = true;
              }
              return { rows: [] };
            default:
              return { rows: [] };
          }
        },
      };
    },
  };
  return pool;
}

const tags = (pool, client) => pool.state.calls
  .filter((call) => client === undefined || call.client === client)
  .map((call) => call.tag);

function originalAppointment(overrides = {}) {
  return {
    agendamento_id: '30100',
    paciente_id: '2680',
    contrato_id: null,
    servico_id: '2',
    profissional_id: '7',
    data: '2026-11-25',
    hora: '9',
    status: 'Agendado',
    forma_pagamento: 'Convênio',
    convenio_id: '3',
    valor_sessao: '42.0000',
    primeira_consulta: 'Não',
    numero_sessao: '4',
    remarcacao_de: null,
    starts_at: new Date('2026-11-25T12:00:00.000Z'),
    horas_ate: '168',
    ...overrides,
  };
}

const BOOKING = {
  patientId: 2680,
  waId: '5571999990000',
  serviceId: 2,
  professionalId: 7,
  date: '2026-11-23',
  hour: 9,
};

test('shiftForHour follows the observed Manhã/Tarde/Noite split', () => {
  assert.equal(shiftForHour(6), 'Manhã');
  assert.equal(shiftForHour(11), 'Manhã');
  assert.equal(shiftForHour(12), 'Tarde');
  assert.equal(shiftForHour(17), 'Tarde');
  assert.equal(shiftForHour(18), 'Noite');
});

test('requires a pool with query and connect', () => {
  assert.throws(() => createAppointmentRepository({ pool: { query() {} } }), TypeError);
});

test('listAvailableDays passes the injected clock, timezone and horizon and maps rows', async () => {
  const calls = [];
  const pool = {
    connect() {},
    query: async (query) => {
      calls.push(query);
      return { rows: [{ data: '2026-11-19', livres: '5' }, { data: '2026-11-23', livres: 12 }] };
    },
  };
  const repo = createAppointmentRepository({ pool, clock: () => NOW });
  const days = await repo.listAvailableDays({ serviceId: 2, from: '2026-11-18', horizonDays: 14 });

  assert.deepEqual(days, [{ date: '2026-11-19', freeSlots: 5 }, { date: '2026-11-23', freeSlots: 12 }]);
  assert.deepEqual(calls[0].values, [NOW, 'America/Bahia', 2, null, '2026-11-18', 14]);
  const sql = calls[0].text;
  assert.match(sql, /status in \('Agendado', 'Realizado'\)/);
  assert.match(sql, /feriado, 'Não'\) <> 'Sim'/);
  assert.match(sql, /l\.today \+ \$6::int/);
  assert.match(sql, /> l\.local_now/);
});

test('listAvailableTimes maps professionals and remaining slots', async () => {
  const calls = [];
  const pool = {
    connect() {},
    query: async (query) => {
      calls.push(query);
      return { rows: [{ hora: '8', profissional_id: '7', profissional: 'Prof. X', restantes: 3 }] };
    },
  };
  const repo = createAppointmentRepository({ pool, clock: () => NOW });
  const times = await repo.listAvailableTimes({ serviceId: 2, professionalId: 7, date: '2026-11-23' });

  assert.deepEqual(times, [{ hour: 8, professionalId: 7, professionalName: 'Prof. X', remaining: 3 }]);
  assert.deepEqual(calls[0].values, [NOW, 'America/Bahia', 2, 7, '2026-11-23', 21]);
  await assert.rejects(() => repo.listAvailableTimes({ serviceId: 2, date: '23/11/2026' }), TypeError);
});

test('listUpcoming only asks for future Agendado rows of the patient', async () => {
  const calls = [];
  const pool = {
    connect() {},
    query: async (query) => {
      calls.push(query);
      return { rows: [originalAppointment({ servico: 'Fisioterapia ambulatorial', profissional: 'Prof. X' })] };
    },
  };
  const repo = createAppointmentRepository({ pool, clock: () => NOW });
  const [item] = await repo.listUpcoming({ patientId: 2680 });

  assert.match(calls[0].text, /a\.paciente_id = \$1/);
  assert.match(calls[0].text, /a\.status = 'Agendado'/);
  assert.deepEqual(calls[0].values, [2680, NOW, 'America/Bahia']);
  assert.equal(item.id, 30100);
  assert.equal(item.serviceName, 'Fisioterapia ambulatorial');
  assert.equal(item.date, '2026-11-25');
  assert.equal(item.hour, 9);
  assert.equal(item.firstVisit, false);
});

test('book locks the slot, re-checks capacity, inserts, links a conversation and audits', async () => {
  const pool = createFakeDb();
  const repo = createAppointmentRepository({ pool, clock: () => NOW });

  const result = await repo.book({ ...BOOKING, paymentMethod: 'Particular avulso' });

  assert.equal(result.ok, true);
  assert.equal(result.appointment.id, 30400);
  assert.equal(result.appointment.status, 'Agendado');
  assert.equal(result.appointment.conversationId, 'conv-new-1');
  assert.deepEqual(tags(pool), [
    'begin', 'lock', 'slot_check', 'insert_appointment',
    'lock', 'upsert_contact', 'open_conversation', 'insert_conversation',
    'insert_chatbot', 'audit', 'commit',
  ]);

  const calls = pool.state.calls;
  assert.equal(calls[1].values[0], 'clinica_simulada:slot:2:7:2026-11-23:9');
  const insert = calls.find((c) => c.tag === 'insert_appointment').values;
  assert.equal(insert[4], 'Particular avulso');
  assert.equal(insert[5], null); // sem convenio fora de Convênio
  assert.equal(insert[8], 'Segunda'); // dia_semana do calendario
  assert.equal(insert[9], 'Manhã');
  assert.equal(insert[12], null); // primeira_consulta calculada no SQL
  assert.deepEqual(insert.slice(14), [NOW, 'America/Bahia']);

  const link = calls.find((c) => c.tag === 'insert_chatbot').values;
  assert.deepEqual(link, ['30400', '5571999990000', 'conv-new-1']);
  const audit = calls.find((c) => c.tag === 'audit').values;
  assert.deepEqual(audit, ['30400', 'booked', NOW]);
  assert.equal(pool.state.released, 1);
});

test('book SQL writes the plan 6.3 fields and audit with actor_scope chatbot', async () => {
  const seen = [];
  const pool = createFakeDb();
  const original = pool.connect;
  pool.connect = async () => {
    const client = await original();
    const query = client.query;
    client.query = (q) => { seen.push(typeof q === 'string' ? q : q.text); return query(q); };
    return client;
  };
  await createAppointmentRepository({ pool, clock: () => NOW }).book(BOOKING);
  const insert = seen.find((text) => text.includes('t10:insert_appointment'));
  assert.match(insert, /'Chatbot', 'Agendado'/);
  assert.match(insert, /\$7::date - l\.today/);
  assert.match(insert, /clinica_simulada\.d_precos/);
  const audit = seen.find((text) => text.includes('t10:audit'));
  assert.match(audit, /clinica_simulada\.audit_log/);
  assert.match(audit, /'chatbot'/);
  assert.match(audit, /lpad\(to_hex\(\$1::bigint\), 32, '0'\)::uuid/);
  const link = seen.find((text) => text.includes('t10:insert_chatbot'));
  assert.match(link, /dispatch_id[\s\S]*null/);
});

test('book returns slot_unavailable and rolls back when the slot is full, holiday or past', async () => {
  for (const slot of [
    { vagas: 2, ocupados: 2, dia_semana: 'Segunda', feriado: false, futuro: true },
    { vagas: 2, ocupados: 0, dia_semana: 'Sexta', feriado: true, futuro: true },
    { vagas: 2, ocupados: 0, dia_semana: 'Segunda', feriado: false, futuro: false },
    null,
  ]) {
    const pool = createFakeDb({ slot });
    const result = await createAppointmentRepository({ pool, clock: () => NOW }).book(BOOKING);
    assert.deepEqual(result, { ok: false, reason: 'slot_unavailable' });
    assert.deepEqual(tags(pool), ['begin', 'lock', 'slot_check', 'rollback']);
  }
});

test('race: two bookings on the last slot are serialized by the lock; only one wins', async () => {
  const pool = createFakeDb({ slot: { vagas: 3, ocupados: 2, dia_semana: 'Segunda', feriado: false, futuro: true } });
  const repo = createAppointmentRepository({ pool, clock: () => NOW });

  const [first, second] = await Promise.all([
    repo.book({ ...BOOKING, patientId: 2680, waId: 'wa-a' }),
    repo.book({ ...BOOKING, patientId: 2681, waId: 'wa-b' }),
  ]);

  const outcomes = [first, second].map((r) => (r.ok ? 'ok' : r.reason)).sort();
  assert.deepEqual(outcomes, ['ok', 'slot_unavailable']);
  assert.equal(pool.state.slot.ocupados, 3);
  assert.equal(tags(pool).filter((t) => t === 'insert_appointment').length, 1);

  // A segunda transacao so pega a trava depois do commit da primeira.
  const events = pool.state.events;
  const firstCommit = events.findIndex((e) => e.endsWith(':commit'));
  const slotLocks = events
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.includes(':locked:clinica_simulada:slot:'));
  assert.equal(slotLocks.length, 2);
  assert.ok(slotLocks[1].index > firstCommit);
  assert.equal(pool.state.released, 2);
});

test('book reuses the open conversation when it has no agendamento_chatbot row', async () => {
  const pool = createFakeDb({ openConversation: { id: 'conv-open', tem_agendamento: false } });
  const result = await createAppointmentRepository({ pool, clock: () => NOW }).book(BOOKING);

  assert.equal(result.appointment.conversationId, 'conv-open');
  const t = tags(pool);
  assert.ok(t.includes('touch_conversation'));
  assert.ok(!t.includes('insert_conversation'));
  assert.ok(!t.includes('close_conversation'));
});

test('book closes an open conversation that already backs a booking and opens a new one', async () => {
  const pool = createFakeDb({ openConversation: { id: 'conv-used', tem_agendamento: true } });
  const result = await createAppointmentRepository({ pool, clock: () => NOW }).book(BOOKING);

  assert.equal(result.appointment.conversationId, 'conv-new-1');
  const closeCall = pool.state.calls.find((c) => c.tag === 'close_conversation');
  assert.deepEqual(closeCall.values, ['conv-used', NOW]);
  const t = tags(pool);
  assert.ok(t.indexOf('close_conversation') < t.indexOf('insert_conversation'));
});

test('two consecutive bookings by the same contact never share a conversation', async () => {
  const pool = createFakeDb({ slot: { vagas: 5, ocupados: 0, dia_semana: 'Segunda', feriado: false, futuro: true } });
  const repo = createAppointmentRepository({ pool, clock: () => NOW });
  const first = await repo.book(BOOKING);
  const second = await repo.book({ ...BOOKING, hour: 10 });
  assert.notEqual(first.appointment.conversationId, second.appointment.conversationId);
});

test('book validates input before touching the database', async () => {
  const pool = createFakeDb();
  const repo = createAppointmentRepository({ pool, clock: () => NOW });
  await assert.rejects(() => repo.book({ ...BOOKING, waId: '' }), TypeError);
  await assert.rejects(() => repo.book({ ...BOOKING, paymentMethod: 'Pix' }), RangeError);
  await assert.rejects(() => repo.book({ ...BOOKING, paymentMethod: 'Convênio' }), TypeError);
  assert.equal(pool.state.calls.length, 0);
});

test('book rolls back and releases the client when a write fails', async () => {
  const pool = createFakeDb({ failOn: 'insert_chatbot' });
  await assert.rejects(
    () => createAppointmentRepository({ pool, clock: () => NOW }).book(BOOKING),
    /boom at insert_chatbot/,
  );
  const t = tags(pool);
  assert.equal(t.at(-1), 'rollback');
  assert.ok(!t.includes('commit'));
  assert.ok(!t.includes('audit'));
  assert.equal(pool.state.released, 1);
});

test('cancel marks Cancelado com antecedência and audits', async () => {
  const pool = createFakeDb({ appointments: [originalAppointment()] });
  const result = await createAppointmentRepository({ pool, clock: () => NOW })
    .cancel({ patientId: 2680, appointmentId: 30100 });

  assert.equal(result.ok, true);
  assert.equal(result.appointment.status, 'Cancelado com antecedência');
  assert.deepEqual(tags(pool), ['begin', 'find_owned', 'cancel_appointment', 'audit', 'commit']);
  assert.deepEqual(pool.state.calls[1].values, [30100, 2680, NOW, 'America/Bahia']);
  assert.deepEqual(pool.state.calls.find((c) => c.tag === 'audit').values, ['30100', 'cancelled', NOW]);
});

test('cancel of another patient appointment returns not_found without writing', async () => {
  const pool = createFakeDb({ appointments: [originalAppointment({ paciente_id: '2681' })] });
  const result = await createAppointmentRepository({ pool, clock: () => NOW })
    .cancel({ patientId: 2680, appointmentId: 30100 });

  assert.deepEqual(result, { ok: false, reason: 'not_found' });
  assert.deepEqual(tags(pool), ['begin', 'find_owned', 'rollback']);
});

test('cancel and reschedule return too_late inside minNoticeHours', async () => {
  for (const action of ['cancel', 'reschedule']) {
    const pool = createFakeDb({ appointments: [originalAppointment({ horas_ate: '23.5' })] });
    const repo = createAppointmentRepository({ pool, clock: () => NOW });
    const result = await repo[action]({
      patientId: 2680, appointmentId: 30100, waId: 'wa-a', date: '2026-11-27', hour: 10,
    });
    assert.deepEqual(result, { ok: false, reason: 'too_late' }, action);
    assert.deepEqual(tags(pool), ['begin', 'find_owned', 'rollback']);
  }

  // minNoticeHours configuravel: com 12 h, 23,5 h de antecedencia basta.
  const pool = createFakeDb({ appointments: [originalAppointment({ horas_ate: '23.5' })] });
  const result = await createAppointmentRepository({ pool, clock: () => NOW })
    .cancel({ patientId: 2680, appointmentId: 30100, minNoticeHours: 12 });
  assert.equal(result.ok, true);
});

test('reschedule creates a new row with remarcacao_de, cancels the original and audits both', async () => {
  const pool = createFakeDb({ appointments: [originalAppointment()] });
  const result = await createAppointmentRepository({ pool, clock: () => NOW }).reschedule({
    patientId: 2680, appointmentId: 30100, waId: 'wa-a', date: '2026-11-27', hour: 14,
  });

  assert.equal(result.ok, true);
  assert.equal(result.previous.id, 30100);
  assert.equal(result.previous.status, 'Cancelado com antecedência');
  assert.equal(result.appointment.rescheduledFrom, 30100);
  assert.deepEqual(tags(pool), [
    'begin', 'find_owned', 'lock', 'slot_check', 'cancel_appointment', 'insert_appointment',
    'lock', 'upsert_contact', 'open_conversation', 'insert_conversation', 'insert_chatbot',
    'audit', 'audit', 'commit',
  ]);
  const calls = pool.state.calls;
  assert.equal(calls[2].values[0], 'clinica_simulada:slot:2:7:2026-11-27:14');
  const insert = calls.find((c) => c.tag === 'insert_appointment').values;
  assert.equal(insert[4], 'Convênio');
  assert.equal(insert[5], '3');
  assert.equal(insert[9], 'Tarde');
  assert.equal(insert[11], '30100');
  assert.equal(insert[12], 'Não');
  assert.equal(insert[13], '42.0000');
  const audits = calls.filter((c) => c.tag === 'audit').map((c) => c.values[1]);
  assert.deepEqual(audits, ['rescheduled', 'booked']);
});

test('reschedule to a full slot returns slot_unavailable and keeps the original', async () => {
  const pool = createFakeDb({
    appointments: [originalAppointment()],
    slot: { vagas: 1, ocupados: 1, dia_semana: 'Sexta', feriado: false, futuro: true },
  });
  const result = await createAppointmentRepository({ pool, clock: () => NOW }).reschedule({
    patientId: 2680, appointmentId: 30100, waId: 'wa-a', date: '2026-11-27', hour: 14,
  });
  assert.deepEqual(result, { ok: false, reason: 'slot_unavailable' });
  assert.equal(pool.state.appointments[0].status, 'Agendado');
  assert.equal(tags(pool).at(-1), 'rollback');
});

test('reschedule of another patient appointment returns not_found', async () => {
  const pool = createFakeDb({ appointments: [originalAppointment({ paciente_id: '2681' })] });
  const result = await createAppointmentRepository({ pool, clock: () => NOW }).reschedule({
    patientId: 2680, appointmentId: 30100, waId: 'wa-a', date: '2026-11-27', hour: 14,
  });
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
});

test('ensureScheduleHorizon calls extend_schedule once per repository and retries after failure', async () => {
  let calls = 0;
  let fail = true;
  const pool = {
    connect() {},
    query: async (query) => {
      calls += 1;
      assert.match(query.text, /clinica_simulada\.extend_schedule\(\$1::int\)/);
      assert.deepEqual(query.values, [60]);
      if (fail) {
        fail = false;
        throw new Error('db down');
      }
      return { rows: [{ inserted: 42 }] };
    },
  };
  const repo = createAppointmentRepository({ pool });
  await assert.rejects(() => repo.ensureScheduleHorizon(60), /db down/);
  const [a, b] = await Promise.all([repo.ensureScheduleHorizon(60), repo.ensureScheduleHorizon(60)]);
  await repo.ensureScheduleHorizon(60);
  assert.deepEqual(a, { inserted: 42 });
  assert.equal(a, b);
  assert.equal(calls, 2);
});
