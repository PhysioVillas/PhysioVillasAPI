import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '../src/services/database.js';

const slot = {
  startsAt: '2026-12-01T17:00:00.000Z',
  endsAt: '2026-12-01T17:50:00.000Z',
};

function createAppointmentDatabase({ matches = [], duplicateEvents = [] } = {}) {
  const calls = [];
  const client = {
    async query(query) {
      calls.push(query);
      if (typeof query === 'string') return { rows: [] };
      if (query.text.includes('select 1 from appointment_events')) return { rows: duplicateEvents };
      if (query.text.includes('from appointment_requests where source_message_id')) return { rows: [] };
      if (query.text.includes('reporting.appointment_slot_capacity_metrics')) return { rows: [{ '?column?': 1 }] };
      if (query.text.includes('select a.id, a.appointment_request_id')) return { rows: matches };
      if (query.text.includes('returning id, appointment_request_id, starts_at, ends_at, status')) {
        return { rows: [{ ...matches[0], starts_at: '2026-12-02T18:00:00.000Z', ends_at: '2026-12-02T18:50:00.000Z' }] };
      }
      return { rows: [] };
    },
    release() { calls.push('release'); },
  };
  return {
    calls,
    database: createDatabase({ pool: { connect: async () => client } }),
  };
}

const match = {
  id: 'appointment-1',
  appointment_request_id: 'request-1',
  starts_at: slot.startsAt,
  ends_at: slot.endsAt,
  status: 'confirmed',
};

test('cancellation commits state and an immutable event with prior slot and no resulting slot', async () => {
  const { calls, database } = createAppointmentDatabase({ matches: [match] });
  await database.cancelConfirmedAppointment({ contactWaId: 'patient', sourceMessageId: 'cancel-message', ...slot });
  const event = calls.find((call) => typeof call === 'object' && call.text.includes('insert into appointment_events'));
  assert.match(calls.find((call) => typeof call === 'object' && call.text.includes("set status = 'cancelled'")).text, /update appointments/i);
  assert.match(event.text, /resulting_starts_at, resulting_ends_at/i);
  assert.match(event.text, /null, null/i);
  assert.deepEqual(event.values.slice(3, 5), [slot.startsAt, slot.endsAt]);
  assert.equal(calls[0], 'begin');
  assert.equal(calls.at(-2), 'commit');
  assert.equal(calls.at(-1), 'release');
});

test('a request stores selected service/provider/slot after checking database availability', async () => {
  const calls = [];
  const client = {
    async query(query) {
      calls.push(query);
      if (typeof query === 'string') return { rows: [] };
      if (query.text.includes('reporting.appointment_slot_capacity_metrics')) return { rows: [{ '?column?': 1 }] };
      if (query.text.includes('insert into appointment_requests')) return { rows: [{ id: 'request-1', status: 'requested' }] };
      return { rows: [] };
    },
    release() { calls.push('release'); },
  };
  const database = createDatabase({ pool: { connect: async () => client } });

  const result = await database.createAppointmentRequest({
    contactWaId: 'patient',
    sourceMessageId: 'request-message',
    serviceCode: 'fisioterapia',
    professionalCode: 'moises',
    startsAt: '2026-12-01T10:30:00.000Z',
    endsAt: '2026-12-01T11:00:00.000Z',
  });

  assert.equal(result.id, 'request-1');
  const availability = calls.find((call) => typeof call === 'object' && call.text.includes('reporting.appointment_slot_capacity_metrics'));
  assert.deepEqual(availability.values, ['fisioterapia', 'moises', '2026-12-01T10:30:00.000Z', '2026-12-01T11:00:00.000Z']);
  const requestInsert = calls.find((call) => typeof call === 'object' && call.text.includes('insert into appointment_requests'));
  assert.match(requestInsert.text, /service_code, preferred_professional_code/i);
  assert.deepEqual(requestInsert.values.slice(2, 6), ['fisioterapia', 'moises', '2026-12-01T10:30:00.000Z', '2026-12-01T11:00:00.000Z']);
  const event = calls.find((call) => typeof call === 'object' && call.text.includes('insert into appointment_events'));
  assert.deepEqual(event.values.slice(2, 4), ['2026-12-01T10:30:00.000Z', '2026-12-01T11:00:00.000Z']);
  assert.equal(calls.at(-2), 'commit');
});

