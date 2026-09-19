# Product Requirements Document (PRD)

## Projeto: PhysioVilas ChatManager — Backend de Integração WhatsApp

**Autor:** Davi Serra Passos
**Cliente:** Clínica PhysioVilas
**Última revisão:** 2026-09-19
**Status:** Reestruturação em andamento — este documento é a fonte única de
verdade (produto + técnica) para a arquitetura Infobip + Neon

---

## Atualização de implementação — 2026-09-18

`API-01` está concluído localmente: há scaffold Node.js/Express em ESM,
`GET /health`, documentação interativa em `/docs` e especificação OpenAPI em
`/docs.json`. O registro de validação local em 2026-09-19 informa `npm run
check` e `npm test` aprovados, com 27/27 testes passando.

Em 2026-09-18, um template sandbox pela API WhatsApp dedicada da Infobip foi
aceito com HTTP 200 e confirmado como recebido no número verificado do trial.
Esse é um teste de plataforma isolado: não testa o backend deste repositório
nem valida a Messages API escolhida para produção. Não houve deploy, banco de
dados ou webhook nesta etapa. A avaliação observada na Infobip tinha 58 dias
restantes, saldo de US$0, sender de teste ativo/conectado e nenhum profile ou
subscription no módulo observado. Nenhum identificador de conta, sender, URL
base ou segredo é registrado neste documento.

`docs/INFOBIP_RULES.md` registra a evidência do sandbox e as lacunas restantes
para payloads, segurança de webhook e contratos da Messages API. Os estados
históricos de `SET-01` a `SET-04` permanecem preservados no backlog.

A validação sem entrega da Messages API foi testada com a chave atual em
2026-09-18 e respondeu HTTP 403. Isso bloqueia o teste do contrato unificado
até existir uma chave com o escopo `messages-api:message:send`; não houve envio
ou consumo de franquia nessa tentativa.

---

## 1. Visão Geral e Objetivo

O ChatManager é o **elo de dados** entre o WhatsApp da clínica PhysioVilas e o
Power BI. Ele não atende o paciente, não decide o que responder e não
apresenta nenhuma tela: essas responsabilidades ficam com a **Infobip**
(canal WhatsApp, FAQ/bot, templates) e com o **Power BI** (consulta e
dashboards).

O que o backend faz, e apenas isso:

1. **Recebe** eventos de mensagem/status da Infobip via webhook e persiste no
   Neon.
2. **Envia** mensagens e templates para pacientes, sob demanda, chamando a
   API da Infobip.

Duas capacidades adicionais são essenciais para a clínica e fazem parte do
escopo central (detalhes técnicos na seção 4.1 e 4.2 abaixo):

- **Coexistência com o WhatsApp Business App** — a clínica mantém o app do
  celular funcionando no mesmo número usado pela API. Isso substitui o antigo
  aviso "Adeus ao Celular" das versões anteriores deste PRD: com a
  coexistência habilitada pela Infobip, a equipe não perde a possibilidade de
  atender pelo aparelho físico.
- **Agendamento de mensagens** (ex: lembrete de consulta) — programar envio
  para um horário futuro. Mecanismo confirmado: campo `sendAt` na Messages
  API da Infobip, usada para todo envio (texto, template e agendado). Detalhes
  de payload de template e do webhook de entrada ainda em validação — ver
  pendência `SET-05` no backlog.

Não há UI, não há login, não há lógica de atendimento no código deste
repositório.

---

## 2. Por que essa mudança (contexto para quem ler depois)

O projeto começou como uma aplicação completa (Meta Cloud API → depois
avaliou-se Twilio → Next.js + painel de atendimento + Supabase). Essa linha
foi descartada porque:

- **Infobip concentra canal, FAQ e templates na própria plataforma** — não faz
  sentido reconstruir bot/FAQ/painel de configuração no código quando a
  plataforma já oferece isso.
- **Sem painel de atendimento**, não há necessidade de tempo real
  (Socket.io/Realtime) nem de autenticação de equipe.
- **A leitura dos dados é feita pelo Power BI**, conectando direto no Postgres
  (Neon) — não precisa de rotas de API para listar conversas/mensagens.
- **Neon** substitui Supabase como banco Postgres gerenciado; não usamos
  nenhum outro recurso do Supabase (Auth, Realtime, Storage) nem do Neon além
  do Postgres em si.

---

## 3. Escopo

### O que ESTÁ no escopo

- Endpoint de webhook que recebe eventos da Infobip (mensagens recebidas,
  atualizações de status de entrega, ecos de coexistência do WhatsApp
  Business App e sincronização de histórico) e grava no Neon.
- Endpoint(s) de envio (texto livre e template) que chamam a Messages API da
  Infobip, incluindo agendamento via `sendAt`.
- Schema do banco no Neon, desenhado para ser consumido depois pelo Power BI.
- Documentação (`/docs`, Swagger) das rotas existentes.

### O que NÃO ESTÁ no escopo (feito fora deste repositório)

