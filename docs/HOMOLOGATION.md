# Homologação temporária — Vercel + Neon

**Estado em 2026-09-19:** a conta Vercel de homologação foi verificada no plano
Hobby. A instalação da integração Neon está pronta para a confirmação final no
Marketplace, mas ainda não foi aceita nem criou banco, projeto ou cobrança.

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

## Sequência de provisionamento

1. Aceitar a integração Neon no Marketplace da Vercel e criar um banco de
   homologação no plano gratuito. A tela informa que Vercel compartilhará com
   a Neon o ID da Vercel, e-mail e dados de uso; nenhuma credencial deve ser
   copiada para o repositório.
2. Aplicar, no console SQL do Neon e nesta ordem,
   `db/migrations/001_initial_schema.sql` e
   `db/migrations/002_reporting_views.sql`.
3. Configurar somente `DATABASE_URL` como segredo de **Preview** no projeto
   Vercel. A URL não deve ser salva em arquivo versionado ou em documentação.
4. Criar uma publicação de preview do diretório local, sem domínio e sem
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
