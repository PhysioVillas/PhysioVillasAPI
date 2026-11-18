import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schemaPath = new URL('../db/migrations/014_bot_reporting.sql', import.meta.url);
const views = [
  'bot_funnel_daily',
  'bot_handoffs_daily',
  'bot_appointment_actions_daily',
  'bot_self_service_rate_daily',
];

test('bot reporting migration defines the four reporting views in America/Bahia', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  for (const view of views) {
    assert.match(schema, new RegExp(`create or replace view reporting\\.${view}\\b`, 'i'));
  }
  assert.match(schema, /event_type = 'bot_step_sent'/i);
  assert.match(schema, /group by[\s\S]*step_key/i);
  assert.match(schema, /percentile_cont\(0\.5\)/i);
  assert.match(schema, /from public\.handoffs/i);
  assert.match(schema, /in_business_hours/i);
  assert.match(schema, /from public\.conversations/i);
  assert.match(schema, /self_service_rate/i);
  assert.match(schema, /at time zone 'America\/Bahia'/i);
  assert.doesNotMatch(schema, /at time zone 'UTC'/i);
});

test('appointment actions view is guarded and keeps columns without clinica_simulada', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  assert.match(schema, /if to_regnamespace\('clinica_simulada'\) is not null then/i);
  assert.match(schema, /from clinica_simulada\.audit_log/i);
  assert.match(schema, /entity_type = 'agendamento'/i);
  assert.match(schema, /actor_scope = 'chatbot'/i);
  assert.match(schema, /'booked', 'rescheduled', 'cancelled'/i);
  assert.match(schema, /\belse\b[\s\S]*null::date as activity_date[\s\S]*where false/i);
  assert.match(schema, /null::text as action/i);
  assert.match(schema, /null::bigint as action_count/i);
});

test('views are granted conditionally to powerbi_reader', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  assert.match(schema, /rolname = 'powerbi_reader'/i);
  for (const view of views) {
    assert.match(schema, new RegExp(`grant select on reporting\\.${view} to powerbi_reader`, 'i'));
  }
});

test('migration is append-only', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  assert.doesNotMatch(schema, /\bdrop\s+(view|table|column|schema)\b/i);
  assert.doesNotMatch(schema, /\brename\b/i);
  assert.doesNotMatch(schema, /\b(delete\s+from|truncate)\b/i);
});
