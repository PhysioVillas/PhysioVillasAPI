import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schemaPath = new URL('../db/migrations/003_conversation_catalog.sql', import.meta.url);

test('conversation catalog migration keeps automation metadata separate from clinical data', async () => {
  const schema = await readFile(schemaPath, 'utf8');
  const executableSql = schema.replace(/^--.*$/gm, '');

  assert.match(schema, /create table if not exists conversations/i);
  assert.match(schema, /wa_id text references contacts\(wa_id\) on delete set null/i);
  assert.match(schema, /current_intent in \('faq', 'triage', 'scheduling', 'human_handoff', 'unknown'\)/i);
  assert.match(schema, /add column if not exists conversation_id uuid/i);
  assert.match(schema, /create table if not exists message_templates/i);
  assert.match(schema, /parameter_count integer not null default 0 check \(parameter_count >= 0\)/i);
  assert.match(schema, /create table if not exists faq_entries/i);
  assert.match(schema, /status in \('draft', 'published', 'archived'\)/i);
  assert.doesNotMatch(executableSql, /diagn[oó]stico/i);
  assert.doesNotMatch(executableSql, /anamnese/i);
});
