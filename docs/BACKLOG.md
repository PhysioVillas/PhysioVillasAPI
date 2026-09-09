# Backlog do Projeto — PhysioVilas ChatManager

**Última atualização:** 2026-09-09
**Escopo deste documento:** reestruturação para **Infobip + Neon**, backend
enxuto sem frontend, sem bot próprio, sem autenticação. Detalhamento técnico
completo em `PRD_PhysioVilas_WhatsApp.md`.

Estrutura seguida a partir desta atualização: **cronograma da Entrega 2**
definido pela gestão de projeto, organizado em 4 atividades (`AT1`–`AT4`).
Dentro de cada atividade, os tickets mantêm os prefixos técnicos já usados
neste backlog (`SET`/`DB`/`API`/`AUT`/`PM`/`DOC`).

> **Nota sobre IDs duplicados no cronograma original:** o cronograma da
> gestão reaproveita os códigos `SET-04` e `SET-05` em pontos diferentes
> (uma vez em `AT1`, outra em `AT2`/`AT3`) para assuntos distintos. Para
> evitar ambiguidade neste documento técnico, esses IDs foram renumerados
> abaixo — cada ticket abaixo carrega uma nota `(cronograma: ...)` apontando
> o item correspondente na lista original da gestão.

---

## Como este backlog funciona

**Frentes de trabalho** (prefixo do ID):

| Prefixo | Frente | O que cobre |
|---|---|---|
| `SET` | Setup & Infra | Infobip, Neon, deploy na Vercel |
| `DB`  | Banco de Dados | Schema no Neon, roles de acesso |
| `API` | Backend | Webhook, envio de mensagens, health check |
| `AUT` | Automações | Templates e fluxos configurados na Infobip (aprovação, coexistência ativa) |
| `PM`  | Gestão de Projeto | Jira, sprints, cards |
| `BI`  | Power BI | Conexão e relatórios sobre o Neon |
| `DOC` | Documentação | Documentos entregáveis |

**Marcadores:** 🔴 bloqueia outros tickets · 🟡 exige pesquisa/confirmação
antes de codar

**Definição de Pronto (vale para todo ticket):**

1. Critérios de aceite satisfeitos e testados manualmente.
2. `node --check` sem erros nos arquivos alterados (sem build/bundler no projeto).
3. Nenhum segredo commitado; variável nova documentada em `.env.example`.
4. Se cria ou altera rota: bloco `@openapi` atualizado e visível em `/docs`.

---

## Ordem de ataque

```
AT1 — Setup inicial e integração com a Infobip
   SET-01 ──► SET-02 ──► SET-03 ──► SET-04 (coexistência, confirmação) ──► SET-05 (templates) ──► DOC-01

AT2 — Backend de mensageria e gestão do projeto
   PM-01 ──► PM-02 ──► PM-03           (gestão, em paralelo ao backend)
   API-01 ──► API-02 ──► API-03 ──► API-04 (agendamento) ──► API-05 (Swagger)
   SET-06 — banco provisório + publicação na Vercel (DB-01/DB-02 + SET-02/SET-03 de infra)

AT3 — Automações de atendimento e coexistência
   AUT-01 (templates aprovados) ──► AUT-02 (triagem) ──► AUT-03 (FAQ) ──► AUT-04 (lembretes)
   SET-07 — ativar coexistência API + WhatsApp Business App em produção

AT4 — Entrega do Pacote 2
   DOC-02, DOC-03, homologação final
```

---

## AT1 — Setup inicial e integração com a Infobip

### SET-01 — Obter número de teste na Infobip (sandbox WhatsApp) — ✅ 100%

- [x] Número de teste/sandbox WhatsApp obtido na Infobip

### SET-02 — Configuração inicial da conta/canal (API key, base URL, sender) — ✅ 100%

- [x] `INFOBIP_BASE_URL` e `INFOBIP_API_KEY` obtidos e guardados fora do repo
- [x] Sender/canal WhatsApp configurado na conta

### SET-03 — Teste inicial de envio de mensagem via API — ✅ 100%

- [x] Endpoint e payload de envio de texto livre confirmados contra a conta real

### SET-04 — Confirmar rota e fluxo de coexistência com WhatsApp Web (`smb_message_echoes`) — ✅ 100%

*(cronograma: `AT1 / SET-04`)*

Feature essencial: a clínica só migra se puder manter o app do celular
funcionando no mesmo número. Já confirmado via documentação pública
(`PRD_PhysioVilas_WhatsApp.md` seção 4.3) que a Infobip suporta isso via
Embedded Signup.

