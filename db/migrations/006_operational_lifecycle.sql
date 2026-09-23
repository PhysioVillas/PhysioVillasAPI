-- PhysioVilas ChatManager: ciclo de vida operacional dos despachos de mensagem.
-- Nao armazene conteudo de mensagem, payload bruto da Infobip, preco ou
-- dados de paciente nesta migration -- apenas estado e auditoria do envio.
--
-- NOTA: esta versao foi reconstruida a partir da descricao documentada em
-- docs/IMPLEMENTATION_STATUS.md e docs/BACKLOG.md (a versao original ficou
-- apenas na maquina local e foi descartada). Confirme o codigo de
-- src/services/database.js (prepareOutboundDispatch) contra este schema
-- antes de reaplicar em outro ambiente.

create table if not exists dispatches (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  template_id uuid references message_templates(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'scheduled', 'sent', 'failed', 'cancelled')),
  scheduled_for timestamptz,
  dispatched_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id)
);

create index if not exists dispatches_status_idx
  on dispatches (status);

create index if not exists dispatches_scheduled_for_idx
  on dispatches (scheduled_for)
  where status = 'scheduled';

-- Trilha de transicoes de estado do despacho. Guarda so o tipo de evento e
-- um detalhe curto -- nunca o payload bruto do provedor nem conteudo clinico.
create table if not exists dispatch_events (
  id uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null references dispatches(id) on delete cascade,
  event_type text not null
    check (event_type in ('created', 'scheduled', 'sent', 'failed', 'cancelled')),
  detail text,
  occurred_at timestamptz not null default now()
);

create index if not exists dispatch_events_dispatch_id_occurred_at_idx
  on dispatch_events (dispatch_id, occurred_at desc);

-- Auditoria operacional generica. actor_scope referencia os papeis de
-- src/services/accessPolicy.js (operational/managerial/executive), nunca
-- um identificador de pessoa.
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_scope text,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_entity_idx
  on audit_log (entity_type, entity_id, created_at desc);

-- Retencao: campo preparado para uma futura rotina de expurgo. O prazo em
-- si (quantos meses reter) ainda precisa ser definido pela equipe/orientador
-- e nao e assumido por esta migration.
alter table messages
  add column if not exists purge_after timestamptz;