test('a duplicate request source message returns the existing request without rechecking or recording an event', async () => {
  const calls = [];
  const client = {
    async query(query) {
      calls.push(query);
      if (typeof query === 'string') return { rows: [] };
      if (query.text.includes('from appointment_requests where source_message_id')) return { rows: [{ id: 'existing-request', status: 'requested' }] };
      return { rows: [] };
    },
    release() { calls.push('release'); },
  };
  const database = createDatabase({ pool: { connect: async () => client } });
  const result = await database.createAppointmentRequest({
    contactWaId: 'patient', sourceMessageId: 'replayed-message',
    serviceCode: 'fisioterapia', professionalCode: 'moises',
    startsAt: '2026-12-01T10:30:00.000Z', endsAt: '2026-12-01T11:00:00.000Z',
  });

  assert.equal(result.id, 'existing-request');
  assert.equal(calls.some((call) => typeof call === 'object' && call.text.includes('reporting.appointment_slot_capacity_metrics')), false);
  assert.equal(calls.some((call) => typeof call === 'object' && call.text.includes('insert into appointment_events')), false);
  assert.equal(calls.at(-2), 'commit');
});

test('rescheduling records both slots and uses the exclusion constrained appointment update in one transaction', async () => {
  const { calls, database } = createAppointmentDatabase({ matches: [match] });
  await database.rescheduleConfirmedAppointment({
    contactWaId: 'patient', sourceMessageId: 'reschedule-message',
    previousStartsAt: slot.startsAt, previousEndsAt: slot.endsAt,
    resultingStartsAt: '2026-12-02T18:00:00.000Z', resultingEndsAt: '2026-12-02T18:50:00.000Z',
  });
  const update = calls.find((call) => typeof call === 'object' && call.text.includes('update appointments set starts_at'));
  const event = calls.find((call) => typeof call === 'object' && call.text.includes('insert into appointment_events'));
  assert.deepEqual(update.values.slice(1, 3), ['2026-12-02T18:00:00.000Z', '2026-12-02T18:50:00.000Z']);
  assert.deepEqual(event.values.slice(3, 7), [slot.startsAt, slot.endsAt, '2026-12-02T18:00:00.000Z', '2026-12-02T18:50:00.000Z']);
  assert.equal(calls.at(-2), 'commit');
});

test('attendance requires the scheduled end to have passed and snapshots the unchanged slot', async () => {
  const { calls, database } = createAppointmentDatabase({ matches: [match] });
  await database.recordAppointmentAttendance({ contactWaId: 'patient', sourceMessageId: 'attendance-message', ...slot });
  const query = calls.find((call) => typeof call === 'object' && call.text.includes('select a.id, a.appointment_request_id'));
  const event = calls.find((call) => typeof call === 'object' && call.text.includes('insert into appointment_events'));
  assert.match(query.text, /ends_at <= now\(\)/);
  assert.deepEqual(event.values.slice(3, 5), [slot.startsAt, slot.endsAt]);
  assert.equal(event.values[5], 'attended');
});

test('a repeated source message or ambiguous slot never mutates a matching appointment', async () => {
  const repeated = createAppointmentDatabase({ matches: [match], duplicateEvents: [{ '?column?': 1 }] });
  await repeated.database.cancelConfirmedAppointment({ contactWaId: 'patient', sourceMessageId: 'same-command', ...slot });
  assert.equal(repeated.calls.some((call) => typeof call === 'object' && call.text.includes('update appointments')), false);

  const ambiguous = createAppointmentDatabase({ matches: [match, { ...match, id: 'appointment-2' }] });
  const result = await ambiguous.database.cancelConfirmedAppointment({ contactWaId: 'patient', sourceMessageId: 'ambiguous-command', ...slot });
  assert.equal(result, null);
  assert.equal(ambiguous.calls.some((call) => typeof call === 'object' && call.text.includes('update appointments')), false);
});