- [x] Onboarding de coexistência testado na conta real (Embedded Signup com
      `featureType: whatsapp_business_app_onboarding`, ou fluxo pelo console)
- [x] Payload real do webhook `smb_message_echoes` capturado (mensagem
      enviada pelo celular gera esse evento)
- [x] Campo discriminador identificado — como diferenciar, no mesmo endpoint
      de webhook, entre mensagem recebida normal / status / eco de
      coexistência / chunk de histórico
- [x] Achados incorporados em `docs/INFOBIP_RULES.md` (consolidar em `DOC-01`)

### SET-05 — Teste inicial do uso de templates — ⬜ 0%

*(cronograma: `AT1 / SET-05`. Corresponde ao antigo ticket "validar payload
de agendamento"; a validação de `sendAt`/agendamento foi movida para `API-04`
em `AT2`, já que depende do backend existir.)*

- [ ] Ao menos um template aprovado enviado com sucesso via API contra a conta real
- [ ] Formato exato de `content` para envio de **template** via Messages API
      confirmado (pesquisa prévia encontrou exemplos inconsistentes, nenhum
      confirmado)
- [ ] Confirmado se a resposta de `POST /messages-api/1/messages` retorna um
      `messageId` por item de `destinations` (uso futuro: `infobip_message_id`
      para idempotência em `DB-01`)
- [ ] Confirmado formato de erro da Messages API (número inválido, fora da
      janela de 24h, template rejeitado)
- [ ] Achados incorporados em `docs/INFOBIP_RULES.md`

- **Depende de:** SET-01, SET-02, SET-03
- **Bloqueia:** API-03 (formato de template no envio)

### DOC-01 — Documentar regras de integração da Infobip (`docs/INFOBIP_RULES.md`) — ⬜ 0%

- [ ] Documenta os achados de `SET-01`, `SET-04`, `SET-05`, no mesmo espírito
      do antigo `META_CLOUD_API_RULES.md`
- [ ] Payload real de webhook de mensagem recebida
- [ ] Payload de atualização de status (`DELIVERED`/`READ`/`FAILED`)
- [ ] Formato do identificador do remetente (`wa_id`/número: com ou sem `+`,
      com ou sem 9º dígito) — **não presumir formato Meta**, verificar contra
      payload real
- [ ] Mecanismo de segurança do webhook (assinatura, IP allowlist, Basic Auth,
      ou nenhum)
- [ ] Como a Infobip sinaliza erro de janela de 24h
- [ ] Cada regra marcada como confirmada (com link pro código, quando
      aplicável) ou pendente

- **Depende de:** SET-01, SET-04, SET-05

---

## AT2 — Backend de mensageria e gestão do projeto

### PM-01 — Criar projeto no Jira e importar a estrutura do backlog — ⬜ 0%

- [ ] Projeto criado no Jira
- [ ] Tickets deste backlog (`SET`/`DB`/`API`/`AUT`/`DOC`) importados como issues

### PM-02 — Planejar sprints (mapear tarefas em ciclos com datas) — ⬜ 0%

- [ ] Tickets de `AT2`–`AT4` distribuídos em sprints com datas
- **Depende de:** PM-01

### PM-03 — Criar cards por ticket com critérios de conclusão e dependências — ⬜ 0%

- [ ] Cada card no Jira reflete os critérios de aceite e dependências já
      descritos neste backlog
- **Depende de:** PM-01, PM-02

### API-01 — Estruturação da base do backend com rota de verificação de funcionamento — ⬜ 0%

- [ ] Express mínimo, ESM (`"type": "module"`), sem Socket.io
- [ ] `src/index.js`, `src/routes/`, `src/services/`
- [ ] `GET /health` funcionando
- [ ] `.env.example` novo, sem nenhuma variável `META_*`/`TWILIO_*`/`SUPABASE_*`

- **Depende de:** SET-01

### SET-06 — Banco de dados provisório e publicação na Vercel — ⬜ 0%

*(cronograma: `AT2 / SET-04` — reaproveita o código `SET-04` para "banco
provisório + Vercel", diferente do `SET-04` de coexistência em `AT1`.
Renumerado aqui para `SET-06` para evitar ambiguidade. Cobre o schema no
Neon e o deploy do backend.)*

