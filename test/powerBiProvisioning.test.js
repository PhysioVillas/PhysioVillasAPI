import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const provisioningPath = new URL('../db/provisioning/powerbi_reader.sql', import.meta.url);

test('Power BI provisioning grants only reporting reads to the pre-existing role', async () => {
  const sql = await readFile(provisioningPath, 'utf8');

  assert.match(sql, /revoke all privileges on schema public from powerbi_reader/i);
  assert.match(sql, /revoke all privileges on all tables in schema public from powerbi_reader/i);
  assert.match(sql, /grant usage on schema reporting to powerbi_reader/i);
  assert.match(sql, /grant select on all tables in schema reporting to powerbi_reader/i);
  assert.match(sql, /alter default privileges in schema reporting\s+grant select on tables to powerbi_reader/i);
  assert.doesNotMatch(sql, /create role/i);
  assert.doesNotMatch(sql, /password\s+['"]/i);
});
