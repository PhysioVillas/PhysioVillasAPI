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

`menu_agendar` é apenas uma escolha/intenção de contato. Não demonstra que um
horário foi reservado. O sistema ainda não possui agenda, disponibilidade,
consulta confirmada, comparecimento ou cancelamento. Esses indicadores só
devem ser adicionados quando houver uma fonte de agenda e eventos de ciclo de
vida confiáveis.

O cartão `Seleções com encaminhamento à equipe` conta eventos de seleção das
opções `menu_agendar`, `menu_paciente_novo`, `menu_atendente` e
`btn_atendente`. É uma contagem de interações registradas, não de pessoas
únicas nem de atendimentos concluídos. Leia junto com `Encaminhamentos enviados
pelo bot`; os dois indicadores representam etapas distintas.

## Indicadores que ainda não têm fonte

O banco atual não sustenta consultas marcadas/realizadas/canceladas, capacidade
de profissionais, faturamento, convênios, campanhas ou conversão comercial. O
PBIP de referência contém entidades simuladas para vários desses assuntos;
elas não devem ser ligadas a mensagens ou tratadas como dados reais. Uma futura
integração deve mapear cada métrica a um sistema de origem e definir chaves,
estados, horários e regras de qualidade antes de publicar medidas no BI.

## Conexão Power BI

Conectar o PostgreSQL do Neon pelo conector PostgreSQL usando o endpoint pooled
e SSL, selecionar somente as views em `reporting`, e começar com Import e
atualização agendada depois de configurar a credencial no Power BI Service.
Validar atualização no serviço antes de tratar o relatório como operacional.
O uso de DirectQuery, gateway ou outras configurações depende da infraestrutura
e das opções de conectividade efetivamente disponíveis no workspace.
