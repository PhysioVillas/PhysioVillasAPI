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
`sent_via: 'api'`. As rotas autenticadas de envio agora executam essa operação
somente quando banco, credenciais Infobip e token interno estão configurados.
O registro de template guarda apenas o nome, nunca os parâmetros preenchidos.
O envio continua desligado em ambientes sem essas configurações; nenhuma
mensagem real foi enviada por estes testes locais.

## Módulo analítico (`reporting`)

`reporting.daily_message_metrics` agrega por dia UTC, direção, origem, tipo e
status. `reporting.daily_whatsapp_flow_metrics` agrega eventos do menu e
autoatendimento por dia UTC, tipo de evento, etapa permitida e origem, expondo
somente:

- quantidade de mensagens;
- quantidade com código de erro;
- dimensões operacionais para filtro.
- quantidade de eventos de fluxo e conversas distintas observadas.

Ela não expõe `body`, `profile_name` nem `wa_id`. O Power BI recebe acesso ao
schema `reporting`, não às tabelas operacionais em `public`.

A trilha `whatsapp_flow_events` é gravada na transação da mensagem e tem chave
única por mensagem e tipo de evento, portanto reentregas não duplicam o funil.
Ela conta mensagens recebidas, opções interativas reconhecidas, passos do bot
enviados e respostas observadas pelo WhatsApp Business App. IDs de etapa são
permitidos pelo próprio catálogo do bot; IDs desconhecidos não viram dimensão
analítica. Consulte [`../docs/BI_DATA_CONTRACT.md`](../docs/BI_DATA_CONTRACT.md)
para o significado dos indicadores e as limitações do modelo PBIP de exemplo.

`reporting.daily_human_response_metrics` pareia a primeira mensagem ainda sem
resposta humana com a próxima resposta observada pelo eco do WhatsApp Business
App, agrega contagem e tempos médio/mediano em segundos por dia UTC e omite
intervalos com timestamps ambíguos. O bot não conta como resposta humana.
A migration 008 inclui índice parcial por conversa e instante para apoiar os
pareamentos sem expor identificadores na view.

## Agenda (migration 009; código local validado, produção pendente)

`009_appointments.sql` cria `appointment_requests` para pedidos recebidos,
`appointments` para o estado atual de cada consulta e `appointment_events`
para o histórico append-only de pedido, confirmação, cancelamento, remarcação e
comparecimento. Quatro views analíticas agregam pedidos, estado atual, eventos
e capacidade em hora local `America/Bahia`, sem expor contatos ou conteúdo de
mensagens. A migration aplica em PostgreSQL descartável; ainda precisa ser
reconciliada e aplicada no Neon de produção.

A clínica definiu que duas consultas não podem se sobrepor quando são do mesmo
profissional, mas podem ocorrer no mesmo horário se forem com profissionais
diferentes. A exceção é fisioterapia: até seis pacientes podem ocupar o mesmo
bloco de 30 minutos, inclusive com o mesmo fisioterapeuta. A clínica também
informou a grade de segunda a sexta, os profissionais e os serviços. O catálogo
local `src/config/appointmentSchedule.js` descreve esses horários, durações e
capacidades. A API local usa esse contrato no pedido estruturado e consulta
`reporting.appointment_slot_capacity_metrics` antes de registrar a solicitação.
Um pedido não reserva definitivamente o horário: a equipe precisa confirmar.
Na confirmação, um trigger valida novamente grade, duração e capacidade sob
lock transacional, para impedir conflito em confirmações concorrentes.

Grade informada (hora local `America/Bahia`):

| Serviço | Profissionais | Duração | Horários (segunda a sexta) | Capacidade por faixa |
|---|---|---:|---|---:|
| Fisioterapia | Moisés e Antônio | 30 min | 07:30–12:00 e 14:00–18:30 | 6 pacientes por faixa, inclusive com o mesmo profissional |
| RPG | Luarca | 30 min | 07:30–12:00 e 14:00–18:30 | 1 por profissional |
| URO | Camila | 30 min | 07:30–12:00 e 14:00–18:30 | 1 por profissional |
| Pilates | Luarca | 60 min | 07:00–12:00 e 14:00–17:00 | 1 por profissional |

Como Luarca atende RPG e Pilates, a validação de conflitos impede cruzamento
entre essas duas modalidades para ela, mesmo que seus intervalos tenham
durações diferentes. A fisioterapia aplica capacidade de seis no total por
faixa; essa capacidade aceita os seis pacientes inclusive com o mesmo
fisioterapeuta. O BI mostra ocupação e vagas restantes com o mesmo escopo.

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
6. `006_operational_lifecycle.sql` acrescenta ciclo de vida de despachos e
   auditoria operacional.
7. `007_whatsapp_flow_reporting.sql` registra eventos mínimos do fluxo e cria
   a visão agregada diária para o BI.
8. `008_human_response_reporting.sql` acrescenta a visão agregada de tempos de
   resposta humana.
9. `009_appointments.sql` cria catálogo, grade semanal, pedidos, consultas,
   histórico append-only, restrições de capacidade/conflito e views agregadas
   da agenda. Foi validada localmente; a aplicação no Neon aguarda reconciliação
   do ledger para não repetir as migrations anteriores.

As migrações são aplicadas pelo administrador do Neon, em ordem, com uma
conexão SSL. Elas não criam uma conta, banco externo, usuário ou senha.

## Dados deliberadamente fora do modelo

- disponibilidade não é reserva: pedidos aguardam confirmação explícita da
  equipe; a migration 009 precisa estar aplicada em produção para a agenda real;
- queixa, diagnóstico, histórico, arquivos e resultados: não coletar nem
  persistir no fluxo automático;
- credenciais, chaves, URLs completas e números de telefone em configurações
  versionadas;
- payloads brutos de webhook.

## Próximas extensões, somente com fonte operacional confirmada

| Necessidade | Mudança futura | Condição para executar |
|---|---|---|
| Relatório de entrega por etapa | histórico de eventos de status | confirmar semântica e transições do provedor |
| Métricas de template | identificador/nome do template sem parâmetros pessoais | confirmar o contrato da API de mensagens |
| Lembretes | referência externa de consulta e horário programado | definir integração de agenda e política operacional |
| Retenção | política de exclusão/anonimização | decisão da clínica e obrigação aplicável |
