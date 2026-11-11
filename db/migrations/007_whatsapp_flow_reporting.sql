-- Eventos agregaveis do fluxo de WhatsApp para BI.
-- Nao guardar identificadores do contato, texto, payloads ou dados clinicos.

create table if not exists whatsapp_flow_events (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  event_type text not null
    check (event_type in (
      'message_received',
      'flow_option_selected',
      'bot_step_sent',
      'team_message_sent'
    )),
  step_key text,
  source text not null
    check (source in ('patient', 'bot', 'team')),
  occurred_at timestamptz not null,
  check (
    (event_type = 'message_received' and source = 'patient' and step_key is null) or
    (event_type = 'flow_option_selected' and source = 'patient' and step_key in (
      'menu_agendar', 'menu_paciente_novo', 'menu_atendente',
      'faq_horarios', 'faq_convenios', 'faq_localizacao', 'faq_servicos',
      'btn_voltar_menu', 'btn_atendente'
    )) or
    (event_type = 'bot_step_sent' and source = 'bot' and step_key in ('faq_menu', 'faq_answer', 'faq_handoff')) or
    (event_type = 'team_message_sent' and source = 'team' and step_key is null)
  ),
  unique (message_id, event_type)
);

create index if not exists whatsapp_flow_events_occurred_at_idx
  on whatsapp_flow_events (occurred_at, event_type, step_key);

create or replace view reporting.daily_whatsapp_flow_metrics as
select
  (occurred_at at time zone 'UTC')::date as activity_date,
  event_type,
  step_key,
  source,
  count(*) as event_count,
  count(distinct conversation_id) as conversation_count
from public.whatsapp_flow_events
group by
  (occurred_at at time zone 'UTC')::date,
  event_type,
  step_key,
  source;

-- If the separately provisioned reporting role exists, let it read this view
-- without granting it access to the operational events table.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'powerbi_reader') then
    execute 'grant usage on schema reporting to powerbi_reader';
    execute 'grant select on reporting.daily_whatsapp_flow_metrics to powerbi_reader';
  end if;
end
$$;
