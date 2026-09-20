-- PhysioVilas ChatManager: instante da última atualização de entrega.
-- O conteúdo do webhook, preço e demais campos não mapeados não são retidos.

alter table messages
  add column if not exists status_updated_at timestamptz;

create index if not exists messages_status_updated_at_idx
  on messages (status_updated_at desc)
  where status_updated_at is not null;
