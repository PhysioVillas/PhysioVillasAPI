-- SNAPSHOT DE REFERENCIA do schema clinica_simulada -- NAO E UMA MIGRATION.
-- Capturado em 2026-11-18 do Neon (projeto orange-snow-21167535, branch
-- production) por consultas ao catalogo (pg_attribute, pg_constraint,
-- pg_indexes, pg_get_viewdef). Nenhuma linha de dados foi copiada.
-- Nao e aplicado por `npm run migrate` e nao esta em db/migrations/.
-- Serve de consulta para os tickets da POC; o banco real e a fonte de verdade.
-- As FKs ficam em ALTER TABLE apos as tabelas por causa do ciclo
-- d_pacientes <-> f_leads.

-- ===== Tabelas (23) =====

create table clinica_simulada.contacts (
  wa_id text not null,
  profile_name text,
  last_message_at timestamptz,
  constraint contacts_pkey primary key (wa_id)
);

create table clinica_simulada.conversations (
  id uuid not null default gen_random_uuid(),
  wa_id text,
  status text not null default 'open',
  current_intent text not null default 'unknown',
  opened_at timestamptz not null default now(),
  last_message_at timestamptz,
  closed_at timestamptz,
  constraint conversations_pkey primary key (id),
  constraint conversations_current_intent_check check (current_intent = any (array['faq','triage','scheduling','human_handoff','unknown'])),
  constraint conversations_status_check check (status = any (array['open','closed','human_handoff']))
);

create table clinica_simulada.messages (
  id uuid not null default gen_random_uuid(),
  infobip_message_id text,
  wa_id text,
  direction text not null,
  sent_via text,
  body text,
  message_type text,
  status text,
  error_code text,
  created_at timestamptz not null default now(),
  conversation_id uuid,
  status_updated_at timestamptz,
  purge_after timestamptz,
  constraint messages_pkey primary key (id),
  constraint messages_infobip_message_id_key unique (infobip_message_id),
  constraint messages_direction_check check (direction = any (array['in','out'])),
  constraint messages_sent_via_check check (sent_via = any (array['api','business_app']))
);

create table clinica_simulada.message_templates (
  id uuid not null default gen_random_uuid(),
  provider_template_id text,
  name text not null,
  language text not null,
  category text,
  status text not null default 'draft',
  parameter_count integer not null default 0,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_templates_pkey primary key (id),
  constraint message_templates_name_language_key unique (name, language),
  constraint message_templates_provider_template_id_key unique (provider_template_id),
  constraint message_templates_parameter_count_check check (parameter_count >= 0),
  constraint message_templates_status_check check (status = any (array['draft','pending_approval','approved','rejected','disabled']))
);

create table clinica_simulada.dispatches (
  id uuid not null default gen_random_uuid(),
  message_id uuid not null,
  template_id uuid,
  status text not null default 'pending',
  scheduled_for timestamptz,
  dispatched_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dispatches_pkey primary key (id),
  constraint dispatches_message_id_key unique (message_id),
  constraint dispatches_status_check check (status = any (array['pending','scheduled','sent','failed','cancelled']))
);

create table clinica_simulada.dispatch_events (
  id uuid not null default gen_random_uuid(),
  dispatch_id uuid not null,
  event_type text not null,
  detail text,
  occurred_at timestamptz not null default now(),
  constraint dispatch_events_pkey primary key (id),
  constraint dispatch_events_event_type_check check (event_type = any (array['created','scheduled','sent','failed','cancelled']))
);

create table clinica_simulada.audit_log (
  id uuid not null default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_scope text,
  created_at timestamptz not null default now(),
  constraint audit_log_pkey primary key (id)
);

create table clinica_simulada.faq_entries (
  id uuid not null default gen_random_uuid(),
  slug text not null,
  question text not null,
  answer text not null,
  status text not null default 'draft',
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint faq_entries_pkey primary key (id),
  constraint faq_entries_slug_key unique (slug),
  constraint faq_entries_status_check check (status = any (array['draft','published','archived']))
);

create table clinica_simulada.d_calendario (
  data date not null,
  ano bigint,
  mes_num bigint,
  mes text,
  ano_mes bigint,
  dia_semana_num bigint,
  dia_semana text,
  semana_ano bigint,
  feriado text,
  dia_util text,
  ate_hoje text,
  constraint d_calendario_pkey primary key (data)
);

create table clinica_simulada.d_servicos (
  servico_id bigint not null,
  servico text,
  vagas_por_horario bigint,
  duracao_min bigint,
  constraint d_servicos_pkey primary key (servico_id)
);