- Frontend, painel de atendimento, qualquer UI.
- Autenticação/login.
- FAQ, fluxo de bot, triagem, menus — tudo isso é configurado na plataforma
  Infobip.
- Endpoints de leitura/consulta (`GET /conversations`, `GET /messages`) — a
  leitura é feita pelo Power BI direto no Neon.

---

## 4. Arquitetura

```
Paciente (WhatsApp)
      │
      ▼
  Infobip (canal, FAQ/bot, templates)
      │
      ├── POST webhook ──►  Backend (Node/Express, serverless na Vercel)
      │                          │
      │                          └─ valida/parseia evento ─► grava no Neon
      │
      └── API de envio  ◄──  Backend chama a Infobip para enviar mensagem/template

Power BI ──── conexão Postgres direta ────► Neon
```

| Camada         | Tecnologia                                                       |
| -------------- | ---------------------------------------------------------------- |
| Backend        | Node.js + Express, empacotado como função serverless na Vercel |
| Canal WhatsApp | Infobip (WhatsApp API / Conversations)                           |
| Persistência  | Neon (Postgres gerenciado)                                       |
| Consulta/BI    | Power BI, conectado direto ao Neon via Postgres                  |
| Autenticação | Nenhuma (fora de escopo)                                         |
| Frontend       | Nenhum (fora de escopo)                                          |

### 4.1 Decisões tomadas

| Tema | Decisão |
|---|---|
| Provedor WhatsApp | **Infobip** (conta e canal já configurados) |
| API de envio da Infobip | **Messages API** (`POST /messages-api/1/messages`, formato `channel`/`destinations`/`content`) para **todo envio** — texto, template e agendado. Ver seção 4.4. |
| Hospedagem do backend | **Vercel**, como Serverless Functions (sem Next.js — só a API) |
| Tempo real (Socket.io) | Removido — não há painel para atualizar |
| FAQ / bot / triagem | Removidos do código — configurados na Infobip |

### 4.2 Rotas do backend

| Rota | Responsabilidade |
|---|---|
| `POST /webhooks/infobip/inbound` | Recebe o envelope de entrada documentado da Infobip e, quando banco e token estão configurados, persiste mensagem conhecida no Neon |
| `POST /messages/validate` | Valida texto livre e `sendAt` na Messages API, sem enviar mensagem; exige token interno e configuração completa |
| `GET /health` | Health check |
| `GET /docs` e `GET /docs.json` | Documentação Swagger UI e especificação OpenAPI das rotas existentes |

Uma única rota de envio cobre texto, template e agendamento — o campo
`sendAt` (presente ou ausente no corpo da requisição) decide se o envio é
imediato ou programado; não há uma rota `/messages/schedule` separada.

### 4.3 Coexistência WhatsApp Business App + API

Confirmado via documentação pública
(`infobip.com/docs/whatsapp/manage-integration/coexistence`,
setembro/2026):

- Permite manter o app WhatsApp Business ativo no celular no mesmo número
  conectado à API da Infobip, sincronizado via webhook. Só números **já
  ativos no app** podem ser habilitados (não há caminho inverso).