- [ ] Projeto criado no Neon (via integração Vercel ou console próprio)
- [ ] `DATABASE_URL` com `sslmode=require` documentada em `.env.example`
- [ ] Comportamento de auto-suspend do free tier confirmado (latência após inatividade)
- [ ] Tabela `contacts` (`wa_id`, `profile_name`, `last_message_at`)
- [ ] Tabela `messages` (`id`, `infobip_message_id` único, `wa_id`, `direction`, `sent_via`, `body`, `message_type`, `status`, `error_code`, `created_at`)
- [ ] `infobip_message_id` único garante idempotência em reentrega de webhook
- [ ] `sent_via` (`api`/`business_app`) distingue mensagem enviada pelo backend
      de eco de coexistência do celular
- [ ] Todas as datas em `timestamptz`/UTC
- [ ] Migration versionada no repo (SQL puro)
- [ ] Role `powerbi_reader` criado, somente leitura (`grant select` +
      `default privileges` para tabelas futuras)
- [ ] Backend Express empacotado como função serverless na Vercel (sem Next.js)
- [ ] Variáveis de ambiente configuradas em Production e Preview
- [ ] Deploy automático a cada push na `main`

- **Depende de:** SET-01, DOC-01 (formato do `wa_id`)
- **Bloqueia:** API-02, BI-01

### API-02 — Recepção e gravação de status/eventos da Infobip (Webhooks) — ⬜ 0%

- [ ] Validação conforme mecanismo definido em `DOC-01`
- [ ] Parser do payload real da Infobip → `Message`/`Contact`
- [ ] Upsert de contato + insert idempotente de mensagem (por `infobip_message_id`)
- [ ] Reconhece e trata o eco de coexistência `smb_message_echoes` (`SET-04`),
      gravando com `direction: 'out'`, `sent_via: 'business_app'`
- [ ] Reconhece eventos de sincronização de histórico sem quebrar o parser em
      payloads não mapeados ainda
- [ ] Confirma se o inbound da **Messages API** (usada em `API-03` para envio)
      chega no mesmo formato do canal WhatsApp dedicado ou exige um segundo
      formato de parser
- [ ] Responde rápido (200 imediato), processamento não bloqueia a resposta
- [ ] Payload desconhecido não derruba a rota — loga e segue
- [ ] Bloco `@openapi` documentado

- **Depende de:** SET-06, API-01, SET-04, SET-05

### API-03 — Rotas para envio de mensagens de texto e templates — ⬜ 0%

Ambas as rotas chamam o mesmo cliente da **Messages API**
(`POST /messages-api/1/messages`) — não o canal WhatsApp dedicado. Ver
`PRD_PhysioVilas_WhatsApp.md` seção 4.4.

- [ ] Envio de texto livre via Messages API (`channel: "WHATSAPP"`, `content.body`)
- [ ] Envio de template via Messages API — formato de `content` confirmado em `SET-05`
- [ ] Erros da Infobip propagados com `status`/`details`
- [ ] Mensagem enviada é gravada em `messages` com `direction: 'out'`, `sent_via: 'api'`
- [ ] Bloco `@openapi` documentado

- **Depende de:** SET-06, API-01, SET-05

### API-04 — Funcionalidade de agendamento de envios futuros — ⬜ 0%

Mecanismo confirmado (Messages API + `sendAt`, seção 4.2 do plano) — mesmo
endpoint de `API-03`, com o campo `sendAt` preenchido. Não é uma rota
separada `/messages/schedule`.

- [ ] Campo `sendAt` opcional aceito nas rotas de `API-03` (envio imediato se ausente)
- [ ] `sendAt` testado de ponta a ponta contra a conta real (mensagem chega no horário agendado)
- [ ] `messageId` de retorno usado como `infobip_message_id` para idempotência
- [ ] Confirmado limite de `sendAt` para WhatsApp especificamente (180 dias é
      o limite documentado para outros canais, ex: SMS — não confirmado ainda
      para WhatsApp)
- [ ] Erros e limites de janela (tempo mínimo/máximo no futuro) tratados
- [ ] Bloco `@openapi` atualizado com o parâmetro `sendAt`

- **Depende de:** API-03

### API-05 — Documentação interativa das APIs (Swagger) — ⬜ 0%

- [ ] Swagger UI servido em `/docs`, spec em `/docs.json`
- [ ] `info.description` explicando o formato do `wa_id` confirmado em `DOC-01`

- **Depende de:** API-02, API-03

---

## AT3 — Automações de atendimento e coexistência

> Fluxos de bot/FAQ/triagem **não são código neste repositório** — são
> configurados na plataforma Infobip. Os tickets abaixo cobrem a configuração
> na plataforma e a validação de que os fluxos funcionam, não implementação
> de backend.

