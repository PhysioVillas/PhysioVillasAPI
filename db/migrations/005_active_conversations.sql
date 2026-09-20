-- PhysioVilas ChatManager: uma conversa operacional aberta por contato.
-- A conversa agrupa eventos sem coletar conteúdo clínico ou de triagem.

create unique index if not exists conversations_one_open_per_contact_idx
  on conversations (wa_id)
  where status = 'open' and wa_id is not null;