- **Onboarding:** via Embedded Signup com
  `featureType: "whatsapp_business_app_onboarding"`, ou pelo console Infobip
  (Channels and Numbers → WhatsApp → "Connect a number from your WhatsApp
  Business app").
- **Sincronização:** só via webhook. Mensagem enviada pelo celular chega como
  evento **`smb_message_echoes`** — formato exato do payload confirmado
  contra a conta real em `SET-04` (ver `docs/INFOBIP_RULES.md`).
- **Limites confirmados:** WhatsApp Business App 2.24.17+; não disponível
  para Nigéria/África do Sul; 1 número por WABA de coexistência; máximo 4
  WABAs de coexistência por portfólio; throughput máximo 20 msg/s.
- **Impacto no parser do webhook (`API-02`):** precisa reconhecer esses
  payloads desde o início — a clínica só migra **com** coexistência
  habilitada. Um eco de coexistência é uma mensagem `out` que não passou por
  `POST /messages`, por isso o schema tem a coluna `sent_via` (seção 5).

### 4.4 Agendamento de mensagens

A rota inicialmente cogitada (`POST /whatsapp/1/events`, canal WhatsApp
dedicado) **não é** de agendamento — confirmado via OpenAPI público que ela
só aceita `TYPING_INDICATOR`. **Não usar essa rota.**

O mecanismo real, confirmado com um payload de exemplo verificado contra a
conta/documentação da Infobip, é a **Messages API omnichannel**:

```
POST /messages-api/1/messages
```

```json
{
  "messages": [
    {
      "channel": "WHATSAPP",
      "sender": "<sender configurado>",
      "destinations": [
        { "to": "5511999999999" }
      ],
      "content": {
        "body": {
          "text": "Olá! Esta mensagem foi agendada via Messages API.",
          "type": "TEXT"
        }
      },
      "sendAt": "2026-09-10T14:00:00.000Z"
    }
  ]
}
```

`destinations[].to` é o número do destinatário; `sendAt`
(`yyyy-MM-dd'T'HH:mm:ss.SSSZ`) é opcional — presente agenda, ausente envia
imediatamente. Esta é a **única API de envio usada no backend**; não há
cliente separado para o canal WhatsApp dedicado (`/whatsapp/1/message/*`) nem
uso do endpoint `POST /omni/1/advanced` (mais antigo, cenário de failover
pré-configurado, não relacionado).

O que ainda falta confirmar contra a conta real antes de `API-03`/`API-04`
(checklist completo em `SET-05`, `docs/BACKLOG.md`): formato exato de
`content` para template, se o webhook de entrada da Messages API usa o mesmo
formato do canal dedicado, se há `messageId` por destinatário para
idempotência, e o limite de `sendAt` específico para WhatsApp (180 dias é o
limite documentado para outros canais como SMS).

---

## 5. Modelo de dados

Como o Power BI lê direto das tabelas, o **schema do banco é uma interface
pública**: renomear uma coluna ou tabela sem avisar quem mantém os relatórios
quebra o dashboard silenciosamente.

```sql
create table contacts (
  wa_id            text primary key,      -- formato exato: a confirmar (SET-01)
  profile_name     text,
  last_message_at  timestamptz
);

create table messages (
  id               uuid primary key default gen_random_uuid(),
  infobip_message_id text unique,         -- idempotência: reenvio do webhook não duplica
  wa_id            text references contacts(wa_id),
  direction        text not null check (direction in ('in', 'out')),
  sent_via         text,                  -- api|business_app|null (in) — de onde veio uma msg 'out'
  body             text,
  message_type     text,                  -- text|image|audio|video|...
  status           text,                  -- sent|delivered|read|failed
  error_code       text,
  created_at       timestamptz not null default now()
);
```

- `infobip_message_id` único evita duplicar mensagem em reentrega de webhook.
- `created_at` sempre `timestamptz`/UTC — conversão de fuso acontece no Power
  BI, nunca no banco.
- `sent_via` existe por causa da coexistência (seção 4.3): distingue
  atendimento manual (`business_app`) de automação (`api`) nos relatórios.

**Papel somente-leitura para o Power BI** — não apontar o Power BI para o
mesmo usuário que o backend usa para escrever:

```sql
create role powerbi_reader with login password '...';
grant connect on database <db> to powerbi_reader;
grant usage on schema public to powerbi_reader;
grant select on all tables in schema public to powerbi_reader;
alter default privileges in schema public grant select on tables to powerbi_reader;
```

**Conexão Power BI ↔ Neon:** conector nativo "PostgreSQL database"
(`ep-xxxx.<region>.aws.neon.tech`, porta `5432`, SSL obrigatório), usando o
role `powerbi_reader`. Import é suficiente para o volume esperado. Se
publicado no serviço Power BI (não só Desktop), verificar necessidade de
On-premises Data Gateway para refresh agendado — documentar a decisão
(refresh manual vs. gateway) antes da entrega final.

---

## 6. Variáveis de ambiente

```
# Infobip
INFOBIP_BASE_URL=          # URL base configurada fora do repositório
INFOBIP_API_KEY=
INFOBIP_WHATSAPP_SENDER=   # número remetente configurado no canal

# Token estático para proteger chamadas ao backend e webhooks
CHATMANAGER_API_TOKEN=
INFOBIP_WEBHOOK_TOKEN=

# Neon
DATABASE_URL=              # connection string com sslmode=require

# App
PORT=
```

Saem de cena: todas as `META_*`, `FRONTEND_URL` (sem frontend, sem CORS entre
origens), tudo relacionado a Supabase/Twilio.

---

## 7. Riscos e pendências

- **Formato do `wa_id`/número na Infobip** não confirmado — não assumir
  semelhança com o formato da Meta (sem `+`, sem 9º dígito) até checar um
  payload real (`SET-01`).
- **Mecanismo de segurança do webhook da Infobip** pode não ser HMAC —
  confirmar antes de codar a validação.
- **Payload de coexistência** (`smb_message_echoes`, sincronização de
  histórico) não é documentado publicamente — bloqueia o parser completo até
  testar contra a conta real (seção 4.3).
- **Webhook de entrada da Messages API pode diferir do canal WhatsApp
  dedicado** — se o formato de inbound for diferente, o parser do `API-02`
  precisa suportar dois formatos até isso ser testado (seção 4.4).
- **On-premises Data Gateway** para refresh agendado no Power BI Service pode
  ser inviável dependendo do contexto — decidir cedo se o refresh será manual.
- **Neon free tier**: confirmar limites de storage/compute e comportamento de
  auto-suspend (cold start após inatividade).

---

## 8. Backlog de Desenvolvimento

Tickets organizados por atividade (`AT1`–`AT4`: Setup/Infobip, Backend +
gestão de projeto, Automações/coexistência, Entrega) vivem em
`docs/BACKLOG.md`.
