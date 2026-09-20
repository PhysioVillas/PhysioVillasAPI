# Modelo de dados e módulos

## Objetivo

O banco suporta a integração WhatsApp e relatórios operacionais sem se tornar
um prontuário clínico. O backend grava somente os eventos necessários para
rastrear atendimento e entrega; respostas clínicas, diagnósticos, queixas e
histórico não fazem parte do modelo automático.

## Módulo operacional (`public`)

| Entidade | Responsável por escrever | Conteúdo | Regra principal |
|---|---|---|---|
| `contacts` | webhook do ChatManager | identificador do WhatsApp, nome de perfil opcional e último contato | um registro por `wa_id` |
| `conversations` | roteador do ChatManager | contato opcional, estado operacional, intenção atual e datas de abertura/encerramento | não contém queixa ou triagem clínica; uma conversa pode continuar mesmo se o contato for removido |
| `messages` | webhook e, futuramente, envio autorizado | identificador da Infobip, conversa opcional, direção, origem, corpo, tipo, status, erro, data e instante da última atualização de entrega | `infobip_message_id` impede duplicação de reentregas |
| `message_templates` | sincronização administrativa futura | nome, idioma, categoria, situação de aprovação e quantidade de parâmetros | não registra valores de parâmetros nem dispara envios |
| `faq_entries` | administração editorial futura | pergunta e resposta administrativas, estado de publicação e revisão | não deve conter orientação clínica individual |

Relação: um contato pode ter várias conversas e mensagens; uma conversa pode
agrupar várias mensagens. O campo `sent_via` distingue mensagens saídas pela
API das enviadas manualmente pelo WhatsApp Business App, o que preserva a
rastreabilidade da coexistência.

`conversations.current_intent` só classifica o caminho operacional (`faq`,
`triage`, `scheduling` ou `human_handoff`). A coleta efetiva de dados de
triagem permanece fora do banco até existir uma política clínica e de retenção
aprovada. A tabela de FAQ é editorial: seu conteúdo deve passar por revisão da
clínica antes de receber o estado `published`.

O webhook não guarda o payload bruto da Infobip. Isso reduz retenção acidental
de campos desconhecidos e deixa o parser responsável por aceitar somente dados
explicitamente mapeados.

Relatórios de entrega usam `doneAt` como instante de ordenação. Um evento com
data anterior à última atualização persistida não regride o status da mensagem;
se o provedor não informar data, ele só pode preencher uma mensagem que ainda
não tenha recebido status. Isso protege a trilha operacional contra reentregas
fora de ordem sem reter o payload bruto.

Quando um envio vier a ser autorizado e a Messages API aceitar a solicitação,
o backend usa o recibo (`messageId`) para gravar atomicamente o contato, a
conversa aberta e a mensagem de saída com `direction: 'out'` e
`sent_via: 'api'`. Essa operação ainda não é acionada por nenhuma rota de
envio: a API atual só oferece validação e permanece incapaz de disparar
mensagens sem uma decisão específica.

## Módulo analítico (`reporting`)

`reporting.daily_message_metrics` é a primeira interface estável para o Power
BI. Ela agrega por dia UTC, direção, origem, tipo e status, expondo somente:

- quantidade de mensagens;
- quantidade com código de erro;
- dimensões operacionais para filtro.

Ela não expõe `body`, `profile_name` nem `wa_id`. O Power BI recebe acesso ao
schema `reporting`, não às tabelas operacionais em `public`.

## Sequência de migrações

1. `001_initial_schema.sql` cria o módulo operacional e seus índices.
2. `002_reporting_views.sql` cria a camada agregada para BI.
3. `003_conversation_catalog.sql` acrescenta o contexto de conversa e os
   catálogos operacionais de templates e FAQ.
4. `004_message_delivery_status.sql` registra o instante da última atualização
   de entrega sem reter preço ou payload de relatório.
5. `005_active_conversations.sql` garante no máximo uma conversa aberta por
   contato, para que cada evento recebido possa ser ligado ao atendimento
   operacional ativo sem criar registros de triagem.

As migrações são aplicadas pelo administrador do Neon, em ordem, com uma
conexão SSL. Elas não criam uma conta, banco externo, usuário ou senha.

## Dados deliberadamente fora do modelo

- agenda clínica, disponibilidade e referências de consulta: dependem de uma
  fonte de agenda definida;
- queixa, diagnóstico, histórico, arquivos e resultados: não coletar nem
  persistir no fluxo automático;
- credenciais, chaves, URLs completas e números de telefone em configurações
  versionadas;
- payloads brutos de webhook.

## Próximas extensões, somente com evidência da Infobip

| Necessidade | Mudança futura | Condição para executar |
|---|---|---|
| Relatório de entrega por etapa | histórico de eventos de status | capturar o payload real e confirmar sua semântica |
| Métricas de template | identificador/nome do template sem parâmetros pessoais | confirmar o contrato da Messages API |
| Lembretes | referência externa de consulta e horário programado | definir integração de agenda e política operacional |
| Retenção | política de exclusão/anonimização | decisão da clínica e obrigação aplicável |
