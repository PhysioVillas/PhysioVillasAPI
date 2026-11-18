-- Views de relatorio do bot (T18). Somente acrescenta views; nunca renomear
-- nem remover colunas (contrato com o Power BI). Dia sempre em America/Bahia.
-- Sem identificadores de contato, texto ou payloads.

-- Motor do bot (T17): bot_step_sent passa a aceitar step_key '<fluxo>:<passo>'
-- alem das chaves faq_* legadas. Demais tipos de evento ficam como em 007.
alter table public.whatsapp_flow_events
  drop constraint if exists whatsapp_flow_events_check;
alter table public.whatsapp_flow_events
  add constraint whatsapp_flow_events_check check (
    (event_type = 'message_received' and source = 'patient' and step_key is null) or
    (event_type = 'flow_option_selected' and source = 'patient' and step_key in (
      'menu_agendar', 'menu_paciente_novo', 'menu_atendente',
      'faq_horarios', 'faq_convenios', 'faq_localizacao', 'faq_servicos',
      'btn_voltar_menu', 'btn_atendente'
    )) or
    (event_type = 'bot_step_sent' and source = 'bot' and (
      step_key in ('faq_menu', 'faq_answer', 'faq_handoff') or
      step_key ~ '^[a-z_]+:[a-z0-9_|:-]+$'
    )) or
    (event_type = 'team_message_sent' and source = 'team' and step_key is null)
  );

-- Funil: quantas vezes cada passo '<fluxo>:<passo>' foi enviado pelo bot por dia.
create or replace view reporting.bot_funnel_daily as
select
  (occurred_at at time zone 'America/Bahia')::date as activity_date,
  step_key,
  count(*) as step_count,
  count(distinct conversation_id) as conversation_count
from public.whatsapp_flow_events
where event_type = 'bot_step_sent'
  and step_key is not null
group by
  (occurred_at at time zone 'America/Bahia')::date,
  step_key;

-- Handoffs por dia de solicitacao, motivo e horario de atendimento.
-- median_minutes_to_first_reply considera so handoffs com resposta da equipe.
create or replace view reporting.bot_handoffs_daily as
select
  (requested_at at time zone 'America/Bahia')::date as activity_date,
  reason,
  in_business_hours,
  count(*) as handoff_count,
  count(first_team_reply_at) as replied_count,
  (percentile_cont(0.5) within group (
    order by extract(epoch from (first_team_reply_at - requested_at)) / 60.0
  ) filter (where first_team_reply_at is not null))::numeric(12, 2)
    as median_minutes_to_first_reply
from public.handoffs
group by
  (requested_at at time zone 'America/Bahia')::date,
  reason,
  in_business_hours;

-- Acoes do chatbot na agenda (audit_log). Em banco sem clinica_simulada
-- (preview) a view existe com as mesmas colunas e zero linhas.
do $$
begin
  if to_regnamespace('clinica_simulada') is not null then
    execute $view$
      create or replace view reporting.bot_appointment_actions_daily as
      select
        (created_at at time zone 'America/Bahia')::date as activity_date,
        action,
        count(*) as action_count
      from clinica_simulada.audit_log
      where entity_type = 'agendamento'
        and actor_scope = 'chatbot'
        and action in ('booked', 'rescheduled', 'cancelled')
      group by (created_at at time zone 'America/Bahia')::date, action
    $view$;
  else
    execute $view$
      create or replace view reporting.bot_appointment_actions_daily as
      select
        null::date as activity_date,
        null::text as action,
        null::bigint as action_count
      where false
    $view$;
  end if;
end
$$;

-- Autoatendimento: conversa (dia de abertura) com handoff quando existe um
-- handoff do mesmo wa_id com requested_at entre opened_at e closed_at da
-- conversa (sem closed_at, qualquer handoff posterior a opened_at conta).
create or replace view reporting.bot_self_service_rate_daily as
with classified as (
  select
    (c.opened_at at time zone 'America/Bahia')::date as activity_date,
    exists (
      select 1
      from public.handoffs as h
      where h.wa_id = c.wa_id
        and h.requested_at >= c.opened_at
        and (c.closed_at is null or h.requested_at <= c.closed_at)
    ) as had_handoff
  from public.conversations as c
)
select
  activity_date,
  count(*) as conversation_count,
  count(*) filter (where had_handoff) as handoff_conversation_count,
  count(*) filter (where not had_handoff) as self_service_conversation_count,
  (count(*) filter (where not had_handoff))::numeric
    / nullif(count(*), 0) as self_service_rate
from classified
group by activity_date;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'powerbi_reader') then
    execute 'grant usage on schema reporting to powerbi_reader';
    execute 'grant select on reporting.bot_funnel_daily to powerbi_reader';
    execute 'grant select on reporting.bot_handoffs_daily to powerbi_reader';
    execute 'grant select on reporting.bot_appointment_actions_daily to powerbi_reader';
    execute 'grant select on reporting.bot_self_service_rate_daily to powerbi_reader';
  end if;
end
$$;
