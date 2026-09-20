import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeApp } from '../src/bootstrap.js';

test('runtime creates the PostgreSQL adapter only when DATABASE_URL is configured', () => {
  let databaseOptions;
  const database = { verifySchema: async () => {} };

  const { app, config } = createRuntimeApp({
    env: { DATABASE_URL: ' postgres://neon.example/chatmanager ' },
    createDatabaseFactory: (options) => {
      databaseOptions = options;
      return database;
    },
  });

  assert.equal(typeof app, 'function');
  assert.equal(config.databaseUrl, 'postgres://neon.example/chatmanager');
  assert.deepEqual(databaseOptions, {
    connectionString: 'postgres://neon.example/chatmanager',
  });
});

test('runtime remains safely disconnected when no database or Infobip configuration exists', () => {
  let databaseCreated = false;
  let clientCreated = false;

  const { app, config } = createRuntimeApp({
    env: {},
    createDatabaseFactory: () => {
      databaseCreated = true;
    },
    createInfobipMessagesClientFactory: () => {
      clientCreated = true;
    },
  });

  assert.equal(typeof app, 'function');
  assert.equal(config.databaseUrl, undefined);
  assert.equal(databaseCreated, false);
  assert.equal(clientCreated, false);
});