create table clinica_simulada.d_profissionais (
  profissional_id bigint not null,
  profissional text,
  servico_id bigint,
  constraint d_profissionais_pkey primary key (profissional_id)
);

create table clinica_simulada.d_convenios (
  convenio_id bigint not null,
  convenio text,
  prazo_pagamento_dias bigint,
  valor_sessao_fisioterapia numeric(18,4),
  valor_sessao_rpg numeric(18,4),
  valor_sessao_pelvica numeric(18,4),
  constraint d_convenios_pkey primary key (convenio_id)
);

create table clinica_simulada.d_campanhas (
  campanha_id bigint not null,
  campanha text,
  canal text,
  servico_foco_id bigint,
  data_inicio date,
  data_fim date,
  investimento_total numeric(18,4),
  constraint d_campanhas_pkey primary key (campanha_id)
);

create table clinica_simulada.d_pacientes (
  paciente_id bigint not null,
  paciente text,
  sexo text,
  faixa_etaria text,
  data_cadastro date,
  origem text,
  canal_origem text,
  campanha_id bigint,
  lead_id bigint,
  constraint d_pacientes_pkey primary key (paciente_id)
);

create table clinica_simulada.f_leads (
  lead_id bigint not null,
  data date,
  hora bigint,
  canal text,
  campanha_id bigint,
  forma_identificacao text,
  servico_interesse_id bigint,
  fora_horario_comercial text,
  etapa_final text,
  transferido_atendente text,
  agendou text,
  data_primeira_consulta date,
  dias_ate_consulta bigint,
  compareceu text,
  virou_paciente text,
  paciente_id bigint,
  constraint f_leads_pkey primary key (lead_id)
);

create table clinica_simulada.f_contratos (
  contrato_id bigint not null,
  paciente_id bigint,
  servico_id bigint,
  forma_pagamento text,
  convenio_id bigint,
  data_inicio date,
  status text,
  data_encerramento date,
  sessoes_previstas bigint,
  sessoes_realizadas bigint,
  faltas_no_contrato bigint,
  dias_para_concluir bigint,
  concluida_no_prazo text,
  sessao_abandono bigint,
  renovacao_de bigint,
  frequencia_semanal bigint,
  meses_permanencia numeric(18,4),
  aluno_em_risco text,
  valor_sessao numeric(18,4),
  valor_contrato numeric(18,4),
  constraint f_contratos_pkey primary key (contrato_id)
);

create table clinica_simulada.f_agendamentos (
  agendamento_id bigint not null,
  paciente_id bigint,
  contrato_id bigint,
  servico_id bigint,
  profissional_id bigint,
  forma_pagamento text,
  convenio_id bigint,
  data date,
  hora bigint,
  dia_semana text,
  turno text,
  data_marcacao date,
  antecedencia_dias bigint,
  canal_marcacao text,
  status text,
  lembrete_enviado text,
  lembrete_confirmado text,
  numero_sessao bigint,
  remarcacao_de bigint,
  primeira_consulta text,
  horario_reaproveitado text,
  valor_sessao numeric(18,4),
  receita_realizada numeric(18,4),
  receita_perdida numeric(18,4),
  valor_vaga_perdida numeric(18,4),
  constraint f_agendamentos_pkey primary key (agendamento_id)
);

create table clinica_simulada.f_capacidade (
  data date not null,
  hora bigint not null,
  profissional_id bigint not null,
  servico_id bigint not null,
  vagas bigint,
  constraint f_capacidade_pkey primary key (data, hora, profissional_id, servico_id)
);

create table clinica_simulada.f_faturamento_convenio (
  contrato_id bigint not null,
  paciente_id bigint,
  convenio_id bigint,
  servico_id bigint,
  status_guia text,
  sessoes_realizadas bigint,
  valor_sessoes_realizadas numeric(18,4),
  status_faturamento text,
  data_envio date,
  data_pagamento date,
  valor_enviado numeric(18,4),
  valor_glosado numeric(18,4),
  valor_pago numeric(18,4),
  constraint f_faturamento_convenio_pkey primary key (contrato_id)
);

create table clinica_simulada.f_investimentos (
  campanha_id bigint not null,
  mes date not null,
  valor numeric(18,4),
  constraint f_investimentos_pkey primary key (campanha_id, mes)
);

