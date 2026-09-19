-- PhysioVilas ChatManager: schema inicial para Neon/PostgreSQL.
-- Execute com o usuário proprietário do banco antes de habilitar webhooks.

create extension if not exists pgcrypto;

create table if not exists contacts (
  wa_id text primary key,
  profile_name text,
  last_message_at timestamptz
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  infobip_message_id text unique,
  wa_id text references contacts(wa_id) on delete set null,
  direction text not null check (direction in ('in', 'out')),
  sent_via text check (sent_via in ('api', 'business_app')),
  body text,
  message_type text,
  status text,
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists messages_wa_id_created_at_idx
  on messages (wa_id, created_at desc);

create index if not exists messages_created_at_idx
  on messages (created_at desc);
