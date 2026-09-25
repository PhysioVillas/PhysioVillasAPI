# Regras de Integração Infobip — evidências vigentes

**Última atualização:** 2026-09-25

Este documento separa fatos observados na conta de teste das decisões de
produção. Não registra chaves, URLs de conta, números de telefone, remetentes
ou identificadores de mensagem.

## Evidência: template sandbox entregue

Em 2026-09-18, foi executada uma única requisição de template pelo sandbox da
API WhatsApp dedicada da Infobip. A API aceitou a requisição com HTTP 200 e o
destinatário verificado confirmou o recebimento no WhatsApp.

O teste comprova que o sender compartilhado do trial e o template de teste da
plataforma conseguem iniciar uma conversa com o número verificado. O console
de Logs não apresentou um registro imediatamente após o envio; por isso a
confirmação de recebimento, e não a tela de Logs, é a evidência de entrega
deste teste.

## Limites do que foi validado

- O endpoint exercitado foi o da API WhatsApp dedicada de sandbox, não a
  Messages API (`POST /messages-api/1/messages`) escolhida para o backend de
  produção.
- Nenhum endpoint deste repositório participou do envio.
- Não houve deploy, webhook, banco de dados, persistência ou recebimento de
  evento validados.
- O trial restringe o envio ao destinatário verificado e à franquia exibida no
  console. Não adicionar saldo é requisito para preservar o ambiente sem custo.

## Validação da Messages API sem envio

Após a resposta do usuário abrir a janela de 24 horas, foi montado um payload
de texto livre para WhatsApp e enviado somente ao endpoint de validação da
Messages API. Nenhuma mensagem foi entregue nessa operação.

Em 2026-09-18, a chave anterior respondeu HTTP 403 no endpoint do tenant. Em
2026-09-19, após criar a chave de escopo mínimo, o mesmo contrato retornou HTTP
200 em `POST /messages-api/1/messages/validate`. Isso confirma que a chave e o
payload de texto livre são aceitos pela Messages API; não comprova envio,
entrega, webhooks, persistência ou o formato de templates.

A rota `POST /resource-management/1/messages/validate`, indicada na
documentação pública consultada, respondeu HTTP 404 neste tenant. Para esta
conta, a validação efetiva é a rota `messages-api` acima.

## Criação da chave de menor privilégio

Em 2026-09-18, a solicitação para deixar uma chave sem expiração não foi aceita
pela interface ("Data inválida") e não criou nenhuma credencial. Em 2026-09-19,
com autorização do responsável, foi criada uma chave com o único escopo
`messages-api:message:send`, sem restrição de IP e com validade de um ano. Ela
foi armazenada exclusivamente no arquivo local ignorado `.env`; seu valor,
nome, URL de conta, remetente e destinatário não são versionados nem registrados
neste documento.

O prazo de validade deve ser revisto e rotacionado antes do vencimento. A chave
não recebeu escopos de administração e não foi usada para disparar mensagens.

## Janela de atendimento e cobrança a partir de outubro de 2026

A janela de atendimento de 24 horas continua sendo a regra que permite
respostas livres depois de uma mensagem do usuário; fora dela, somente
templates aprovados podem iniciar ou retomar a conversa. A política oficial do
WhatsApp permanece a fonte para essa regra.

Para produção, a referência de preço muda em 01/10/2026: mensagens de serviço
(respostas livres dentro da janela) e templates de utilidade enviados dentro da
janela passam a ser tarifados por mensagem entregue. O sandbox não deve ser
usado para estimar essa cobrança: ele tem franquia própria e saldo zerado. Antes
de produção, confirmar a tabela vigente da Infobip para o país de cada
destinatário e registrar no backend a categoria e a quantidade de mensagens
enviadas.