create table clinica_simulada.f_recebimentos (
  recebimento_id bigint not null,
  paciente_id bigint,
  contrato_id bigint,
  tipo text,
  competencia date,
  vencimento date,
  valor numeric(18,4),
  data_pagamento date,
  status text,
  dias_atraso bigint,
  constraint f_recebimentos_pkey primary key (recebimento_id)
);

create table clinica_simulada.jornada_contatos (
  wa_id text not null,
  lead_id bigint,
  paciente_id bigint,
  conversation_id uuid not null,
  origem text not null,
  constraint jornada_contatos_pkey primary key (wa_id),
  constraint jornada_contatos_conversation_id_key unique (conversation_id),
  constraint jornada_contatos_lead_id_key unique (lead_id),
  constraint jornada_contatos_origem_check check (origem = any (array['lead_planilha','paciente_sem_lead']))
);

create table clinica_simulada.agendamento_chatbot (
  agendamento_id bigint not null,
  wa_id text not null,
  conversation_id uuid not null,
  dispatch_id uuid not null,
  criterio text not null default 'lembrete_sintetico_por_agendamento',
  constraint agendamento_chatbot_pkey primary key (agendamento_id),
  constraint agendamento_chatbot_conversation_id_key unique (conversation_id),
  constraint agendamento_chatbot_dispatch_id_key unique (dispatch_id)
);

-- ===== Chaves estrangeiras =====

