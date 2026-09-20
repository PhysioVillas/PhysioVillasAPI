# Status de Implementação

**Data do registro:** 2026-09-20

## API-01 — concluído localmente

O corte técnico local está concluído: há scaffold Node.js com Express em ESM e
`GET /health`. O registro de validação local informa sucesso para `npm run
check` e `npm test`, com 32/32 testes passando em 2026-09-19.

A documentação interativa está disponível em `/docs`, com a especificação
OpenAPI 3.1 em `/docs.json`. Ela cobre as rotas existentes, incluindo as
respostas de rota desligada e de autorização. Assim, o corte de `API-01` atende
à Definition of Done local; a documentação continuará evoluindo em `API-05`
conforme novas rotas reais forem implementadas.

## Limites da implementação atual

Em 2026-09-18, uma requisição de template pelo sandbox da API WhatsApp dedicada
da Infobip foi aceita com HTTP 200 e a mensagem foi confirmada como recebida no
número verificado do trial. Nenhum identificador, URL base ou credencial foi
registrado. O log do portal não exibiu o registro imediatamente após o envio,
portanto ele não foi usado como prova de entrega.

O teste comprova somente o remetente sandbox e a entrega inicial da plataforma.
Ele não exercita o código deste repositório, nem valida o contrato da Messages
API definido para produção, o webhook, deploy, banco de dados, persistência ou
recepção de eventos.

Uma validação sem envio da Messages API foi tentada após a resposta do usuário
abrir a janela de 24 horas. A chave anterior respondeu HTTP 403; em 2026-09-19
foi criada uma chave de escopo mínimo `messages-api:message:send` e a validação
no endpoint do tenant retornou HTTP 200. Nenhuma mensagem foi enviada nessa
validação. Ainda faltam contrato de template, envio, webhook, deploy e dados.

O cliente local `src/services/infobipMessagesClient.js` agora representa apenas
esse contrato seguro de validação (`validateTextMessage`); ele não possui método
de envio. Seus testes verificam endpoint, payload e propagação de erros sem
fazer chamadas de rede.

## SET-06 — em andamento

A Vercel foi conferida em uma conta Hobby de homologação e o banco Neon
`chatmanager-homolog` foi criado na região São Paulo, no plano Free, somente
com Postgres e sem projeto conectado. Em 2026-09-20, o editor SQL aplicou as
migrations operacionais e a visão de métricas; uma consulta de leitura
confirmou `public.contacts`, `public.messages` e
`reporting.daily_message_metrics`. Não há credenciais Infobip, webhook,
domínio ou envio configurados no ambiente. O plano de configuração sem envio
de WhatsApp e o roteiro de validação estão em `docs/HOMOLOGATION.md`.

A base versionada do banco está em `db/migrations/001_initial_schema.sql`.
Ela cria `contacts` e `messages`, preserva o identificador único da Infobip para
idempotência e separa as origens `api` e `business_app`. As migrations foram
aplicadas uma vez no Neon de homologação, mas ainda não há deploy na Vercel nem
role real do Power BI; essas operações dependem do provisionamento externo.

O módulo `src/services/database.js` já oferece upsert parametrizado de contatos
e inserção idempotente de mensagens, com um pool injetável para testes. Ele não
abre conexão enquanto não for criado com uma `DATABASE_URL` válida, e nenhuma
rota Express o chama antes de o banco ser provisionado.

O comando manual `npm run migrate` aplica as migrations SQL em ordem, registra
o checksum em `schema_migrations` e falha se uma migration já aplicada for
alterada. Ele não integra a partida da API ou o deploy; exige `DATABASE_URL`
somente no momento da execução.

`src/config/runtimeConfig.js` centraliza a leitura das variáveis de ambiente e
valida a porta local. Configurações de banco e Infobip continuam opcionais na
partida. A rota interna `POST /messages/validate` só é ativada com as variáveis
completas da Messages API e `CHATMANAGER_API_TOKEN`; ela chama exclusivamente o
endpoint de validação, nunca o de envio, e exige Bearer token antes de repassar
o texto ou o agendamento ao cliente da Infobip.

O Express também possui respostas JSON estáveis para rota desconhecida e falha
interna, sem incluir detalhes de exceções na resposta HTTP.

O cliente de validação também aceita o campo opcional `sendAt` no payload de
texto. Isso cobre localmente o formato de agendamento da Messages API, mas não
substitui o teste real de entrega agendada nem cria uma rota de envio. A rota
interna de validação repassa esse campo e retorna erros estáveis sem expor
detalhes da resposta da Infobip.

A persistência de uma mensagem de webhook é atômica no código: contato e
mensagem são gravados na mesma transação, com rollback e liberação do cliente
em caso de erro. A rota `POST /webhooks/infobip/inbound` agora recebe o
envelope WhatsApp documentado pela Infobip (`results`), normaliza apenas os
campos necessários e o encaminha à persistência. Eventos que não se enquadram
no contrato atual recebem `202` e não têm o payload bruto armazenado.

O receptor é seguro por padrão: sem `DATABASE_URL` e
`INFOBIP_WEBHOOK_TOKEN`, responde `503`; com token ausente ou incorreto,
responde `401` antes de tocar no banco. A rota ainda não está acessível pela
Infobip e não foi configurada nenhuma subscription, URL externa ou envio. A
captura de um payload real do tenant e a escolha do mecanismo de autenticação
compatível com a subscription continuam pendentes.

## Observação da avaliação Infobip

No módulo observado em 2026-09-18, a avaliação tinha 58 dias restantes e o
saldo era US$0. Havia um sender de teste ativo/conectado e não havia profiles
nem subscriptions. Identificadores, URL base e credenciais não são registrados
no repositório.

## AUT-01 a AUT-04 — em preparação

O inventário de modelos da conta foi revisado em 2026-09-19: uma busca pelo
nome do projeto não encontrou modelo correspondente. O pacote local
`docs/INFOBIP_AUTOMATIONS.md` agora registra os templates propostos, limites de
triagem/FAQ, o menu 1–4 derivado dos protótipos anteriores e roteiros de
aceite. A adaptação remove a coleta automática de dados clínicos e não trata os
dados institucionais antigos como informação operacional aprovada. Não foram
criados templates, fluxos, envios ou subscriptions na plataforma. A tentativa
de registrar um modelo encontrou o sender de teste conectado, mas nenhum
remetente elegível no seletor de modelos; essa incompatibilidade foi registrada
como bloqueio, sem criar um sender adicional.

## Evidências e pendências

`docs/INFOBIP_RULES.md` consolida a evidência versionada disponível e os limites
do trial. Payloads, segurança do webhook e contratos de template permanecem
pendentes para a implementação. Essas lacunas não invalidam os estados
históricos de `SET-01` a `SET-04`, preservados em `docs/BACKLOG.md`.
