import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schemaPath = new URL('../db/migrations/010_bot_runtime.sql', import.meta.url);

test('bot runtime migration defines bot_config, conversation_state and handoffs', async () => {
  const schema = await readFile(schemaPath, 'utf8');

  assert.match(schema, /create table if not exists bot_config/i);
  assert.match(schema, /key text primary key/i);
  assert.match(schema, /value jsonb not null/i);
  assert.match(schema, /create table if not exists conversation_state/i);
  assert.match(schema, /wa_id text primary key references public\.contacts\(wa_id\)/i);
  assert.match(schema, /context jsonb not null default '\{\}'/i);
  assert.match(schema, /cpf_attempts smallint not null default 0/i);
  assert.match(schema, /misunderstood_count smallint not null default 0/i);
  assert.match(schema, /expires_at timestamptz not null/i);
  assert.match(schema, /create table if not exists handoffs/i);
  assert.match(schema, /first_team_reply_at timestamptz/i);
  assert.match(schema, /in_business_hours boolean not null/i);
});

test('handoffs restrict reason and allow one open handoff per contact', async () => {
  const schema = await readFile(schemaPath, 'utf8');

  for (const reason of [
    'patient_request', 'payment', 'clinical_or_urgency', 'late_change',
    'bot_failure', 'identity_failure', 'document_request',
  ]) {
    assert.match(schema, new RegExp(`'${reason}'`));
  }
  assert.match(schema, /create unique index if not exists handoffs_one_open_per_wa_id_idx\s+on handoffs \(wa_id\) where closed_at is null/i);
  assert.match(schema, /pg_roles where rolname = 'powerbi_reader'/i);
  assert.match(schema, /grant select on public\.handoffs to powerbi_reader/i);
});

test('bot runtime migration seeds the 11 bot_config keys idempotently', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  const keys = [
    'timezone', 'reschedule_min_notice_hours', 'cancel_min_notice_hours',
    'human_support_hours', 'message_retention_days', 'booking_horizon_days',
    'conversation_step_timeout_minutes', 'handoff_silence_hours',
    'cpf_max_attempts', 'max_misunderstood_replies', 'reminder_hours_before',
  ];

  for (const key of keys) {
    assert.match(schema, new RegExp(`\\('${key}',`));
  }
  assert.match(schema, /"America\/Bahia"/);
  assert.match(schema, /\{"start":"08:00","end":"18:00","days":\[0,1,2,3,4,5,6\]\}/);
  assert.match(schema, /'null'::jsonb/);
  assert.match(schema, /\[24,4\]/);
  assert.match(schema, /on conflict \(key\) do nothing/i);
});