alter table clinica_simulada.conversations add constraint conversations_wa_id_fkey foreign key (wa_id) references clinica_simulada.contacts(wa_id);
alter table clinica_simulada.messages add constraint messages_conversation_id_fkey foreign key (conversation_id) references clinica_simulada.conversations(id);
alter table clinica_simulada.messages add constraint messages_wa_id_fkey foreign key (wa_id) references clinica_simulada.contacts(wa_id);
alter table clinica_simulada.dispatches add constraint dispatches_message_id_fkey foreign key (message_id) references clinica_simulada.messages(id);
alter table clinica_simulada.dispatches add constraint dispatches_template_id_fkey foreign key (template_id) references clinica_simulada.message_templates(id);
alter table clinica_simulada.dispatch_events add constraint dispatch_events_dispatch_id_fkey foreign key (dispatch_id) references clinica_simulada.dispatches(id);
alter table clinica_simulada.d_profissionais add constraint d_profissionais_servico_id_fkey foreign key (servico_id) references clinica_simulada.d_servicos(servico_id);
alter table clinica_simulada.d_campanhas add constraint d_campanhas_servico_foco_id_fkey foreign key (servico_foco_id) references clinica_simulada.d_servicos(servico_id);
alter table clinica_simulada.d_pacientes add constraint d_pacientes_campanha_id_fkey foreign key (campanha_id) references clinica_simulada.d_campanhas(campanha_id);
alter table clinica_simulada.d_pacientes add constraint d_pacientes_lead_id_fkey foreign key (lead_id) references clinica_simulada.f_leads(lead_id);
alter table clinica_simulada.f_leads add constraint f_leads_campanha_id_fkey foreign key (campanha_id) references clinica_simulada.d_campanhas(campanha_id);
alter table clinica_simulada.f_leads add constraint f_leads_paciente_id_fkey foreign key (paciente_id) references clinica_simulada.d_pacientes(paciente_id);
alter table clinica_simulada.f_leads add constraint f_leads_servico_interesse_id_fkey foreign key (servico_interesse_id) references clinica_simulada.d_servicos(servico_id);
alter table clinica_simulada.f_contratos add constraint f_contratos_convenio_id_fkey foreign key (convenio_id) references clinica_simulada.d_convenios(convenio_id);
alter table clinica_simulada.f_contratos add constraint f_contratos_paciente_id_fkey foreign key (paciente_id) references clinica_simulada.d_pacientes(paciente_id);
alter table clinica_simulada.f_contratos add constraint f_contratos_servico_id_fkey foreign key (servico_id) references clinica_simulada.d_servicos(servico_id);
alter table clinica_simulada.f_agendamentos add constraint f_agendamentos_contrato_id_fkey foreign key (contrato_id) references clinica_simulada.f_contratos(contrato_id);
alter table clinica_simulada.f_agendamentos add constraint f_agendamentos_convenio_id_fkey foreign key (convenio_id) references clinica_simulada.d_convenios(convenio_id);
alter table clinica_simulada.f_agendamentos add constraint f_agendamentos_paciente_id_fkey foreign key (paciente_id) references clinica_simulada.d_pacientes(paciente_id);
alter table clinica_simulada.f_agendamentos add constraint f_agendamentos_profissional_id_fkey foreign key (profissional_id) references clinica_simulada.d_profissionais(profissional_id);
alter table clinica_simulada.f_agendamentos add constraint f_agendamentos_remarcacao_de_fkey foreign key (remarcacao_de) references clinica_simulada.f_agendamentos(agendamento_id);
alter table clinica_simulada.f_agendamentos add constraint f_agendamentos_servico_id_fkey foreign key (servico_id) references clinica_simulada.d_servicos(servico_id);
alter table clinica_simulada.f_capacidade add constraint f_capacidade_profissional_id_fkey foreign key (profissional_id) references clinica_simulada.d_profissionais(profissional_id);
alter table clinica_simulada.f_capacidade add constraint f_capacidade_servico_id_fkey foreign key (servico_id) references clinica_simulada.d_servicos(servico_id);
alter table clinica_simulada.f_faturamento_convenio add constraint f_faturamento_convenio_contrato_id_fkey foreign key (contrato_id) references clinica_simulada.f_contratos(contrato_id);
alter table clinica_simulada.f_faturamento_convenio add constraint f_faturamento_convenio_convenio_id_fkey foreign key (convenio_id) references clinica_simulada.d_convenios(convenio_id);
alter table clinica_simulada.f_faturamento_convenio add constraint f_faturamento_convenio_paciente_id_fkey foreign key (paciente_id) references clinica_simulada.d_pacientes(paciente_id);
alter table clinica_simulada.f_faturamento_convenio add constraint f_faturamento_convenio_servico_id_fkey foreign key (servico_id) references clinica_simulada.d_servicos(servico_id);
alter table clinica_simulada.f_investimentos add constraint f_investimentos_campanha_id_fkey foreign key (campanha_id) references clinica_simulada.d_campanhas(campanha_id);
alter table clinica_simulada.f_recebimentos add constraint f_recebimentos_contrato_id_fkey foreign key (contrato_id) references clinica_simulada.f_contratos(contrato_id);
alter table clinica_simulada.f_recebimentos add constraint f_recebimentos_paciente_id_fkey foreign key (paciente_id) references clinica_simulada.d_pacientes(paciente_id);
alter table clinica_simulada.jornada_contatos add constraint jornada_contatos_conversation_id_fkey foreign key (conversation_id) references clinica_simulada.conversations(id);
alter table clinica_simulada.jornada_contatos add constraint jornada_contatos_lead_id_fkey foreign key (lead_id) references clinica_simulada.f_leads(lead_id);
alter table clinica_simulada.jornada_contatos add constraint jornada_contatos_paciente_id_fkey foreign key (paciente_id) references clinica_simulada.d_pacientes(paciente_id);
alter table clinica_simulada.jornada_contatos add constraint jornada_contatos_wa_id_fkey foreign key (wa_id) references clinica_simulada.contacts(wa_id);
alter table clinica_simulada.agendamento_chatbot add constraint agendamento_chatbot_agendamento_id_fkey foreign key (agendamento_id) references clinica_simulada.f_agendamentos(agendamento_id);
alter table clinica_simulada.agendamento_chatbot add constraint agendamento_chatbot_conversation_id_fkey foreign key (conversation_id) references clinica_simulada.conversations(id);
alter table clinica_simulada.agendamento_chatbot add constraint agendamento_chatbot_dispatch_id_fkey foreign key (dispatch_id) references clinica_simulada.dispatches(id);
alter table clinica_simulada.agendamento_chatbot add constraint agendamento_chatbot_wa_id_fkey foreign key (wa_id) references clinica_simulada.contacts(wa_id);

-- ===== Indices secundarios (alem de PK/UNIQUE) =====

