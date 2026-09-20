# Homologação temporária — Vercel + Neon

**Estado em 2026-09-20:** o projeto `chatmanager-homolog` foi criado no
console Neon no plano Free, na região São Paulo e somente com Postgres ativo.
O schema operacional e a visão de métricas foram aplicados e verificados no
database padrão. Um projeto Vercel separado recebeu uma primeira publicação de
teste, sem domínio próprio, banco configurado, credencial Infobip ou envio de
WhatsApp. A Vercel classifica a primeira publicação de um projeto novo como
`production` por mecânica da plataforma; ela é somente o ambiente isolado de
homologação e não substitui a produção futura.

## Limite do ambiente de teste

O ambiente deve servir exclusivamente para validar a API, o schema e a
persistência. Ele não é produção e não deve receber credenciais que ativem
envio de WhatsApp.

| Item | Preview de homologação | Produção futura |
| --- | --- | --- |
| Vercel | Projeto separado, sem domínio próprio | Projeto revisado e domínio decidido |
| Neon | Banco gratuito e descartável | Banco com retenção, backup e responsável definidos |
| `DATABASE_URL` | Permitida, como segredo de Preview | Segredo de Production |
| `INFOBIP_*` | Não configurar | Configurar somente quando o sender comercial estiver pronto |
| `CHATMANAGER_API_TOKEN` | Não configurar | Segredo exclusivo do backend |
| Webhook Infobip | Não apontar para o preview | Configurar após contrato real e revisão de segurança |

Sem as variáveis da Infobip, `POST /messages/validate` permanece em `503` e
não consegue enviar mensagens. Sem `INFOBIP_WEBHOOK_TOKEN`, o webhook também
permanece em `503`. Esse é o estado desejado para a primeira publicação.

Em 2026-09-20, a mesma configuração foi exercitada localmente antes do
preview: `GET /health` e `GET /docs.json` responderam `200`; `GET
/health/ready` e `POST /messages/validate` responderam `503` sem variáveis de
banco ou Infobip. Isso confirma que uma primeira publicação não envia
mensagens por acidente e só fica pronta para webhook após configurar o banco e
o token correspondente.

A publicação isolada na Vercel foi validada em 2026-09-20 com o mesmo
resultado: `GET /health` retornou `200`, `GET /docs.json` retornou a
especificação OpenAPI e `GET /health/ready` retornou `503` com
`database: not_configured`. Um `POST /messages/validate` retornou `503` por
falta de configuração, portanto não houve chamada à Infobip nem envio.

## Sequência de provisionamento

1. As migrations `001_initial_schema.sql` e `002_reporting_views.sql` foram
   aplicadas manualmente no editor SQL em 2026-09-20 e verificadas por consulta
   de leitura: `public.contacts`, `public.messages` e
   `reporting.daily_message_metrics` existem. Com a URL mantida apenas no
   ambiente, `npm run migrate` continua sendo o caminho reprodutível: ele
   reaplica operações idempotentes, registra checksums e não é disparado no
   deploy.
2. Aplicar também as migrations `003_conversation_catalog.sql` e
   `004_message_delivery_status.sql` antes de configurar o banco no deploy. A
   checagem `/health/ready` exige a coluna de atualização de entrega e falha de
   forma segura até o schema estar completo.
3. Configurar somente `DATABASE_URL` como segredo de **Preview** no projeto
   Vercel. A URL não deve ser salva em arquivo versionado ou em documentação.
4. Criar uma publicação de preview da revisão atual, sem domínio e sem
   promoção para produção. O projeto Express já exporta `src/app.js` como
   aplicação padrão compatível com uma Vercel Function.
5. Validar `GET /health`, `/docs` e `/docs.json`. Validar ainda que as duas
   superfícies com efeito externo continuam desativadas (`503`) antes de
   integrar Infobip.

## Teste real pendente da API-03

O teste que falta não é apenas subir o backend: ele é um envio real pela
Messages API. Para executá-lo com segurança é necessário:

1. Um sender comercial elegível (o sender compartilhado de teste não permite
   modelos próprios e não valida o contrato de produção).
2. Sender, URL base e chave de escopo mínimo configurados **somente** como
   segredos no ambiente de preview, junto de um token interno diferente.
3. Um destinatário de homologação que tenha dado opt-in. Texto livre só é
   permitido dentro da janela ativa de atendimento; fora dela, exige template
   aprovado.
4. Uma autorização específica, no momento do envio, para uma única mensagem
   ao número de teste. Essa ação pode consumir franquia ou ter cobrança da
   Infobip/Meta, portanto nunca será automatizada.
5. Conferência da resposta da API, do `messageId`, do registro no Neon e do
   evento de entrega no webhook antes de considerar `API-03` concluída.

Mensagem de homologação sugerida, quando houver autorização: "Teste técnico de
homologação PhysioVilas. Ignore esta mensagem." Ela não deve conter dados de
paciente, agenda ou conteúdo clínico.