### AUT-01 — Aprovar todos os templates na Infobip — ⬜ 0%

- [ ] Todos os templates necessários (lembrete de consulta, confirmações, etc.) submetidos para aprovação
- [ ] Todos aprovados pela Meta/Infobip

### AUT-02 — Concluir fluxo de triagem (menu de atendimento) — ⬜ 0%

- [ ] Menu de triagem configurado na plataforma Infobip
- [ ] Testado ponta a ponta com número real

- **Depende de:** AUT-01

### AUT-03 — Concluir fluxo de FAQ (Perguntas Frequentes) — ⬜ 0%

- [ ] Fluxo de FAQ configurado na plataforma Infobip
- [ ] Testado ponta a ponta com número real

- **Depende de:** AUT-01

### AUT-04 — Concluir sistema de lembrete de consultas — ⬜ 0%

- [ ] Lembrete de consulta usando template aprovado (`AUT-01`) + agendamento (`API-04`)
- [ ] Testado ponta a ponta (envio agendado chega no horário certo)

- **Depende de:** AUT-01, API-04

### SET-07 — Ativar coexistência API + WhatsApp Business App — ⬜ 0%

*(cronograma: `AT3 / SET-05` — reaproveita o código `SET-05` para "ativar
coexistência em produção", diferente do `SET-05` de "teste de templates" em
`AT1`. Renumerado aqui para `SET-07` para evitar ambiguidade.)*

- [ ] Coexistência ativada em produção na conta real (não apenas testada em sandbox, ver `SET-04`)
- [ ] Confirmado que o app do celular continua funcionando normalmente após o
      onboarding (throughput de 20 msg/s é o limite documentado)
- [ ] Equipe da clínica orientada sobre o funcionamento

- **Depende de:** SET-04, API-02 (webhook já tratando `smb_message_echoes` em produção)

---

## AT4 — Entrega do Pacote 2

> Aguardando detalhamento da gestão de projeto sobre os critérios finais de
> entrega. Preencher conforme definido.

### DOC-02 — Atualizar `CLAUDE.md`

- [ ] Reescrever para refletir a arquitetura Infobip + Neon + Vercel serverless
- [ ] Remover toda referência a Meta Cloud API, Socket.io, Twilio, Supabase, Next.js

- **Depende de:** API-01 a API-05 (arquitetura estabilizada)

### DOC-03 — Atualizar `README.md`

- [ ] Comandos, variáveis de ambiente e arquitetura atuais
- [ ] Removida qualquer instrução do backend antigo

- **Depende de:** DOC-02

---

## Frente BI — Power BI (fora da numeração AT, corre em paralelo)

### BI-01 — Conexão do Power BI ao Neon — ⬜ 0%

- [ ] Conector nativo "PostgreSQL database" configurado com `powerbi_reader`
- [ ] SSL habilitado na conexão
- [ ] Decidido e documentado: refresh manual (Desktop) vs. gateway (Service)
- [ ] Ao menos um relatório básico validando a conexão (ex: volume de mensagens por dia)

- **Depende de:** SET-06, API-02 (precisa haver dados reais fluindo)

---

## Itens descartados nesta reestruturação

Registrados para rastreabilidade — não serão feitos.

| Item | Motivo |
|---|---|
| Frontend Next.js / landing page / painel de atendimento | Fora de escopo: Infobip cobre canal/FAQ, Power BI cobre consulta |
| Fluxo de bot, FAQ, triagem no código | Configurado na plataforma Infobip (ver `AT3`) |
| Autenticação / login / RLS | Sem usuários no escopo atual |
| Socket.io / tempo real | Sem painel para atualizar |
| Supabase (Auth, Realtime, Postgres) | Substituído por Neon (só Postgres) |
| Twilio | Substituído por Infobip |
| `GET /conversations`, `GET /messages` | Leitura é feita pelo Power BI direto no Neon |
| Rota `POST /whatsapp/1/events` como mecanismo de agendamento | Confirmado (OpenAPI público) que essa rota é só `TYPING_INDICATOR`, não agendamento |
| Endpoint `POST /omni/1/advanced` como API de envio unificada | Endpoint mais antigo, de cenário de failover pré-configurado no painel — não relacionado à Messages API (`POST /messages-api/1/messages`) confirmada e usada neste projeto |
| Cliente separado para o canal WhatsApp dedicado (`/whatsapp/1/message/*`) | Decisão: unificar todo envio (texto, template, agendado) na Messages API omnichannel — ver `PRD_PhysioVilas_WhatsApp.md` seção 4.4 |
