import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandoffRepository } from '../src/services/bot/handoffRepository.js';
import { createStateStore } from '../src/services/bot/stateStore.js';

function createPool(...responses) {
  const calls = [];
  return {
    calls,
    query: async (query) => {
      calls.push(query);
      return responses.length ? responses.shift() : { rows: [] };
    },
  };
}

const NOW = new Date('2026-11-18T12:00:00.000Z');

test('getActive filters expired state in SQL with the passed now and maps columns', async () => {
  const pool = createPool({
    rows: [{
      wa_id: 'w1', flow: 'booking', step: 'choose_day', context: { a: 1 },
      cpf_attempts: 1, misunderstood_count: 2,
      expires_at: '2026-11-18T12:30:00.000Z', updated_at: '2026-11-18T12:00:00.000Z',
    }],
  });
  const state = await createStateStore({ pool }).getActive('w1', NOW);

  assert.match(pool.calls[0].text, /expires_at > \$2/);
  assert.deepEqual(pool.calls[0].values, ['w1', NOW]);
  assert.deepEqual(state, {
    waId: 'w1', flow: 'booking', step: 'choose_day', context: { a: 1 },
    cpfAttempts: 1, misunderstoodCount: 2,
    expiresAt: '2026-11-18T12:30:00.000Z', updatedAt: '2026-11-18T12:00:00.000Z',
  });
});

test('getActive returns null when only expired rows exist (no row returned)', async () => {
  const pool = createPool({ rows: [] });
  assert.equal(await createStateStore({ pool }).getActive('w1', NOW), null);
});

test('save upserts by wa_id with parameterized values and requires expiresAt', async () => {
  const pool = createPool();
  const store = createStateStore({ pool });
  const expiresAt = new Date('2026-11-18T12:30:00.000Z');

  await store.save({ waId: 'w1', flow: 'faq', step: 'ask', context: { x: 'y' }, expiresAt });

  assert.match(pool.calls[0].text, /on conflict \(wa_id\) do update/i);
  assert.deepEqual(pool.calls[0].values, ['w1', 'faq', 'ask', '{"x":"y"}', 0, 0, expiresAt]);
  await assert.rejects(() => store.save({ waId: 'w1', flow: 'faq', step: 'ask' }), TypeError);
  assert.equal(pool.calls.length, 1);
});

test('clear deletes by wa_id', async () => {
  const pool = createPool();
  await createStateStore({ pool }).clear('w1');
  assert.match(pool.calls[0].text, /delete from conversation_state where wa_id = \$1/i);
  assert.deepEqual(pool.calls[0].values, ['w1']);
});

const handoffRow = {
  id: 'h1', wa_id: 'w1', reason: 'payment', in_business_hours: true,
  requested_at: NOW, first_team_reply_at: null, closed_at: null,
};

test('open inserts with on conflict do nothing and returns the new handoff', async () => {
  const pool = createPool({ rows: [handoffRow] });
  const handoff = await createHandoffRepository({ pool }).open({
    waId: 'w1', reason: 'payment', inBusinessHours: true,
  });

  assert.match(pool.calls[0].text, /on conflict \(wa_id\) where closed_at is null do nothing/i);
  assert.deepEqual(pool.calls[0].values, ['w1', 'payment', true]);
  assert.equal(handoff.id, 'h1');
  assert.equal(handoff.inBusinessHours, true);
  assert.equal(pool.calls.length, 1);
});

test('open is idempotent: when the insert is a no-op it returns the existing open handoff', async () => {
  const pool = createPool({ rows: [] }, { rows: [handoffRow] });
  const handoff = await createHandoffRepository({ pool }).open({
    waId: 'w1', reason: 'patient_request', inBusinessHours: false,
  });

  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[1].text, /closed_at is null/i);
  assert.deepEqual(pool.calls[1].values, ['w1']);
  assert.equal(handoff.reason, 'payment');
});

test('open rejects an invalid reason before querying', async () => {
  const pool = createPool();
  await assert.rejects(
    () => createHandoffRepository({ pool }).open({ waId: 'w1', reason: 'nope', inBusinessHours: true }),
    RangeError,
  );
  assert.equal(pool.calls.length, 0);
});

test('getOpen returns null when none is open', async () => {
  const pool = createPool({ rows: [] });
  assert.equal(await createHandoffRepository({ pool }).getOpen('w1'), null);
});

test('markFirstTeamReply only fills when null, on the open handoff', async () => {
  const pool = createPool({ rows: [] });
  const result = await createHandoffRepository({ pool }).markFirstTeamReply('w1', NOW);

  assert.match(pool.calls[0].text, /first_team_reply_at is null/i);
  assert.match(pool.calls[0].text, /closed_at is null/i);
  assert.deepEqual(pool.calls[0].values, ['w1', NOW]);
  assert.equal(result, null);
});

test('closeOpen closes only the open handoff', async () => {
  const pool = createPool({ rows: [{ ...handoffRow, closed_at: NOW }] });
  const result = await createHandoffRepository({ pool }).closeOpen('w1', NOW);

  assert.match(pool.calls[0].text, /closed_at is null/i);
  assert.deepEqual(pool.calls[0].values, ['w1', NOW]);
  assert.equal(result.closedAt, NOW);
});
