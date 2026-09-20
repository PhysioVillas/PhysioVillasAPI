-- PhysioVilas ChatManager: contexto operacional de conversas e catálogos.
-- Não armazene anamnese, queixas, diagnósticos, agenda clínica ou payloads brutos.

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  wa_id text references contacts(wa_id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'closed', 'human_handoff')),
  current_intent text not null default 'unknown'
    check (current_intent in ('faq', 'triage', 'scheduling', 'human_handoff', 'unknown')),
  opened_at timestamptz not null default now(),
  last_message_at timestamptz,
  closed_at timestamptz
);

alter table messages
  add column if not exists conversation_id uuid
    references conversations(id) on delete set null;

create index if not exists conversations_wa_id_last_message_at_idx
  on conversations (wa_id, last_message_at desc);

create index if not exists messages_conversation_id_created_at_idx
  on messages (conversation_id, created_at desc);

-- Catálogo de metadados de templates. Parâmetros preenchidos por pacientes
-- nunca pertencem a esta tabela.
create table if not exists message_templates (
  id uuid primary key default gen_random_uuid(),
  provider_template_id text unique,
  name text not null,
  language text not null,
  category text,
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'rejected', 'disabled')),
  parameter_count integer not null default 0 check (parameter_count >= 0),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, language)
);

-- Base editorial para respostas administrativas. Não use para orientação
-- clínica individual, diagnóstico ou conteúdo sensível de pacientes.
create table if not exists faq_entries (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  question text not null,
  answer text not null,
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists message_templates_status_idx
  on message_templates (status);

create index if not exists faq_entries_status_idx
  on faq_entries (status);
