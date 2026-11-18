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

test('flow events check keeps old keys, accepts flow:step keys and precedes the views', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  assert.match(schema, /drop constraint if exists whatsapp_flow_events_check/i);
  assert.match(schema, /add constraint whatsapp_flow_events_check check/i);
  assert.match(schema, /'faq_menu', 'faq_answer', 'faq_handoff'/);
  assert.match(schema, /step_key ~ '\^\[a-z_\]\+:\[a-z0-9_\|:-\]\+\$'/);
  assert.match(schema, /event_type = 'flow_option_selected' and source = 'patient' and step_key in \(/);
  assert.match(schema, /event_type = 'team_message_sent' and source = 'team' and step_key is null/);
  assert.ok(
    schema.indexOf('add constraint whatsapp_flow_events_check') <
      schema.indexOf('create or replace view reporting.bot_funnel_daily'),
  );
});

test('migration is append-only', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  assert.doesNotMatch(schema, /\bdrop\s+(view|table|column|schema)\b/i);
  assert.doesNotMatch(schema, /\brename\b/i);
  assert.doesNotMatch(schema, /\b(delete\s+from|truncate)\b/i);
});

test('migration 014 adds the team_takeover handoff reason and keeps the 010 reasons', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../db/migrations/014_bot_reporting.sql', import.meta.url), 'utf8');
  const code = sql.replace(/^--.*$/gm, '');

  assert.match(code, /alter table public\.handoffs\s+drop constraint if exists handoffs_reason_check;/i);
  assert.match(code, /add constraint handoffs_reason_check check \(reason in \(/i);
  for (const reason of ['patient_request', 'payment', 'clinical_or_urgency', 'late_change',
    'bot_failure', 'identity_failure', 'document_request', 'team_takeover']) {
    assert.match(code, new RegExp(`'${reason}'`));
  }
});
