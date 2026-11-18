import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const path = new URL('../db/migrations/015_clinic_insurance_address.sql', import.meta.url);

test('migration 015 is guarded, idempotent and keeps referenced insurance ids', async () => {
  const code = (await readFile(path, 'utf8')).replace(/^--.*$/gm, '');

  assert.match(code, /if to_regnamespace\('clinica_simulada'\) is not null then/i);
  assert.match(code, /on conflict \(convenio_id\) do update/i);
  assert.doesNotMatch(code, /drop (table|column)|rename|delete from|truncate/i);
});

test('migration 015 lists the eight insurance plans and the clinic address', async () => {
  const code = (await readFile(path, 'utf8')).replace(/^--.*$/gm, '');
  const plans = ['Amil', 'Bradesco Saúde', 'SulAmérica', 'Cassi', 'Postal Saúde',
    'Mediservice', 'Saúde Caixa', 'Petrobras \\(AMS\\)'];

  plans.forEach((plan, index) => {
    assert.match(code, new RegExp(`\\(${index + 1}, '${plan}',`));
  });
  assert.match(code, /where slug = 'endereco'/);
  assert.match(code, /R\. Itagi, 25 - Belo Horizonte, Lauro de Freitas - BA, 42700-000/);
  assert.match(code, /where slug = 'convenios'/);
});
