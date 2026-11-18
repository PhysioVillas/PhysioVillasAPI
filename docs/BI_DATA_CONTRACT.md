# Contrato de dados do BI

## Fonte e acesso

O banco operacional PostgreSQL/Neon continua sendo a fonte. A API hospedada na
Vercel recebe e processa eventos do WhatsApp; o Power BI deve ler apenas views
agregadas do schema `reporting`, usando uma credencial somente leitura separada.
O modelo PBIP fornecido usa uma planilha fictícia e caminhos locais: serve como
referência de páginas e medidas, não como fonte real nem como dados a importar.

## Views disponíveis

| View | O que mede | Dimensões |
|---|---|---|
| `reporting.daily_message_metrics` | volume de mensagens e erros de entrega por dia | direção, canal de envio, tipo e status |
| `reporting.daily_whatsapp_flow_metrics` | eventos observados no fluxo e conversas distintas que os produziram | data UTC, evento, etapa conhecida e origem |
| `reporting.daily_human_response_metrics` | quantidade de respostas humanas pareadas e tempos médio/mediano em segundos | data UTC da resposta |
| `reporting.appointment_request_status_metrics` | pedidos pendentes, confirmados e cancelados | data do pedido, serviço e profissional |
| `reporting.daily_appointment_event_metrics` | pedidos, confirmações, cancelamentos, remarcações e comparecimentos registrados | data local do evento, serviço e profissional |
| `reporting.scheduled_appointment_metrics` | consultas atuais por data/horário, estado, serviço e profissional | data e hora local agendada |
| `reporting.appointment_slot_capacity_metrics` | vagas totais, ocupadas e restantes na grade | data/hora local, serviço e profissional (fisioterapia é agrupada) |

As views não expõem telefone, nome, corpo de mensagem ou conteúdo do webhook.
Eventos de fluxo só são gravados na mesma transação em que uma mensagem nova é
persistida. Reentregas com o mesmo identificador não contam novamente. Etapas
selecionáveis vêm de uma lista permitida mantida junto ao fluxo, não de texto ou
IDs arbitrários recebidos do WhatsApp.

## Semântica dos eventos

- `message_received`: mensagem recebida e persistida.
- `flow_option_selected`: opção interativa conhecida selecionada; `step_key`
  identifica a opção, por exemplo `faq_horarios` ou `menu_agendar`.
- `bot_step_sent`: menu, resposta de FAQ ou mensagem de encaminhamento enviada
  pela API e persistida com recibo.
- `team_message_sent`: mensagem de saída recebida como eco do WhatsApp Business
  App no fluxo de coexistência.

Para medir conversas com mensagem recebida por dia, some `conversation_count`
somente nas linhas `message_received` da view. Isso conta conversas distintas
que tiveram pelo menos uma mensagem recebida naquele dia; uma conversa que
continua em dias diferentes pode aparecer em cada um desses dias. Não some
`conversation_count` entre tipos de evento para obter um total de conversas,
pois a mesma conversa pode participar de várias etapas.

`menu_agendar` registra a seleção da opção “Agendar/Remarcar”; esse evento do
funil não é, por si só, um pedido válido de consulta. O pedido estruturado
identifica serviço, profissional e horário, é comparado com a view de vagas e
fica pendente até a confirmação da equipe pelo WhatsApp Business. A migration
009, API e modelo semântico locais agora incluem solicitações, consultas,
eventos de ciclo de vida e métricas da agenda. O SQL foi aplicado em um banco
PostgreSQL descartável, mas a produção Neon ainda requer reconciliação do
ledger e aplicação da migration.

**Regras operacionais definidas pela clínica:** de segunda a sexta, Pilates
com Luarca tem horários de 60 minutos (07:00–12:00 e 14:00–17:00); RPG com
Luarca, URO com Camila e fisioterapia com Moisés ou Antônio têm horários de 30
minutos (07:30–12:00 e 14:00–18:30). A fisioterapia permite até seis pacientes
na mesma faixa de 30 minutos, inclusive com o mesmo fisioterapeuta. Para RPG,
Pilates e URO, o mesmo profissional não pode ter consultas sobrepostas;
profissionais diferentes podem atender simultaneamente. Como Luarca realiza
RPG e Pilates, os conflitos entre essas modalidades também precisam ser
verificados em conjunto.

