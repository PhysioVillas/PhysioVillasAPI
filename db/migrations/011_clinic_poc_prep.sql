-- 011: prepara o schema clinica_simulada (POC) para escrita pelo bot (T05).
--
-- Tudo roda dentro da guarda de schema: em banco sem clinica_simulada
-- (preview/novo) a migration nao faz nada. Apenas acrescenta; nada e renomeado.
--
-- Pacientes de demonstracao (nomes e CPFs ficticios, fixos; roteiro do T20):
--   Demo Ana Teste      CPF 805.908.442-96
--   Demo Bruno Teste    CPF 788.360.095-81
--   Demo Carla Teste    CPF 770.811.748-84
--   Demo Diego Teste    CPF 753.263.401-94
--   Demo Elisa Teste    CPF 735.715.054-25
-- Os 9 digitos base dos CPFs de demonstracao sao cpf_ficticio_base(900000000+n),
-- n=1..5: so colidiriam com um paciente gerado se paciente_id chegasse a ~900 milhoes.
--
-- CPFs gerados: base = (paciente_id * 982451653 + 123456789) mod 10^9
-- (982451653 e primo e coprimo de 10^9, entao a base e injetiva), seguida dos
-- 2 digitos verificadores. Nunca resulta em sequencia de digitos repetidos.

