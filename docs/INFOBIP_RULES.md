# Regras de Integração Infobip — evidências vigentes

**Última atualização:** 2026-09-20

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

## Pendências antes de implementar a integração

- Confirmar resposta, `messageId` por destino e erros da Messages API.
- Capturar payloads reais de inbound, status e coexistência.
- Confirmar a autenticação do webhook e o formato de falha da janela de 24h.
- Validar o limite de `sendAt` para WhatsApp.

As pendências são rastreadas em `SET-05`, `API-02`, `API-03` e `API-04` no
[`BACKLOG.md`](BACKLOG.md).
