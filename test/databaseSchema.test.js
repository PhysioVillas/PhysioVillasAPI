import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schemaPath = new URL('../db/migrations/001_initial_schema.sql', import.meta.url);
const reportingSchemaPath = new URL('../db/migrations/002_reporting_views.sql', import.meta.url);
const deliveryStatusSchemaPath = new URL('../db/migrations/004_message_delivery_status.sql', import.meta.url);
const activeConversationSchemaPath = new URL('../db/migrations/005_active_conversations.sql', import.meta.url);

test('initial database migration preserves the reporting and webhook invariants', async () => {
  const schema = await readFile(schemaPath, 'utf8');

  assert.match(schema, /create table if not exists contacts/i);
  assert.match(schema, /create table if not exists messages/i);
  assert.match(schema, /infobip_message_id text unique/i);
  assert.match(schema, /direction in \('in', 'out'\)/i);
  assert.match(schema, /sent_via text check \(sent_via in \('api', 'business_app'\)\)/i);
  assert.match(schema, /created_at timestamptz not null default now\(\)/i);
});

test('reporting migration exposes only aggregate operational metrics', async () => {
  const schema = await readFile(reportingSchemaPath, 'utf8');

  assert.match(schema, /create schema if not exists reporting/i);
  assert.match(schema, /create or replace view reporting\.daily_message_metrics/i);
  assert.match(schema, /count\(\*\) as message_count/i);
  assert.match(schema, /count\(\*\) filter \(where error_code is not null\) as error_count/i);
  assert.doesNotMatch(schema, /\bbody\b/i);
  assert.doesNotMatch(schema, /\bwa_id\b/i);
  assert.doesNotMatch(schema, /\bprofile_name\b/i);
});

test('delivery-status migration stores only the delivery update instant', async () => {
  const schema = await readFile(deliveryStatusSchemaPath, 'utf8');

  assert.match(schema, /add column if not exists status_updated_at timestamptz/i);
  assert.match(schema, /create index if not exists messages_status_updated_at_idx/i);
  assert.doesNotMatch(schema, /price/i);
  assert.doesNotMatch(schema, /payload/i);
});

test('active-conversation migration allows only one open operational conversation per contact', async () => {
  const schema = await readFile(activeConversationSchemaPath, 'utf8');

  assert.match(schema, /create unique index if not exists conversations_one_open_per_contact_idx/i);
  assert.match(schema, /on conversations \(wa_id\)/i);
  assert.match(schema, /where status = 'open' and wa_id is not null/i);
  const sqlWithoutComments = schema.replace(/^--.*$/gm, '');
  assert.doesNotMatch(sqlWithoutComments, /body|triage|diagnos/i);
});
