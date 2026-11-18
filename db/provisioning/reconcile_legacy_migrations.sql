-- Reconcilia o ledger somente para o schema legado já existente no Neon.
-- Execute uma única vez, como proprietário, no branch/database correto.
-- Este arquivo NÃO aplica 009. Depois execute `npm run migrate` em ambiente
-- confiável com DATABASE_URL; o runner aplica 009 e registra o hash real.
-- Se qualquer precondição falhar, a transação aborta sem gravar o ledger.

begin;

do $$
declare
  expected_public_tables text[] := array[
    'audit_log', 'contacts', 'conversations', 'dispatch_events', 'dispatches',
    'faq_entries', 'message_templates', 'messages', 'whatsapp_flow_events'
  ];
  expected_reporting_views text[] := array[
    'daily_human_response_metrics', 'daily_message_metrics',
    'daily_whatsapp_flow_metrics'
  ];
  actual_names text[];
  expected_columns text[];
  actual_columns text[];
  object_name text;
begin
  if to_regclass('public.schema_migrations') is not null then
    raise exception 'schema_migrations already exists; stop and inspect its rows';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    raise exception 'pgcrypto extension is missing';
  end if;

  select array_agg(c.relname order by c.relname collate "C") into actual_names
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p');
  if actual_names is distinct from expected_public_tables then
    raise exception 'public table inventory differs from audited baseline: %', actual_names;
  end if;

  select array_agg(c.relname order by c.relname collate "C") into actual_names
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'reporting' and c.relkind in ('v', 'm');
  if actual_names is distinct from expected_reporting_views then
    raise exception 'reporting view inventory differs from audited baseline: %', actual_names;
  end if;

  foreach object_name in array array['dispatches', 'dispatch_events', 'audit_log'] loop
    if to_regclass(format('public.%I', object_name)) is null then
      raise exception 'required legacy table is missing: %', object_name;
    end if;
  end loop;

  select array_agg(column_name order by column_name collate "C") into actual_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'dispatches';
  expected_columns := array[
    'cancelled_at', 'created_at', 'dispatched_at', 'id', 'message_id',
    'scheduled_for', 'status', 'template_id', 'updated_at'
  ];
  if actual_columns is distinct from expected_columns then
    raise exception 'dispatches columns differ from migration 006: %', actual_columns;
  end if;

  select array_agg(column_name order by column_name collate "C") into actual_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'dispatch_events';
  expected_columns := array['detail', 'dispatch_id', 'event_type', 'id', 'occurred_at'];
  if actual_columns is distinct from expected_columns then
    raise exception 'dispatch_events columns differ from migration 006: %', actual_columns;
  end if;

  select array_agg(column_name order by column_name collate "C") into actual_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'audit_log';
  expected_columns := array['action', 'actor_scope', 'created_at', 'entity_id', 'entity_type', 'id'];
  if actual_columns is distinct from expected_columns then
    raise exception 'audit_log columns differ from migration 006: %', actual_columns;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages'
      and column_name = 'purge_after' and data_type = 'timestamp with time zone'
  ) then
    raise exception 'messages.purge_after from migration 006 is missing or has a different type';
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'reporting') and c.relname like 'appointment_%'
  ) then
    raise exception 'appointment objects already exist; inspect before reconciling';
  end if;
end;
$$;

create table public.schema_migrations (
  file_name text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

insert into public.schema_migrations (file_name, checksum) values
  ('001_initial_schema.sql', '1df0ba03b53f9d4a368cbe05782e92d2c011a86e605d80c4474c189b947e0c24'),
  ('002_reporting_views.sql', '59c3d1f80bd8bf99442b8b5c6129ccd7b78c4073776ae5cb3ff539264f458a08'),
  ('003_conversation_catalog.sql', 'ada6ce1567e9a8b28a208c27552121a12f4834e0102ea7fa521e1fc3f1b88681'),
  ('004_message_delivery_status.sql', 'e466ed4e5a5f49b1304ceaebb4c5b084ca6a92b2a3c77013f8f4153b4eedb100'),
  ('005_active_conversations.sql', '2423af81534e360d579fb8dc8df99fb189acd0f25b095d2ef8c0073b559f8b39'),
  ('006_operational_lifecycle.sql', '944d5c0ce00a453cc834513ec4923785832f292dbe28e47a934d2e3258981b36'),
  ('007_whatsapp_flow_reporting.sql', 'f03d578587ae1b2d07cb5d00add5abf5aecb841f63c79740b6d6cc16ce1fac7c'),
  ('008_human_response_reporting.sql', '289c734d31c7d2da76f1c5c7fcd233d7cfaf850cbb630a2d8fd716dfdc69f52d');

commit;
