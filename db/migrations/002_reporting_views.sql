-- Camada de leitura para BI.
-- Esta migração não expõe conteúdo de mensagens nem dados identificáveis.

create schema if not exists reporting;

create or replace view reporting.daily_message_metrics as
select
  (created_at at time zone 'UTC')::date as activity_date,
  direction,
  coalesce(sent_via, 'unknown') as sent_via,
  coalesce(message_type, 'unknown') as message_type,
  coalesce(status, 'unknown') as status,
  count(*) as message_count,
  count(*) filter (where error_code is not null) as error_count
from public.messages
group by
  (created_at at time zone 'UTC')::date,
  direction,
  coalesce(sent_via, 'unknown'),
  coalesce(message_type, 'unknown'),
  coalesce(status, 'unknown');