create index audit_log_entity_type_entity_id_created_at_idx on clinica_simulada.audit_log using btree (entity_type, entity_id, created_at desc);
create unique index conversations_wa_id_idx on clinica_simulada.conversations using btree (wa_id) where status = 'open' and wa_id is not null;
create index conversations_wa_id_idx1 on clinica_simulada.conversations using btree (wa_id);
create index conversations_wa_id_last_message_at_idx on clinica_simulada.conversations using btree (wa_id, last_message_at desc);
create index d_campanhas_servico_foco_id_idx on clinica_simulada.d_campanhas using btree (servico_foco_id);
create index d_pacientes_campanha_id_idx on clinica_simulada.d_pacientes using btree (campanha_id);
create index d_pacientes_lead_id_idx on clinica_simulada.d_pacientes using btree (lead_id);
create index d_profissionais_servico_id_idx on clinica_simulada.d_profissionais using btree (servico_id);
create index dispatch_events_dispatch_id_occurred_at_idx on clinica_simulada.dispatch_events using btree (dispatch_id, occurred_at desc);
create index dispatch_events_dispatch_id_occurred_at_idx1 on clinica_simulada.dispatch_events using btree (dispatch_id, occurred_at);
create index dispatches_scheduled_for_idx on clinica_simulada.dispatches using btree (scheduled_for) where status = 'scheduled';
create index dispatches_status_idx on clinica_simulada.dispatches using btree (status);
create index f_agendamentos_contrato_id_idx on clinica_simulada.f_agendamentos using btree (contrato_id);
create index f_agendamentos_convenio_id_idx on clinica_simulada.f_agendamentos using btree (convenio_id);
create index f_agendamentos_paciente_id_idx on clinica_simulada.f_agendamentos using btree (paciente_id);
create index f_agendamentos_profissional_id_idx on clinica_simulada.f_agendamentos using btree (profissional_id);
create index f_agendamentos_remarcacao_de_idx on clinica_simulada.f_agendamentos using btree (remarcacao_de);
create index f_agendamentos_servico_id_idx on clinica_simulada.f_agendamentos using btree (servico_id);
create index f_contratos_convenio_id_idx on clinica_simulada.f_contratos using btree (convenio_id);
create index f_contratos_paciente_id_idx on clinica_simulada.f_contratos using btree (paciente_id);
create index f_contratos_servico_id_idx on clinica_simulada.f_contratos using btree (servico_id);
create index f_faturamento_convenio_convenio_id_idx on clinica_simulada.f_faturamento_convenio using btree (convenio_id);
create index f_faturamento_convenio_paciente_id_idx on clinica_simulada.f_faturamento_convenio using btree (paciente_id);
create index f_faturamento_convenio_servico_id_idx on clinica_simulada.f_faturamento_convenio using btree (servico_id);
create index f_leads_campanha_id_idx on clinica_simulada.f_leads using btree (campanha_id);
create index f_leads_paciente_id_idx on clinica_simulada.f_leads using btree (paciente_id);
create index f_leads_servico_interesse_id_idx on clinica_simulada.f_leads using btree (servico_interesse_id);
create index f_recebimentos_contrato_id_idx on clinica_simulada.f_recebimentos using btree (contrato_id);
create index f_recebimentos_paciente_id_idx on clinica_simulada.f_recebimentos using btree (paciente_id);
create index faq_entries_status_idx on clinica_simulada.faq_entries using btree (status);
create index jornada_contatos_paciente_id_idx on clinica_simulada.jornada_contatos using btree (paciente_id);
create index message_templates_status_idx on clinica_simulada.message_templates using btree (status);
create index messages_conversation_id_created_at_idx on clinica_simulada.messages using btree (conversation_id, created_at desc);
create index messages_conversation_id_created_at_idx1 on clinica_simulada.messages using btree (conversation_id, created_at);
create index messages_created_at_idx on clinica_simulada.messages using btree (created_at desc);
create index messages_status_updated_at_idx on clinica_simulada.messages using btree (status_updated_at desc) where status_updated_at is not null;
create index messages_wa_id_created_at_idx on clinica_simulada.messages using btree (wa_id, created_at desc);

-- ===== Views (de pg_get_viewdef; nomes de tabela sem schema foram
-- qualificados: as views de bi_operacional leem public.*) =====

create schema if not exists bi_operacional;
create schema if not exists bi_simulado;

create view bi_operacional.v_conversas_diarias as
 select (opened_at at time zone 'America/Sao_Paulo')::date as data,
    status, current_intent, count(*) as conversas, false as dados_ficticios
   from public.conversations
  group by ((opened_at at time zone 'America/Sao_Paulo')::date), status, current_intent;

create view bi_operacional.v_disparos_diarios as
 select (created_at at time zone 'America/Sao_Paulo')::date as data,
    status, count(*) as disparos, false as dados_ficticios
   from public.dispatches
  group by ((created_at at time zone 'America/Sao_Paulo')::date), status;

create view bi_operacional.v_mensagens_diarias as
 select (created_at at time zone 'America/Sao_Paulo')::date as data,
    direction, sent_via, message_type, status,
    count(*) as mensagens,
    count(*) filter (where error_code is not null) as erros,
    false as dados_ficticios
   from public.messages
  group by ((created_at at time zone 'America/Sao_Paulo')::date), direction, sent_via, message_type, status;

