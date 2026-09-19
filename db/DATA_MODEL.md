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
| `messages` | webhook e, futuramente, envio autorizado | identificador da Infobip, direção, origem, corpo, tipo, status, erro e data | `infobip_message_id` impede duplicação de reentregas |

Relação: um contato pode ter várias mensagens. O campo `sent_via` distingue
mensagens saídas pela API das enviadas manualmente pelo WhatsApp Business App,
o que preserva a rastreabilidade da coexistência.

O webhook não guarda o payload bruto da Infobip. Isso reduz retenção acidental
de campos desconhecidos e deixa o parser responsável por aceitar somente dados
explicitamente mapeados.

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

As migrações são aplicadas pelo administrador do Neon, em ordem, com uma
conexão SSL. Elas não criam uma conta, banco externo, usuário ou senha.

## Dados deliberadamente fora do modelo

- agenda clínica e disponibilidade: dependem de uma fonte de agenda definida;
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
