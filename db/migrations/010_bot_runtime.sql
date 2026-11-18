-- Estado de execucao do chatbot da POC: configuracao, estado da conversa e handoffs.
-- Dados mock; sem texto de mensagem nem CPF nestas tabelas.

create table if not exists bot_config (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);

create table if not exists conversation_state (
  wa_id text primary key references public.contacts(wa_id) on delete cascade,
  flow text not null,
  step text not null,
  context jsonb not null default '{}'::jsonb,
  cpf_attempts smallint not null default 0,
  misunderstood_count smallint not null default 0,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists conversation_state_expires_at_idx
  on conversation_state (expires_at);

-- wa_id sem FK de proposito: o handoff deve ser registrado mesmo se o contato
-- ainda nao existir ou for removido; o historico serve ao BI.
create table if not exists handoffs (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null,
  reason text not null
    check (reason in (
      'patient_request',
      'payment',
      'clinical_or_urgency',
      'late_change',
      'bot_failure',
      'identity_failure',
      'document_request'
    )),
  in_business_hours boolean not null,
  requested_at timestamptz not null default now(),
  first_team_reply_at timestamptz,
  closed_at timestamptz
);

-- No maximo um handoff aberto por contato.
create unique index if not exists handoffs_one_open_per_wa_id_idx
  on handoffs (wa_id) where closed_at is null;

create index if not exists handoffs_requested_at_idx
  on handoffs (requested_at);

insert into bot_config (key, value, description)
values
  ('timezone', '"America/Bahia"'::jsonb, 'Fuso horario da clinica'),
  ('reschedule_min_notice_hours', '24'::jsonb, 'Antecedencia minima (h) para remarcar'),
  ('cancel_min_notice_hours', '24'::jsonb, 'Antecedencia minima (h) para cancelar'),
  ('human_support_hours', '{"start":"08:00","end":"18:00","days":[0,1,2,3,4,5,6]}'::jsonb, 'Horario de atendimento humano (days: 0=domingo)'),
  ('message_retention_days', 'null'::jsonb, 'Retencao de mensagens em dias; null = ilimitada (POC)'),
  ('booking_horizon_days', '21'::jsonb, 'Quantos dias a frente o paciente pode agendar'),
  ('conversation_step_timeout_minutes', '30'::jsonb, 'Expiracao do estado de conversa (min)'),
  ('handoff_silence_hours', '12'::jsonb, 'Silencio do bot apos handoff (h)'),
  ('cpf_max_attempts', '3'::jsonb, 'Tentativas de CPF antes do handoff'),
  ('max_misunderstood_replies', '3'::jsonb, 'Entradas nao entendidas antes do handoff'),
  ('reminder_hours_before', '[24,4]'::jsonb, 'Lembretes (h antes da consulta)')
on conflict (key) do nothing;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'powerbi_reader') then
    execute 'grant select on public.handoffs to powerbi_reader';
  end if;
end
$$;