create view bi_simulado.d_calendario as
 select x::date as data,
    extract(year from x)::integer as ano,
    extract(month from x)::integer as mes_num,
    to_char(x, 'YYYY-MM') as ano_mes,
    extract(isodow from x)::integer as dia_semana_num,
    x::date <= '2026-10-21'::date as ate_data_referencia,
    true as dados_ficticios
   from generate_series(least((select min(data_cadastro) from clinica_simulada.d_pacientes), (select min(data_marcacao) from clinica_simulada.f_agendamentos))::timestamp, ((select max(data) from clinica_simulada.f_agendamentos))::timestamp, '1 day'::interval) x(x);

create view bi_simulado.d_campanhas as
 select campanha_id, campanha, canal, servico_foco_id, data_inicio, data_fim, investimento_total, true as dados_ficticios
   from clinica_simulada.d_campanhas s;

create view bi_simulado.d_convenios as
 select convenio_id, convenio, prazo_pagamento_dias, valor_sessao_fisioterapia, valor_sessao_rpg, valor_sessao_pelvica, true as dados_ficticios
   from clinica_simulada.d_convenios s;

create view bi_simulado.d_faq as
 select id, slug, status, reviewed_at, created_at, updated_at, true as dados_ficticios
   from clinica_simulada.faq_entries;

create view bi_simulado.d_pacientes as
 select paciente_id, sexo, faixa_etaria, data_cadastro, origem, canal_origem, campanha_id, lead_id, true as dados_ficticios
   from clinica_simulada.d_pacientes;

create view bi_simulado.d_profissionais as
 select profissional_id, servico_id, true as dados_ficticios
   from clinica_simulada.d_profissionais;

create view bi_simulado.d_servicos as
 select servico_id, servico, vagas_por_horario, duracao_min, true as dados_ficticios
   from clinica_simulada.d_servicos s;

create view bi_simulado.d_templates as
 select id as template_id, name, language, category, status, parameter_count, true as dados_ficticios
   from clinica_simulada.message_templates;

create view bi_simulado.f_agendamentos as
 select agendamento_id, paciente_id, contrato_id, servico_id, profissional_id, forma_pagamento, convenio_id,
    data, hora, dia_semana, turno, data_marcacao, antecedencia_dias, canal_marcacao, status,
    lembrete_enviado, lembrete_confirmado, numero_sessao, remarcacao_de, primeira_consulta,
    horario_reaproveitado, valor_sessao, receita_realizada, receita_perdida, valor_vaga_perdida,
    true as dados_ficticios
   from clinica_simulada.f_agendamentos s;

create view bi_simulado.f_auditoria as
 select id, entity_type, entity_id, action, actor_scope, created_at, true as dados_ficticios
   from clinica_simulada.audit_log;

create view bi_simulado.f_capacidade as
 select data, hora, profissional_id, servico_id, vagas, true as dados_ficticios
   from clinica_simulada.f_capacidade s;

create view bi_simulado.f_contratos as
 select contrato_id, paciente_id, servico_id, forma_pagamento, convenio_id, data_inicio, status,
    data_encerramento, sessoes_previstas, sessoes_realizadas, faltas_no_contrato, dias_para_concluir,
    concluida_no_prazo, sessao_abandono, renovacao_de, frequencia_semanal, meses_permanencia,
    aluno_em_risco, valor_sessao, valor_contrato, true as dados_ficticios
   from clinica_simulada.f_contratos s;

create view bi_simulado.f_conversas as
 select c.id as conversa_id,
    j.lead_id,
    coalesce(j.paciente_id, a.paciente_id) as paciente_id,
    ac.agendamento_id,
    c.status, c.current_intent, c.opened_at, c.last_message_at, c.closed_at,
    (c.opened_at at time zone 'America/Sao_Paulo')::date as data,
    true as dados_ficticios
   from clinica_simulada.conversations c
     left join clinica_simulada.jornada_contatos j on j.conversation_id = c.id
     left join clinica_simulada.agendamento_chatbot ac on ac.conversation_id = c.id
     left join clinica_simulada.f_agendamentos a on a.agendamento_id = ac.agendamento_id;

create view bi_simulado.f_disparos as
 select d.id as disparo_id, d.message_id as mensagem_id, d.template_id, ac.agendamento_id, d.status,
    d.scheduled_for, d.dispatched_at, d.cancelled_at, d.created_at, d.updated_at,
    true as dados_ficticios
   from clinica_simulada.dispatches d
     left join clinica_simulada.agendamento_chatbot ac on ac.dispatch_id = d.id;

