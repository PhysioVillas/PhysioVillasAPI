import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const path = new URL('../db/migrations/012_clinic_schedule_extension.sql', import.meta.url);

test('schedule extension migration is guarded, idempotent and covers holidays and capacity copy', async () => {
  const sql = await readFile(path, 'utf8');

  assert.match(sql, /if to_regnamespace\('clinica_simulada'\) is not null then/i);
  assert.match(sql, /create or replace function clinica_simulada\.extend_schedule\(p_days int default 60\)/i);
  assert.match(sql, /returns int/i);
  assert.match(sql, /'01-01','04-21','05-01','09-07','10-12','11-02','11-15','11-20','12-25'/);
  assert.match(sql, /on conflict \(data\) do nothing/i);
  assert.match(sql, /on conflict \(data, hora, profissional_id, servico_id\) do nothing/i);
  assert.match(sql, /array\[364, 7, 14, 21, 28\]/);
  assert.match(sql, /insert into clinica_simulada\.f_capacidade/i);
  assert.doesNotMatch(sql, /\b(drop|delete|truncate)\b/i);
  assert.doesNotMatch(sql, /^\s*select clinica_simulada\.extend_schedule/im);
});
