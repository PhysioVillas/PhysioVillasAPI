# Snapshot do schema `clinica_simulada` (POC)

`clinica_simulada_schema.sql` e uma **referencia**, nao uma migration: nao esta
em `db/migrations/` e nunca e executado por `npm run migrate`. Foi reconstruido
em 2026-11-18 a partir do catalogo do Neon (projeto `orange-snow-21167535`,
branch `production`), sem copiar nenhuma linha de dados. Contem as 23 tabelas
de `clinica_simulada`, FKs, indices secundarios e as 31 views de `bi_simulado`
(28) e `bi_operacional` (3). Em caso de divergencia, vale o banco real.

## Dominios observados (valores categoricos, 2026-11-18)

| Coluna | Valores |
|---|---|
| `f_agendamentos.status` | `Agendado`, `Cancelado com antecedência`, `Cancelado em cima da hora`, `Falta`, `Realizado` |
| `f_agendamentos.canal_marcacao` | `Chatbot`, `Grade fixa`, `Recepção` |
| `f_agendamentos.turno` | `Manhã`, `Tarde`, `Noite` |
| `f_agendamentos.forma_pagamento` | `Convênio`, `Mensalidade`, `Pacote particular`, `Particular avulso` |
| `f_leads.etapa_final` | `Abandonou na escolha do horário`, `Abandonou na escolha do serviço`, `Abandonou na saudação`, `Agendou pelo chatbot`, `Transferido para atendente` |

Sao valores de texto livre (sem CHECK no banco), com acentos. Em
`conversations`: `status` in (`open`, `closed`, `human_handoff`) e
`current_intent` in (`faq`, `triage`, `scheduling`, `human_handoff`,
`unknown`), ambos com CHECK. `v_ocupacao` ignora status que contenham `cancel`
ou `remarc`.

Marcos de ids em 2026-11-18 (para conferir se algo mudou depois):
`max(f_agendamentos.agendamento_id)` = 30386, `max(d_pacientes.paciente_id)` =
2679, `max(f_leads.lead_id)` = 3024. `f_agendamentos.agendamento_id` e
`bigint` sem default/sequence: o proximo id precisa ser gerado pela aplicacao.

## FKs para `contacts` e `conversations`

Para `clinica_simulada.contacts(wa_id)`:
- `conversations.wa_id` (nullable)
- `messages.wa_id` (nullable)
- `jornada_contatos.wa_id` (PK, not null)
- `agendamento_chatbot.wa_id` (not null)

Para `clinica_simulada.conversations(id)`:
- `messages.conversation_id` (nullable)
- `jornada_contatos.conversation_id` (not null, unique)
- `agendamento_chatbot.conversation_id` (not null, unique)

Outras FKs relevantes: `agendamento_chatbot.agendamento_id` (PK) ->
`f_agendamentos`; `agendamento_chatbot.dispatch_id` -> `dispatches(id)`;
`dispatches.message_id` (unique) -> `messages(id)`; `dispatches.template_id`
-> `message_templates(id)`. Existe um indice unico parcial
`conversations(wa_id) where status = 'open'`: so uma conversa aberta por
contato.

## Nulabilidade de `agendamento_chatbot`

`conversation_id` e `dispatch_id` sao **NOT NULL** e **UNIQUE** (alem de FK).
Hoje sao 28.356 linhas, todas preenchidas. Consequencia para os tickets que
gravam agendamentos do bot: nao da para inserir uma linha em
`agendamento_chatbot` sem conversa e sem disparo; um agendamento do bot sem
lembrete nao pode ser registrado ali (e `bi_simulado.f_conversas`/`f_disparos`
fazem LEFT JOIN nessa tabela). `criterio` e NOT NULL com default
`lembrete_sintetico_por_agendamento`.

## Observacoes

- As views de `bi_operacional` leem `public.*` (as tabelas reais do bot); as de
  `bi_simulado` leem `clinica_simulada.*`. No snapshot os nomes foram
  qualificados.
- `bi_simulado.d_calendario` e view calculada (nao a tabela
  `clinica_simulada.d_calendario`) e a data de referencia `2026-10-21` esta
  fixa nela e em `v_controle_carga`.
- `d_pacientes <-> f_leads` formam um ciclo de FKs; por isso as FKs ficam em
  `ALTER TABLE` no snapshot.