create view bi_simulado.f_eventos_disparo as
 select id as evento_id, dispatch_id as disparo_id, event_type, occurred_at, true as dados_ficticios
   from clinica_simulada.dispatch_events;

create view bi_simulado.f_faturamento_convenio as
 select contrato_id, paciente_id, convenio_id, servico_id, status_guia, sessoes_realizadas,
    valor_sessoes_realizadas, status_faturamento, data_envio, data_pagamento, valor_enviado,
    valor_glosado, valor_pago, true as dados_ficticios
   from clinica_simulada.f_faturamento_convenio s;

create view bi_simulado.f_investimentos as
 select campanha_id, mes, valor, true as dados_ficticios
   from clinica_simulada.f_investimentos s;

create view bi_simulado.f_leads as
 select lead_id, data, hora, canal, campanha_id, forma_identificacao, servico_interesse_id,
    fora_horario_comercial, etapa_final, transferido_atendente, agendou, data_primeira_consulta,
    dias_ate_consulta, compareceu, virou_paciente, paciente_id, true as dados_ficticios
   from clinica_simulada.f_leads s;

create view bi_simulado.f_mensagens as
 select id as mensagem_id, conversation_id as conversa_id, direction, sent_via, message_type, status,
    error_code, created_at, status_updated_at,
    (created_at at time zone 'America/Sao_Paulo')::date as data,
    true as dados_ficticios
   from clinica_simulada.messages;

create view bi_simulado.f_recebimentos as
 select recebimento_id, paciente_id, contrato_id, tipo, competencia, vencimento, valor, data_pagamento,
    status, dias_atraso, true as dados_ficticios
   from clinica_simulada.f_recebimentos s;

create view bi_simulado.v_controle_carga as
 select 'planilha'::text as origem,
    '2026-10-21'::date as data_referencia,
    true as dados_ficticios,
    (select count(*) from clinica_simulada.f_leads) as leads,
    (select count(*) from clinica_simulada.d_pacientes) as pacientes,
    (select count(*) from clinica_simulada.f_agendamentos) as agendamentos,
    (select count(*) from clinica_simulada.contacts) as contatos,
    (select count(*) from clinica_simulada.conversations) as conversas,
    (select count(*) from clinica_simulada.messages) as mensagens,
    (select count(*) from clinica_simulada.dispatches) as disparos,
    (select count(*) from clinica_simulada.f_contratos c
      where c.renovacao_de is not null and not exists (select 1 from clinica_simulada.f_contratos p where p.contrato_id = c.renovacao_de)) as renovacoes_sem_origem;

create view bi_simulado.v_financeiro_mensal as
 select date_trunc('month', data::timestamptz)::date as mes, 'receita_sessoes'::text as indicador, sum(receita_realizada) as valor, true as dados_ficticios
   from clinica_simulada.f_agendamentos group by 1
 union all
 select date_trunc('month', data::timestamptz)::date, 'receita_perdida', sum(receita_perdida), true
   from clinica_simulada.f_agendamentos group by 1
 union all
 select date_trunc('month', competencia::timestamptz)::date, 'recebimentos_previstos', sum(valor), true
   from clinica_simulada.f_recebimentos group by 1
 union all
 select date_trunc('month', data_pagamento::timestamptz)::date, 'recebimentos_pagos', sum(valor), true
   from clinica_simulada.f_recebimentos where data_pagamento is not null group by 1
 union all
 select date_trunc('month', data_envio::timestamptz)::date, 'convenio_enviado', sum(valor_enviado), true
   from clinica_simulada.f_faturamento_convenio where data_envio is not null group by 1
 union all
 select date_trunc('month', data_pagamento::timestamptz)::date, 'convenio_pago', sum(valor_pago), true
   from clinica_simulada.f_faturamento_convenio where data_pagamento is not null group by 1;

create view bi_simulado.v_funil_diario as
 select data, canal, campanha_id, servico_interesse_id,
    count(*) as leads,
    count(*) filter (where agendou = 'Sim') as agendaram,
    count(*) filter (where compareceu = 'Sim') as compareceram,
    count(*) filter (where virou_paciente = 'Sim') as converteram,
    count(*) filter (where transferido_atendente = 'Sim') as transferidos,
    true as dados_ficticios
   from clinica_simulada.f_leads
  group by data, canal, campanha_id, servico_interesse_id;

