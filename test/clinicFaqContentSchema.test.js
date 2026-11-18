import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const path = new URL('../db/migrations/013_clinic_faq_content.sql', import.meta.url);

test('migration 013 is guarded, idempotent and non-destructive', async () => {
  const sql = await readFile(path, 'utf8');
  const code = sql.replace(/^--.*$/gm, '');

  assert.match(code, /if to_regnamespace\('clinica_simulada'\) is not null then/i);
  assert.match(code, /end if;\s*end \$\$;\s*$/i);
  assert.match(code, /on conflict \(slug\) do update/i);
  assert.doesNotMatch(code, /drop (table|column)|rename|delete from|truncate/i);
});

test('migration 013 publishes every required FAQ slug', async () => {
  const sql = await readFile(path, 'utf8');
  const slugs = [
    'endereco',
    'o_que_levar',
    'primeira_consulta',
    'politica_cancelamento',
    'formas_pagamento',
    'convenios',
    ...[1, 2, 3, 4, 5].map((id) => `sobre_servico_${id}`),
  ];

  for (const slug of slugs) {
    assert.match(sql, new RegExp(`\\('${slug}',`));
  }
  assert.equal((sql.match(/'published', now\(\)\)/g) ?? []).length, slugs.length);
});

test('migration 013 states the fictitious address and the 24 h rule', async () => {
  const sql = await readFile(path, 'utf8');

  assert.match(sql, /Endereço FICTÍCIO/);
  assert.match(sql, /24 horas/);
  assert.match(sql, /status = 'archived'/);
});
