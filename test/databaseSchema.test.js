import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schemaPath = new URL('../db/migrations/001_initial_schema.sql', import.meta.url);
const reportingSchemaPath = new URL('../db/migrations/002_reporting_views.sql', import.meta.url);
const deliveryStatusSchemaPath = new URL('../db/migrations/004_message_delivery_status.sql', import.meta.url);
const activeConversationSchemaPath = new URL('../db/migrations/005_active_conversations.sql', import.meta.url);
const flowReportingSchemaPath = new URL('../db/migrations/007_whatsapp_flow_reporting.sql', import.meta.url);
const appointmentsSchemaPath = new URL('../db/migrations/009_appointments.sql', import.meta.url);

test('initial database migration preserves the reporting and webhook invariants', async () => {
  const schema = await readFile(schemaPath, 'utf8');

  assert.match(schema, /create table if not exists contacts/i);
  assert.match(schema, /create table if not exists messages/i);
  assert.match(schema, /infobip_message_id text unique/i);
  assert.match(schema, /direction in \('in', 'out'\)/i);
  assert.match(schema, /sent_via text check \(sent_via in \('api', 'business_app'\)\)/i);
  assert.match(schema, /created_at timestamptz not null default now\(\)/i);
});

test('appointment migration persists scheduled service/provider data, enforces clinic capacity, and exposes local-time aggregates', async () => {
  const schema = await readFile(appointmentsSchemaPath, 'utf8');
  const reportingSql = schema.slice(schema.indexOf('create or replace view reporting.daily_appointment_event_metrics')).replace(/^--.*$/gm, '');
  const reportingSelect = reportingSql.slice(0, reportingSql.indexOf('from appointment_events'));

  assert.match(schema, /create table if not exists appointment_requests/i);
  assert.match(schema, /preferred_professional_code text not null/i);
  assert.match(schema, /preferred_starts_at timestamptz not null/i);
  assert.match(schema, /capacity_per_slot smallint not null/i);
  assert.match(schema, /pg_advisory_xact_lock/i);
  assert.match(schema, /capacity_scope = 'service_slot'/i);
  assert.match(schema, /appointment\.professional_code = slot\.professional_code/i);
  assert.match(schema, /create trigger appointment_events_immutable/i);
  assert.match(schema, /previous_starts_at/i);
  assert.match(schema, /resulting_starts_at/i);
  assert.match(schema, /scheduled_date/i);
  assert.match(schema, /scheduled_time/i);
  assert.match(schema, /appointment_slot_capacity_metrics/i);
  assert.match(schema, /America\/Bahia/i);
  assert.match(schema, /attendance_status = 'attended'/i);
  assert.doesNotMatch(reportingSelect, /\b(contact_wa_id|source_message_id|appointment_id|appointment_request_id|body|payload)\b/i);
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

test('WhatsApp flow reporting migration is deduplicated and exposes aggregate fields only', async () => {
  const schema = await readFile(flowReportingSchemaPath, 'utf8');

  assert.match(schema, /create table if not exists whatsapp_flow_events/i);
  assert.match(schema, /unique \(message_id, event_type\)/i);
  assert.match(schema, /create or replace view reporting\.daily_whatsapp_flow_metrics/i);
  assert.match(schema, /count\(distinct conversation_id\) as conversation_count/i);
  assert.match(schema, /'menu_agendar'.*'menu_paciente_novo'.*'menu_atendente'/s);
  assert.doesNotMatch(schema.replace(/^--.*$/gm, ''), /\b(body|wa_id|profile_name|payload)\b/i);
});