create view bi_simulado.v_jornada_lead as
 with ag as (
   select paciente_id, count(*) as agendamentos, sum(receita_realizada) as receita_sessoes
     from clinica_simulada.f_agendamentos group by paciente_id
 ), ct as (
   select paciente_id, count(*) as contratos from clinica_simulada.f_contratos group by paciente_id
 ), ms as (
   select conversation_id, count(*) as mensagens from clinica_simulada.messages group by conversation_id
 )
 select l.lead_id, l.paciente_id, j.conversation_id as conversa_id, l.data, l.canal, l.campanha_id,
    l.servico_interesse_id, l.etapa_final, l.agendou, l.compareceu, l.virou_paciente, l.transferido_atendente,
    coalesce(ms.mensagens, 0::bigint) as mensagens_conversa,
    coalesce(ag.agendamentos, 0::bigint) as agendamentos_paciente,
    coalesce(ct.contratos, 0::bigint) as contratos_paciente,
    ag.receita_sessoes as receita_sessoes_paciente,
    true as dados_ficticios
   from clinica_simulada.f_leads l
     join clinica_simulada.jornada_contatos j using (lead_id)
     left join ag on ag.paciente_id = l.paciente_id
     left join ct on ct.paciente_id = l.paciente_id
     left join ms on ms.conversation_id = j.conversation_id;

create view bi_simulado.v_mensagens_diarias as
 select (created_at at time zone 'America/Sao_Paulo')::date as data,
    direction, sent_via, message_type, status,
    count(*) as mensagens,
    count(*) filter (where error_code is not null) as erros,
    true as dados_ficticios
   from clinica_simulada.messages
  group by ((created_at at time zone 'America/Sao_Paulo')::date), direction, sent_via, message_type, status;

create view bi_simulado.v_ocupacao as
 with a as (
   select data, hora, profissional_id, servico_id,
      count(*) as agendamentos,
      count(*) filter (where lower(status) not like '%cancel%' and lower(status) not like '%remarc%') as reservas_nao_canceladas
     from clinica_simulada.f_agendamentos
    group by data, hora, profissional_id, servico_id
 ), c as (
   select data, hora, profissional_id, servico_id, sum(vagas) as vagas
     from clinica_simulada.f_capacidade
    group by data, hora, profissional_id, servico_id
 )
 select coalesce(a.data, c.data) as data,
    coalesce(a.hora, c.hora) as hora,
    coalesce(a.profissional_id, c.profissional_id) as profissional_id,
    coalesce(a.servico_id, c.servico_id) as servico_id,
    c.vagas,
    coalesce(a.agendamentos, 0::bigint) as agendamentos,
    coalesce(a.reservas_nao_canceladas, 0::bigint) as reservas_nao_canceladas,
    coalesce(a.reservas_nao_canceladas, 0::bigint)::numeric / nullif(c.vagas, 0::numeric) as ocupacao_reservas,
    c.vagas is null as sem_capacidade_cadastrada,
    true as dados_ficticios
   from a full join c using (data, hora, profissional_id, servico_id);

create view bi_simulado.v_qualidade as
 select 'renovacao_sem_contrato_origem'::text as verificacao, 'aviso_fonte'::text as severidade, count(*) as ocorrencias
   from clinica_simulada.f_contratos c
  where c.renovacao_de is not null and not exists (select 1 from clinica_simulada.f_contratos p where p.contrato_id = c.renovacao_de)
 union all
 select 'lead_sem_jornada', 'erro', count(*)
   from clinica_simulada.f_leads l
  where not exists (select 1 from clinica_simulada.jornada_contatos j where j.lead_id = l.lead_id)
 union all
 select 'paciente_sem_contato', 'erro', count(*)
   from clinica_simulada.d_pacientes p
  where not exists (select 1 from clinica_simulada.jornada_contatos j where j.paciente_id = p.paciente_id)
 union all
 select 'mensagem_sem_conversa', 'erro', count(*)
   from clinica_simulada.messages where messages.conversation_id is null
 union all
 select 'horario_sem_capacidade', 'aviso_fonte', count(*)
   from bi_simulado.v_ocupacao where v_ocupacao.sem_capacidade_cadastrada;

-- v_comparativo_origens une bi_simulado.v_mensagens_diarias (origem
-- 'simulacao') com bi_operacional.v_mensagens_diarias ('operacional').
create view bi_simulado.v_comparativo_origens as
 select 'simulacao'::text as origem, data, direction, sent_via, message_type, status, mensagens, erros, dados_ficticios
   from bi_simulado.v_mensagens_diarias
 union all
 select 'operacional'::text, data, direction, sent_via, message_type, status, mensagens, erros, dados_ficticios
   from bi_operacional.v_mensagens_diarias;
