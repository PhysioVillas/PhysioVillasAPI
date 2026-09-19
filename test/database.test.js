import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from '../src/services/database.js';

function createPool() {
  const calls = [];

  return {
    calls,
    query: async (query) => {
      calls.push(query);
      return { rows: [{ persisted: true }] };
    },
  };
}

test('upsertContact keeps the most recent contact data through a parameterized query', async () => {
  const pool = createPool();
  const database = createDatabase({ pool });

  const result = await database.upsertContact({
    waId: 'contact-id',
    profileName: 'Patient',
    lastMessageAt: '2026-09-19T12:00:00.000Z',
  });

  assert.deepEqual(result, { persisted: true });
  assert.match(pool.calls[0].text, /on conflict \(wa_id\) do update/i);
  assert.match(pool.calls[0].text, /greatest\(contacts\.last_message_at/i);
  assert.deepEqual(pool.calls[0].values, [
    'contact-id',
    'Patient',
    '2026-09-19T12:00:00.000Z',
  ]);
});

test('insertMessage is parameterized and ignores a duplicate Infobip message identifier', async () => {
  const pool = createPool();
  const database = createDatabase({ pool });

  await database.insertMessage({
    infobipMessageId: 'event-id',
    waId: 'contact-id',
    direction: 'out',
    sentVia: 'api',
    body: 'Hello',
    messageType: 'text',
    status: 'sent',
  });

  assert.match(pool.calls[0].text, /on conflict \(infobip_message_id\) do nothing/i);
  assert.deepEqual(pool.calls[0].values.slice(0, 8), [
    'event-id',
    'contact-id',
    'out',
    'api',
    'Hello',
    'text',
    'sent',
    null,
  ]);
});

test('database methods reject invalid domain values before querying PostgreSQL', async () => {
  const pool = createPool();
  const database = createDatabase({ pool });

  await assert.rejects(
    database.insertMessage({ direction: 'sideways' }),
    /direction must be 'in' or 'out'/,
  );
  await assert.rejects(
    database.insertMessage({ direction: 'out', sentVia: 'unknown' }),
    /sentVia must be 'api', 'business_app', or null/,
  );
  await assert.rejects(database.upsertContact({}), /waId is required/);
  assert.equal(pool.calls.length, 0);
});

test('database factory requires DATABASE_URL when it creates the pool', () => {
  assert.throws(() => createDatabase(), /DATABASE_URL is required/);
});

test('persistWebhookMessage atomically saves a normalized webhook message', async () => {
  const calls = [];
  const client = {
    query: async (query) => {
      calls.push(query);

      if (typeof query === 'string') {
        return { rows: [] };
      }

      return {
        rows: [query.text.includes('insert into contacts') ? { waId: 'contact-id' } : { id: 'message-id' }],
      };
    },
    release: () => calls.push('release'),
  };
  const database = createDatabase({
    pool: { connect: async () => client },
  });

  const result = await database.persistWebhookMessage({
    contact: { waId: 'contact-id' },
    message: { direction: 'in', body: 'Hello', messageType: 'text' },
  });

  assert.deepEqual(result, {
    contact: { waId: 'contact-id' },
    message: { id: 'message-id' },
  });
  assert.equal(calls[0], 'begin');
  assert.match(calls[1].text, /insert into contacts/i);
  assert.match(calls[2].text, /insert into messages/i);
  assert.equal(calls[3], 'commit');
  assert.equal(calls[4], 'release');
});

test('persistWebhookMessage rolls back and releases the database client on failure', async () => {
  const calls = [];
  const client = {
    query: async (query) => {
      calls.push(query);

      if (typeof query === 'string') {
        return { rows: [] };
      }

      throw new Error('database unavailable');
    },
    release: () => calls.push('release'),
  };
  const database = createDatabase({
    pool: { connect: async () => client },
  });

  await assert.rejects(
    database.persistWebhookMessage({
      contact: { waId: 'contact-id' },
      message: { direction: 'in' },
    }),
    /database unavailable/,
  );

  assert.equal(calls[0], 'begin');
  assert.equal(calls.at(-2), 'rollback');
  assert.equal(calls.at(-1), 'release');
});
