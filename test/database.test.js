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
  assert.deepEqual(pool.calls[0].values.slice(0, 9), [
    'event-id',
    'contact-id',
    null,
    'out',
    'api',
    'Hello',
    'text',
    'sent',
    null,
  ]);
});

test('recordDeliveryStatus updates only the known outbound message', async () => {
  const pool = createPool();
  const database = createDatabase({ pool });

  await database.recordDeliveryStatus({
    infobipMessageId: 'outbound-event-id',
    status: 'delivered_to_handset',
    errorCode: null,
    statusUpdatedAt: '2026-09-20T14:00:00.000+0000',
  });

  assert.match(pool.calls[0].text, /update messages/i);
  assert.match(pool.calls[0].text, /where infobip_message_id = \$1/i);
  assert.match(pool.calls[0].text, /status_updated_at = coalesce\(\$4, now\(\)\)/i);
  assert.deepEqual(pool.calls[0].values, [
    'outbound-event-id',
    'delivered_to_handset',
    null,
    '2026-09-20T14:00:00.000+0000',
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
  await assert.rejects(database.recordDeliveryStatus({}), /infobipMessageId is required/);
  await assert.rejects(
    database.recordDeliveryStatus({ infobipMessageId: 'event-id' }),
    /status is required/,
  );
  assert.equal(pool.calls.length, 0);
});

test('database factory requires DATABASE_URL when it creates the pool', () => {
  assert.throws(() => createDatabase(), /DATABASE_URL is required/);
});

test('ping verifies PostgreSQL connectivity without reading operational data', async () => {
  const pool = createPool();
  const database = createDatabase({ pool });

  await database.ping();

  assert.deepEqual(pool.calls, ['select 1']);
});

test('verifySchema requires the operational tables and reporting view', async () => {
  const pool = {
    calls: [],
    query: async (query) => {
      pool.calls.push(query);
      return {
        rows: [{
          contacts_exists: true,
          messages_exists: true,
          conversations_exists: true,
          conversations_index_exists: true,
          reporting_view_exists: true,
          delivery_status_column_exists: true,
        }],
      };
    },
  };
  const database = createDatabase({ pool });

  await database.verifySchema();

  assert.match(pool.calls[0].text, /to_regclass\('public\.contacts'\)/i);
  assert.match(pool.calls[0].text, /to_regclass\('public\.conversations'\)/i);
  assert.match(pool.calls[0].text, /conversations_one_open_per_contact_idx/i);
  assert.match(pool.calls[0].text, /reporting\.daily_message_metrics/i);
  assert.match(pool.calls[0].text, /column_name = 'status_updated_at'/i);
});

test('verifySchema rejects an incomplete database before webhooks are accepted', async () => {
  const database = createDatabase({
    pool: {
      query: async () => ({
        rows: [{
          contacts_exists: true,
          messages_exists: false,
          conversations_exists: true,
          conversations_index_exists: true,
          reporting_view_exists: true,
          delivery_status_column_exists: true,
        }],
      }),
    },
  });

  await assert.rejects(database.verifySchema(), /database schema is incomplete/);
});

test('verifySchema requires the status-update column before delivery reports are accepted', async () => {
  const database = createDatabase({
    pool: {
      query: async () => ({
        rows: [{
          contacts_exists: true,
          messages_exists: true,
          conversations_exists: true,
          conversations_index_exists: true,
          reporting_view_exists: true,
          delivery_status_column_exists: false,
        }],
      }),
    },
  });

  await assert.rejects(database.verifySchema(), /database schema is incomplete/);
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
        rows: [
          query.text.includes('insert into contacts')
            ? { waId: 'contact-id' }
            : query.text.includes('insert into conversations')
              ? { id: 'conversation-id', wa_id: 'contact-id', status: 'open' }
              : { id: 'message-id' },
        ],
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
    conversation: { id: 'conversation-id', wa_id: 'contact-id', status: 'open' },
    message: { id: 'message-id' },
  });
  assert.equal(calls[0], 'begin');
  assert.match(calls[1].text, /insert into contacts/i);
  assert.match(calls[2].text, /insert into conversations/i);
  assert.match(calls[3].text, /insert into messages/i);
  assert.equal(calls[4], 'commit');
  assert.equal(calls[5], 'release');
  assert.equal(calls[3].values[2], 'conversation-id');
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