do $$
begin
  if to_regnamespace('clinica_simulada') is not null then

    -- 1. Sequences (max+1 so na criacao; reaplicar nao as rebobina) -----------
    if to_regclass('clinica_simulada.f_agendamentos_agendamento_id_seq') is null then
      create sequence clinica_simulada.f_agendamentos_agendamento_id_seq;
      perform setval('clinica_simulada.f_agendamentos_agendamento_id_seq',
        (select coalesce(max(agendamento_id), 0) + 1 from clinica_simulada.f_agendamentos), false);
    end if;
    if to_regclass('clinica_simulada.d_pacientes_paciente_id_seq') is null then
      create sequence clinica_simulada.d_pacientes_paciente_id_seq;
      perform setval('clinica_simulada.d_pacientes_paciente_id_seq',
        (select coalesce(max(paciente_id), 0) + 1 from clinica_simulada.d_pacientes), false);
    end if;
    if to_regclass('clinica_simulada.f_leads_lead_id_seq') is null then
      create sequence clinica_simulada.f_leads_lead_id_seq;
      perform setval('clinica_simulada.f_leads_lead_id_seq',
        (select coalesce(max(lead_id), 0) + 1 from clinica_simulada.f_leads), false);
    end if;
    if to_regclass('clinica_simulada.f_recebimentos_recebimento_id_seq') is null then
      create sequence clinica_simulada.f_recebimentos_recebimento_id_seq;
      perform setval('clinica_simulada.f_recebimentos_recebimento_id_seq',
        (select coalesce(max(recebimento_id), 0) + 1 from clinica_simulada.f_recebimentos), false);
    end if;

    alter table clinica_simulada.f_agendamentos
      alter column agendamento_id set default nextval('clinica_simulada.f_agendamentos_agendamento_id_seq');
    alter table clinica_simulada.d_pacientes
      alter column paciente_id set default nextval('clinica_simulada.d_pacientes_paciente_id_seq');
    alter table clinica_simulada.f_leads
      alter column lead_id set default nextval('clinica_simulada.f_leads_lead_id_seq');
    alter table clinica_simulada.f_recebimentos
      alter column recebimento_id set default nextval('clinica_simulada.f_recebimentos_recebimento_id_seq');

    -- 2. CPF ficticio, valido e deterministico ---------------------------------
    execute $fn$
      create or replace function clinica_simulada.cpf_ficticio_base(p_id bigint)
      returns text language sql immutable as
      $b$ select lpad((((p_id % 1000000000) * 982451653 + 123456789) % 1000000000)::text, 9, '0') $b$
    $fn$;

    execute $fn$
      create or replace function clinica_simulada.cpf_com_digitos(p_base text)
      returns text language plpgsql immutable as
      $b$
      declare
        v_digits int[];
        v_sum int;
        v_i int;
        v_j int;
      begin
        for v_i in 1..9 loop
          v_digits[v_i] := substr(p_base, v_i, 1)::int;
        end loop;
        for v_i in 10..11 loop
          v_sum := 0;
          for v_j in 1..(v_i - 1) loop
            v_sum := v_sum + v_digits[v_j] * (v_i + 1 - v_j);
          end loop;
          v_digits[v_i] := (v_sum * 10) % 11 % 10;
        end loop;
        return array_to_string(v_digits, '');
      end;
      $b$
    $fn$;

    execute $fn$
      create or replace function clinica_simulada.cpf_ficticio(p_paciente_id bigint)
      returns text language sql immutable as
      $b$ select clinica_simulada.cpf_com_digitos(clinica_simulada.cpf_ficticio_base(p_paciente_id)) $b$
    $fn$;

    alter table clinica_simulada.d_pacientes add column if not exists cpf text;

    update clinica_simulada.d_pacientes
       set cpf = clinica_simulada.cpf_ficticio(paciente_id)
     where cpf is null;

    if not exists (
      select 1 from pg_constraint
       where conrelid = 'clinica_simulada.d_pacientes'::regclass
         and conname = 'd_pacientes_cpf_key'
    ) then
      alter table clinica_simulada.d_pacientes add constraint d_pacientes_cpf_key unique (cpf);
    end if;

    -- 3. Pacientes de demonstracao (CPFs fixos, ids vindos da sequence) --------
    insert into clinica_simulada.d_pacientes
      (paciente, sexo, faixa_etaria, data_cadastro, origem, canal_origem, cpf)
    select v.nome, v.sexo, v.faixa, current_date, 'Base atual', 'Base atual', v.cpf
      from (values
        ('Demo Ana Teste',   'F', '30-39', '80590844296'),
        ('Demo Bruno Teste', 'M', '40-49', '78836009581'),
        ('Demo Carla Teste', 'F', '50-59', '77081174884'),
        ('Demo Diego Teste', 'M', '18-29', '75326340194'),
        ('Demo Elisa Teste', 'F', '60+',   '73571505425')
      ) as v(nome, sexo, faixa, cpf)
     where not exists (select 1 from clinica_simulada.d_pacientes p where p.cpf = v.cpf);

    -- 4. Precos particulares ---------------------------------------------------
    create table if not exists clinica_simulada.d_precos (
      servico_id bigint not null references clinica_simulada.d_servicos (servico_id),
      tipo text not null check (tipo in ('avulso', 'pacote', 'mensalidade')),
      valor numeric(18,2) not null,
      primary key (servico_id, tipo)
    );

    insert into clinica_simulada.d_precos (servico_id, tipo, valor)
    select s.servico_id, v.tipo, v.valor
      from (values
        ('Fisioterapia ambulatorial', 'avulso',  120.00),
        ('Fisioterapia ambulatorial', 'pacote',  100.00),
        ('RPG',                       'avulso',  150.00),
        ('RPG',                       'pacote',  130.00),
        ('Massagem',                  'avulso',  140.00),
        ('Fisioterapia pélvica',      'avulso',  160.00),
        ('Fisioterapia pélvica',      'pacote',  140.00)
      ) as v(servico, tipo, valor)
      join clinica_simulada.d_servicos s on s.servico = v.servico
    on conflict (servico_id, tipo) do nothing;

    -- Pilates: mensalidade = valor maximo observado em sessoes de mensalidade
    -- (53,12 em 2026-11-18; esse valor e o fallback se nao houver dados).
    insert into clinica_simulada.d_precos (servico_id, tipo, valor)
    select s.servico_id, 'mensalidade',
           coalesce((select max(a.valor_sessao)
                       from clinica_simulada.f_agendamentos a
                      where a.servico_id = s.servico_id
                        and a.forma_pagamento = 'Mensalidade'), 53.12)
      from clinica_simulada.d_servicos s
     where s.servico = 'Pilates'
    on conflict (servico_id, tipo) do nothing;

    -- 5. Indices de apoio ------------------------------------------------------
    create index if not exists f_agendamentos_paciente_id_data_idx
      on clinica_simulada.f_agendamentos (paciente_id, data);
    create index if not exists f_agendamentos_vaga_ativa_idx
      on clinica_simulada.f_agendamentos (servico_id, profissional_id, data, hora)
      where status in ('Agendado', 'Realizado');
    create index if not exists jornada_contatos_paciente_id_idx
      on clinica_simulada.jornada_contatos (paciente_id);

    -- 6. Reserva iniciada pelo paciente nao tem disparo ------------------------
    -- Mantem unique e FK (nulos nao conflitam no unique).
    alter table clinica_simulada.agendamento_chatbot
      alter column dispatch_id drop not null;

  end if;
end $$;
