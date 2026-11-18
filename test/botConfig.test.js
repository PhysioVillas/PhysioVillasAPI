import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotConfig } from '../src/config/botConfig.js';

function createPool(rows = []) {
  const calls = [];

  return {
    calls,
    query: async (text) => {
      calls.push(text);
      return { rows };
    },
  };
}

function createClock(start = 0) {
  let current = start;

  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function createLogger() {
  const warnings = [];

  return {
    warnings,
    warn: (message) => warnings.push(message),
  };
}

const SEED_ROWS = [
  { key: 'timezone', value: 'America/Bahia' },
  { key: 'reschedule_min_notice_hours', value: 24 },
  { key: 'cancel_min_notice_hours', value: 24 },
  { key: 'human_support_hours', value: { start: '08:00', end: '18:00', days: [0, 1, 2, 3, 4, 5, 6] } },
  { key: 'message_retention_days', value: null },
  { key: 'booking_horizon_days', value: 21 },
  { key: 'conversation_step_timeout_minutes', value: 30 },
  { key: 'handoff_silence_hours', value: 12 },
  { key: 'cpf_max_attempts', value: 3 },
  { key: 'max_misunderstood_replies', value: 3 },
  { key: 'reminder_hours_before', value: [24, 4] },
];

const EXPECTED_DEFAULTS = {
  timezone: 'America/Bahia',
  rescheduleMinNoticeHours: 24,
  cancelMinNoticeHours: 24,
  humanSupportHours: { start: '08:00', end: '18:00', days: [0, 1, 2, 3, 4, 5, 6] },
  messageRetentionDays: null,
  bookingHorizonDays: 21,
  conversationStepTimeoutMinutes: 30,
  handoffSilenceHours: 12,
  cpfMaxAttempts: 3,
  maxMisunderstoodReplies: 3,
  reminderHoursBefore: [24, 4],
};

test('get converts snake_case rows to camelCase values', async () => {
  const pool = createPool([
    { key: 'timezone', value: 'America/Sao_Paulo' },
    { key: 'reschedule_min_notice_hours', value: 48 },
    { key: 'human_support_hours', value: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] } },
    { key: 'message_retention_days', value: 365 },
    { key: 'reminder_hours_before', value: [12] },
  ]);
  const config = await createBotConfig({ pool }).get();

  assert.equal(config.timezone, 'America/Sao_Paulo');
  assert.equal(config.rescheduleMinNoticeHours, 48);
  assert.deepEqual(config.humanSupportHours, { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] });
  assert.equal(config.messageRetentionDays, 365);
  assert.deepEqual(config.reminderHoursBefore, [12]);
  assert.equal(config.cancelMinNoticeHours, 24);
  assert.equal(pool.calls[0], 'select key, value from bot_config');
});

test('get returns the seed defaults when the table is empty', async () => {
  const config = await createBotConfig({ pool: createPool([]) }).get();

  assert.deepEqual(config, EXPECTED_DEFAULTS);
});

test('get uses defaults for missing keys and ignores unknown keys', async () => {
  const pool = createPool([
    { key: 'handoff_silence_hours', value: 6 },
    { key: 'chave_desconhecida', value: 'x' },
  ]);
  const config = await createBotConfig({ pool }).get();

  assert.equal(config.handoffSilenceHours, 6);
  assert.equal(config.timezone, 'America/Bahia');
  assert.equal(config.cpfMaxAttempts, 3);
  assert.equal(config.chaveDesconhecida, undefined);
  assert.equal(Object.hasOwn(config, 'chave_desconhecida'), false);
});

test('seed rows produce exactly the seed defaults', async () => {
  const config = await createBotConfig({ pool: createPool(SEED_ROWS) }).get();

  assert.deepEqual(config, EXPECTED_DEFAULTS);
});

test('get caches the result within the TTL and reloads after it', async () => {
  const pool = createPool(SEED_ROWS);
  const clock = createClock(1000);
  const botConfig = createBotConfig({ pool, ttlMs: 60000, now: clock.now, logger: createLogger() });

  await botConfig.get();
  clock.advance(59999);
  await botConfig.get();
  assert.equal(pool.calls.length, 1, 'no reload inside the TTL');

  clock.advance(1);
  await botConfig.get();
  assert.equal(pool.calls.length, 2, 'reload once the TTL has elapsed');
});

test('get uses the default TTL of 60 seconds', async () => {
  const pool = createPool(SEED_ROWS);
  const clock = createClock(0);
  const botConfig = createBotConfig({ pool, now: clock.now });

  await botConfig.get();
  clock.advance(60000);
  await botConfig.get();

  assert.equal(pool.calls.length, 2);
});

test('concurrent get calls during a load share a single query', async () => {
  let resolveQuery;
  const pool = {
    calls: 0,
    query: () => {
      pool.calls += 1;
      return new Promise((resolve) => {
        resolveQuery = () => resolve({ rows: SEED_ROWS });
      });
    },
  };
  const botConfig = createBotConfig({ pool });

  const pending = [botConfig.get(), botConfig.get(), botConfig.get()];
  resolveQuery();
  const results = await Promise.all(pending);

  assert.equal(pool.calls, 1);
  assert.deepEqual(results[0], EXPECTED_DEFAULTS);
  assert.deepEqual(results[2], EXPECTED_DEFAULTS);
});

test('a failed query returns defaults, logs a warning and is retried on the next call', async () => {
  let fail = true;
  let calls = 0;
  const pool = {
    query: async () => {
      calls += 1;
      if (fail) {
        throw new Error('connection refused');
      }
      return { rows: [{ key: 'cpf_max_attempts', value: 5 }] };
    },
  };
  const logger = createLogger();
  const botConfig = createBotConfig({ pool, logger });

  const first = await botConfig.get();
  assert.deepEqual(first, EXPECTED_DEFAULTS);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /connection refused/);

  fail = false;
  const second = await botConfig.get();
  assert.equal(calls, 2, 'failure is not cached');
  assert.equal(second.cpfMaxAttempts, 5);
});

test('a failed reload after the TTL keeps the last good config', async () => {
  let fail = false;
  const pool = {
    query: async () => {
      if (fail) {
        throw new Error('timeout');
      }
      return { rows: [{ key: 'cpf_max_attempts', value: 5 }] };
    },
  };
  const clock = createClock();
  const logger = createLogger();
  const botConfig = createBotConfig({ pool, logger, ttlMs: 1000, now: clock.now });

  assert.equal((await botConfig.get()).cpfMaxAttempts, 5);
  fail = true;
  clock.advance(1001);
  const stale = await botConfig.get();
  assert.equal(stale.cpfMaxAttempts, 5);
  assert.equal(logger.warnings.length, 1);
});

test('returned config is frozen so callers cannot change the cache', async () => {
  const botConfig = createBotConfig({ pool: createPool(SEED_ROWS) });
  const config = await botConfig.get();

  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.humanSupportHours), true);
  assert.equal(Object.isFrozen(config.humanSupportHours.days), true);
  assert.equal(Object.isFrozen(config.reminderHoursBefore), true);

  assert.throws(() => {
    config.timezone = 'UTC';
  }, TypeError);
  assert.throws(() => {
    config.reminderHoursBefore.push(1);
  }, TypeError);

  const again = await botConfig.get();
  assert.equal(again.timezone, 'America/Bahia');
  assert.deepEqual(again.reminderHoursBefore, [24, 4]);
});