O catálogo `src/config/appointmentSchedule.js` e a migration 009 descrevem a
mesma grade. A consulta ao BI mostra a capacidade dos horários; na confirmação,
um trigger no banco valida a grade e conflitos dentro da transação. Pedidos
pendentes não reservam o horário, portanto a equipe deve confirmar a vaga antes
de responder que está marcada.

Esta solução usa o WhatsApp Business compartilhado como canal operacional e
ator de auditoria; ela não identifica qual atendente fez a ação, pois não há
login individual. Os comandos de alteração são frases completas reconhecidas
somente em ecos de saída do número Business configurado; texto comum não altera
consulta. A API implementa autenticação do webhook por HMAC ou token Bearer
legado, mas a configuração correspondente no Infobip e na Vercel precisa ser
validada em produção antes de liberar comandos que mudam consultas.

Semântica das métricas da agenda:

- **Solicitações**: quantidade de pedidos recebidos, agrupados pela data do
  pedido. Não contar como consulta confirmada.
- **Consultas confirmadas**: estado atual confirmado, contado pela data e hora
  agendadas. Uma remarcação preserva o histórico e não cria uma segunda
  consulta concluída.
- **Cancelamentos**: evento de cancelamento agrupado pela data em que ocorreu;
  também pode ser analisado pela data original da consulta.
- **Comparecimentos**: estado marcado explicitamente pela equipe, agrupado pela
  data agendada. Não inferir a partir de mensagens ou da passagem do horário.
- **Agendamentos por serviço/profissional**: atribuir serviço e profissional à
  solicitação/consulta e expor dimensões agregadas correspondentes.
- **Ocupação por serviço/profissional**: consultas confirmadas divididas pela
  capacidade dos horários transcorridos; seis por faixa em fisioterapia e uma
  por profissional nos outros serviços. O escopo agrupado da fisioterapia não
  duplica sua capacidade entre Moisés e Antônio.
- **Fuso horário**: manter instantes em UTC e converter os horários da clínica
  para `America/Bahia` nos buckets e na verificação da grade.

As tabelas separam eventos do ciclo de vida da situação atual da consulta e as
views expõem somente dados agregados. Não incluir telefone, identificador de
contato, texto de motivo, mensagens ou dados clínicos.

O cartão `Seleções com encaminhamento à equipe` conta eventos de seleção das
opções `menu_agendar`, `menu_paciente_novo`, `menu_atendente` e
`btn_atendente`. É uma contagem de interações registradas, não de pessoas
únicas nem de atendimentos concluídos. Leia junto com `Encaminhamentos enviados
pelo bot`; os dois indicadores representam etapas distintas.

## Indicadores que ainda não têm fonte

O modelo local do Power BI já representa métricas de agenda e dimensões de
serviço/profissional. Elas só terão dados reais depois de reconciliar o ledger,
aplicar a migration 009, provisionar a role somente leitura e atualizar o
modelo no Power BI Service. Até uma atualização bem-sucedida, os cartões podem
aparecer vazios ou sem dados. Financeiro, convênios e campanhas continuam fora
do escopo até existir fonte confiável.

`daily_human_response_metrics` mede a espera observável entre a primeira
mensagem recebida após a resposta humana anterior e a próxima mensagem enviada
pela equipe pelo WhatsApp Business App. Respostas automáticas do bot não
encerram a espera. O intervalo só é incluído quando os horários permitem uma
ordenação estrita; eventos com o mesmo instante são omitidos para evitar
pareamentos ambíguos, porque os ecos da coexistência têm precisão de segundos.
As médias do Power BI são ponderadas pelo número de respostas pareadas. Esse
indicador representa espera até a primeira resposta humana observada, não tempo
total de atendimento nem SLA. A quantidade de respostas com tempo mensurável
deve ser lida junto da média; envios humanos sem eco recebido não aparecem.

## Conexão Power BI

Conectar o PostgreSQL do Neon pelo conector PostgreSQL usando o endpoint pooled
e SSL, selecionar somente as views em `reporting`, e começar com Import e
atualização agendada depois de configurar a credencial no Power BI Service.
Validar atualização no serviço antes de tratar o relatório como operacional.
O uso de DirectQuery, gateway ou outras configurações depende da infraestrutura
e das opções de conectividade efetivamente disponíveis no workspace.
