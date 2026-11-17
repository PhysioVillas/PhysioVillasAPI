-- Tempos observados entre a primeira mensagem ainda sem resposta da equipe
-- e o eco seguinte enviado manualmente pelo WhatsApp Business App.
-- A view expõe somente agregados diários; não inclui conversa, contato ou texto.

create index if not exists whatsapp_flow_events_conversation_response_idx
  on public.whatsapp_flow_events (conversation_id, occurred_at)
  where event_type in ('message_received', 'team_message_sent');

create or replace view reporting.daily_human_response_metrics as
with team_replies as (
  select
    team_message.conversation_id,
    team_message.occurred_at as team_response_at,
    lag(team_message.occurred_at) over (
      partition by team_message.conversation_id
      order by team_message.occurred_at
    ) as previous_team_response_at,
    count(*) over (
      partition by team_message.conversation_id, team_message.occurred_at
    ) = 1 as unique_team_timestamp
  from public.whatsapp_flow_events as team_message
  where event_type = 'team_message_sent'
),
response_intervals as (
  select
    reply.conversation_id,
    reply.team_response_at,
    reply.unique_team_timestamp,
    (
      select min(patient_message.occurred_at)
      from public.whatsapp_flow_events as patient_message
      where patient_message.conversation_id = reply.conversation_id
        and patient_message.event_type = 'message_received'
        and (
          reply.previous_team_response_at is null
          or patient_message.occurred_at > reply.previous_team_response_at
        )
        and patient_message.occurred_at < reply.team_response_at
    ) as first_unanswered_message_at
  from team_replies as reply
)
select
  (team_response_at at time zone 'UTC')::date as activity_date,
  count(*) as response_count,
  avg(extract(epoch from (team_response_at - first_unanswered_message_at)))
    as average_response_seconds,
  percentile_cont(0.5) within group (
    order by extract(epoch from (team_response_at - first_unanswered_message_at))
  ) as median_response_seconds
from response_intervals
where first_unanswered_message_at is not null
  and unique_team_timestamp
group by (team_response_at at time zone 'UTC')::date;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'powerbi_reader') then
    execute 'grant usage on schema reporting to powerbi_reader';
    execute 'grant select on reporting.daily_human_response_metrics to powerbi_reader';
  end if;
end
$$;
