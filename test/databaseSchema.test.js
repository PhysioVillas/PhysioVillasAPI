import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schemaPath = new URL('../db/migrations/001_initial_schema.sql', import.meta.url);

test('initial database migration preserves the reporting and webhook invariants', async () => {
  const schema = await readFile(schemaPath, 'utf8');

  assert.match(schema, /create table if not exists contacts/i);
  assert.match(schema, /create table if not exists messages/i);
  assert.match(schema, /infobip_message_id text unique/i);
  assert.match(schema, /direction in \('in', 'out'\)/i);
  assert.match(schema, /sent_via text check \(sent_via in \('api', 'business_app'\)\)/i);
  assert.match(schema, /created_at timestamptz not null default now\(\)/i);
});
