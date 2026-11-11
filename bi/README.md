# Power BI do ChatManager

Este diretório contém consultas iniciais para conectar o Power BI às views
reais do ChatManager. O arquivo `ClinicaFisio_PowerBI_v5.zip` é um protótipo
separado, baseado em dados fictícios e em um caminho local; não o use como fonte
de produção nem misture suas tabelas simuladas com os indicadores deste modelo.

## Preparação

1. Aplicar as migrations até `007_whatsapp_flow_reporting.sql` no banco Neon
   apropriado, em operação administrativa autorizada.
2. Criar/usar a role somente leitura documentada em
   [`../db/provisioning/powerbi_reader.sql`](../db/provisioning/powerbi_reader.sql).
3. No Power BI Desktop, escolher PostgreSQL Database e informar o hostname
   pooled do Neon e o nome do banco. Usar SSL e as credenciais da role de BI.
   Criar parâmetros de texto `NeonServer` (host pooled seguido de `:5432`) e
   `NeonDatabase` (normalmente `neondb`) para as consultas.
4. Criar as consultas `DailyMessageMetrics` e `DailyWhatsAppFlowMetrics` no
   Power Query, copiando os respectivos arquivos `.m`. Credenciais não são
   gravadas no repositório.
5. Começar com Import. Publicar e configurar a credencial/atualização agendada
   no Power BI Service e confirmar uma atualização antes de apresentar dados
   como operacionais.

As consultas usam `reporting.daily_message_metrics` e
`reporting.daily_whatsapp_flow_metrics`, que têm datas em UTC. Configure o
relacionamento de cada `activity_date` com a dimensão calendário do relatório.
Medidas iniciais estão em [`MEASURES.dax`](MEASURES.dax). `conversation_count`
é uma contagem distinta dentro de cada grupo da view e não deve ser somada
entre eventos. O significado/limite
de cada indicador está em [`../docs/BI_DATA_CONTRACT.md`](../docs/BI_DATA_CONTRACT.md).

Não há neste projeto fonte de agenda, consultas concluídas/canceladas,
capacidade, cobrança, convênios ou campanhas. Não apresente valores calculados
a partir da planilha fictícia como se viessem do Neon.