Fontes consultadas: [política do WhatsApp Business](https://whatsappbusiness.com/policy/),
[documentação Infobip sobre janela](https://www.infobip.com/docs/whatsapp/manage-integration)
e [aviso de preço de provedor](https://help.twilio.com/articles/53100480177819).

Para a autorização da Messages API, ver
[escopos de chaves da Infobip](https://www.infobip.com/docs/essentials/api-essentials/api-authorization).
Para expiração e rotação, ver [autenticação por chave de API](https://www.infobip.com/docs/essentials/api-essentials/api-authentication)
e [gestão de chaves com escopo](https://www.infobip.com/docs/cpaas-x/security/manage-api-keys).

## Contrato público de relatórios — conferido em 2026-09-20

A documentação oficial da Infobip confirma que a Messages API pode apontar
webhooks de entrega e leitura por mensagem, e que também há subscriptions de
canal para eventos. Para relatórios de entrega WhatsApp, `messageId` é o
identificador de correlação e o exemplo público contém `doneAt` e
`status.name`. O backend já guarda somente esses campos necessários (além do
erro mapeado), ignora preço e payload bruto e não deixa um evento com `doneAt`
anterior reverter o status mais recente.

Essa evidência confirma o contrato local de relatórios, mas não cria webhook,
subscription ou `notifyURL`: essas configurações continuam pendentes do
remetente/WABA real e de uma URL pública protegida. A documentação pública
consultada ainda não oferece um payload reproduzível para os ecos de
coexistência `smb_message_echoes`; esse parser continua condicionado a uma
captura autorizada na conta da clínica.

Fontes oficiais: [Messages API — envio e webhooks por mensagem](https://www.infobip.com/docs/messages-api/send-a-message),
[webhooks de relatórios](https://www.infobip.com/docs/reporting/webhooks),
[exemplo de relatório de entrega WhatsApp](https://www.infobip.com/docs/whatsapp/manage-integration/usernames-and-user-ids)
e [eventos disponíveis em subscriptions](https://www.infobip.com/docs/subscriptions/available-events).

## Contrato público de templates da Messages API — conferido em 2026-09-20

O exemplo atual da [referência de tipos de mensagem](https://www.infobip.com/docs/messages-api/message-types)
para template WhatsApp confirma o contrato usado pelo backend: `channel` igual
a `WHATSAPP`, `sender`, `destinations[].to`, `template.templateName`,
`template.language` e `content.body` com `type: "TEXT"` e parâmetros nas
posições numéricas `1`, `2` e assim por diante. O teste local compara o payload
inteiro com esse formato e a rota continua apontando somente para
`/messages-api/1/messages/validate`.

Isso elimina a incerteza documental de formato, mas não prova a existência de
um template PhysioVilas aprovado, a resposta de envio do tenant ou a entrega.
Nenhum template foi criado, validado com dados reais ou enviado nesta revisão.

## Evidência: eco de coexistência `smb_message_echoes` — capturado em 2026-09-25

Em 2026-09-25, com a coexistência ativa no número de produção, uma mensagem
enviada pelo WhatsApp Business App no celular vinculado chegou ao
`POST /webhooks/infobip/inbound` e foi capturada pela rota temporária
`GET /webhooks/infobip/debug-log`. Payload observado, com identificadores e
números substituídos por marcadores:

```json
{
  "entry": [{
    "id": "<waba_id>",
    "changes": [{
      "value": {
        "messagingProduct": "whatsapp",
        "metadata": {
          "displayPhoneNumber": "<numero_da_clinica>",
          "phoneNumberId": "<phone_number_id>"
        },
        "contacts": [{ "waId": "<wa_id_paciente>", "userId": "<user_id>" }],
        "messageEchoes": [{
          "from": "<numero_da_clinica>",
          "to": "<wa_id_paciente>",
          "id": "wamid.<id>",
          "toUserId": "<user_id>",
          "timestamp": "<epoch_em_segundos>",
          "text": { "body": "<texto>" },
          "type": "text"
        }]
      },
      "field": "smb_message_echoes"
    }]
  }]
}
```

Estrutura confirmada:

- O envelope é `entry[].changes[].value` (estilo Graph API da Meta), diferente
  do `results[]` nativo da Infobip usado por inbound e relatórios de entrega.
- O discriminador é `changes[].field === "smb_message_echoes"`. Um mesmo POST
  pode trazer vários `entry`, `changes` e `messageEchoes`.
- `messageEchoes[].from` é o número da clínica e `.to` é o paciente.
- `id` vem no formato `wamid.*` e é usado como `infobip_message_id`
  (idempotência por `on conflict do nothing`).
- `timestamp` é uma string de epoch em segundos, não ISO 8601.
- Não há nome de perfil nem status de entrega: é um eco de envio.
- Existem `contacts[].userId` e `messageEchoes[].toUserId` (formato
  `BR.<digitos>`); o schema atual não os armazena e nenhuma coluna foi criada.

Implementação: `src/services/infobipWebhookNormalizer.js` detecta
`payload.entry` antes do ramo `results[]` e devolve cada eco em
`inboundMessages` com `direction: 'out'`, `sentVia: 'business_app'`,
`status: 'sent'`, `waId` igual a `to` sem normalização e `createdAt`
convertido do epoch. O router persiste pelo mesmo
`database.persistWebhookMessage` já usado pelo inbound. Outros `field` dentro
de `entry[].changes[]` (por exemplo, sincronização de histórico) são contados
como `ignored` e respondidos com 202. A cobertura está em
`test/infobipWebhooks.test.js`.

Como a subscription real oferece apenas Básico, Hmac e OAuth (e não o Bearer
interno), foi decidido em 2026-09-25 manter temporariamente
`allowUnauthenticatedInbound` ativo em produção: a rota aceita webhooks sem
autenticação até a definição do mecanismo permanente na próxima sprint.

### Limites do que foi validado

- Somente eco do tipo `text` foi observado; outros tipos são aceitos com
  `body` nulo, mas seus campos específicos não foram capturados.
- **Divergência do nono dígito (pendente):** o `waId` do paciente veio sem o
  nono dígito no eco de coexistência, enquanto o mesmo paciente apareceu com o
  nono dígito em outro log de inbound. O backend grava os dois exatamente como
  recebidos, o que pode gerar dois contatos para o mesmo paciente. Não há
  normalização até haver evidência de qual formato a Infobip usa de forma
  consistente.
- Eventos de sincronização de histórico continuam sem payload capturado.
- O eco foi recebido pela subscription configurada; não confirma se o inbound
  da Messages API usa o mesmo envelope.

## Matriz de rastreabilidade

| Regra | Estado | Evidência e implementação |
| --- | --- | --- |
| Template sandbox do trial | Confirmado somente no sandbox | Recebimento confirmado em 2026-09-18; não equivale ao contrato comercial da Messages API. |
| Template WhatsApp pela Messages API | Confirmado documentalmente | `src/services/infobipMessagesClient.js` constrói `content.body` numerado e `test/infobipMessagesClient.test.js` cobre o contrato atual. |
| Validação sem envio | Confirmado no tenant | `POST /messages-api/1/messages/validate` aceitou o contrato em 2026-09-19; `src/routes/messages.js` não expõe rota de disparo. |
| Relatórios de entrega | Confirmado documentalmente e protegido localmente | `src/services/infobipWebhookNormalizer.js` mapeia `messageId`, `doneAt`, status e erro; `src/services/database.js` ignora atualização fora de ordem. |
| Inbound comercial e formato do `wa_id` | Pendente | Requer payload real do remetente/WABA da clínica; o parser preserva `from` sem normalização até essa evidência. |
| Segurança de subscription/webhook | Pendente — sem autenticação temporariamente | A tela de subscription real oferece apenas Básico, Hmac e OAuth; por decisão de 2026-09-25, `src/bootstrap.js` ativa `allowUnauthenticatedInbound` em produção até a escolha do mecanismo permanente na próxima sprint. |
| Coexistência e ecos do Business App | Confirmado no tenant | Payload real capturado em 2026-09-25; `src/services/infobipWebhookNormalizer.js` grava o eco como `direction: out`, `sent_via: business_app`, coberto por `test/infobipWebhooks.test.js`. Sincronização de histórico e a divergência do nono dígito continuam pendentes. |
| Falha de janela de 24 horas e limite WhatsApp de `sendAt` | Pendente | Exigem resposta real controlada; a validação local só garante formato ISO futuro. |

## Pendências antes de implementar a integração

- Confirmar resposta, `messageId` por destino e erros da Messages API.
- Capturar payloads reais de inbound, status e sincronização de histórico
  (o eco de coexistência já foi capturado em 2026-09-25).
- Confirmar a autenticação do webhook e o formato de falha da janela de 24h.
- Validar o limite de `sendAt` para WhatsApp.

As pendências são rastreadas em `SET-05`, `API-02`, `API-03` e `API-04` no
[`BACKLOG.md`](BACKLOG.md).
