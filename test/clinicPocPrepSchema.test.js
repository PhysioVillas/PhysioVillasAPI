import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const path = new URL('../db/migrations/011_clinic_poc_prep.sql', import.meta.url);

test('migration 011 prepares clinica_simulada inside a schema guard', async () => {
  const sql = await readFile(path, 'utf8');
  const code = sql.replace(/^--.*$/gm, '');

  assert.match(code, /if to_regnamespace\('clinica_simulada'\) is not null then/i);
  assert.match(code, /end if;\s*end \$\$;\s*$/i);
  assert.doesNotMatch(code, /drop (table|column)|rename/i);

  for (const seq of [
    'f_agendamentos_agendamento_id_seq',
    'd_pacientes_paciente_id_seq',
    'f_leads_lead_id_seq',
    'f_recebimentos_recebimento_id_seq',
  ]) {
    assert.match(code, new RegExp(`create sequence clinica_simulada\\.${seq}`, 'i'));
    assert.match(code, new RegExp(`nextval\\('clinica_simulada\\.${seq}'\\)`, 'i'));
  }
  assert.match(code, /coalesce\(max\(agendamento_id\), 0\) \+ 1/i);
  assert.match(code, /coalesce\(max\(paciente_id\), 0\) \+ 1/i);
  assert.match(code, /coalesce\(max\(lead_id\), 0\) \+ 1/i);
  assert.match(code, /coalesce\(max\(recebimento_id\), 0\) \+ 1/i);
});

test('migration 011 adds unique fictitious CPFs and demo patients', async () => {
  const sql = await readFile(path, 'utf8');

  assert.match(sql, /add column if not exists cpf text/i);
  assert.match(sql, /constraint d_pacientes_cpf_key unique \(cpf\)/i);
  assert.match(sql, /function clinica_simulada\.cpf_ficticio\(/i);
  assert.match(sql, /set cpf = clinica_simulada\.cpf_ficticio\(paciente_id\)/i);
  for (const cpf of ['80590844296', '78836009581', '77081174884', '75326340194', '73571505425']) {
    assert.match(sql, new RegExp(`'${cpf}'`));
  }
});

test('migration 011 creates d_precos, support indexes and nullable dispatch_id', async () => {
  const sql = await readFile(path, 'utf8');

  assert.match(sql, /create table if not exists clinica_simulada\.d_precos/i);
  assert.match(sql, /tipo in \('avulso', 'pacote', 'mensalidade'\)/i);
  assert.match(sql, /primary key \(servico_id, tipo\)/i);
  assert.match(sql, /max\(a\.valor_sessao\)/i);
  assert.match(sql, /f_agendamentos \(paciente_id, data\)/i);
  assert.match(sql, /\(servico_id, profissional_id, data, hora\)\s+where status in \('Agendado', 'Realizado'\)/i);
  assert.match(sql, /jornada_contatos \(paciente_id\)/i);
  assert.match(sql, /alter column dispatch_id drop not null/i);
});
