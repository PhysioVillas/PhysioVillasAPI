# Power BI do ChatManager

O projeto inicial do relatório está em [`powerbi/ChatManager/ChatManager.pbip`](powerbi/ChatManager/ChatManager.pbip). Ele tem duas páginas no formato do protótipo visual recebido: **Visão geral** e **Fluxo WhatsApp**. O modelo usa somente as views reais de mensagens e eventos do fluxo; não traz as tabelas fictícias de agenda, financeiro, pacientes ou campanhas do arquivo de referência.

O projeto foi configurado para Importar dados pelo conector PostgreSQL nativo do Power BI. Host e usuário/senha de leitura são configurados localmente no Power BI Desktop; nenhum segredo ou valor real de host é versionado. O primeiro refresh exige configurar o endpoint pooled do Neon e a credencial `powerbi_reader`.

## Preparação

1. Extraia/clone o repositório e abra `bi/powerbi/ChatManager/ChatManager.pbip` no Power BI Desktop recente.
2. Em **Transformar dados > Gerenciar parâmetros**, substitua `NeonServer` pelo host pooled do Neon, com `:5432`, e mantenha `NeonDatabase` como `neondb`.
3. Quando solicitado, use a autenticação de banco de dados para a role `powerbi_reader`, informe a senha guardada no cofre e habilite SSL. Não cole a senha em arquivo do projeto ou no GitHub.
4. Atualize o modelo e confirme que as tabelas carregadas são apenas `reporting.daily_message_metrics` e `reporting.daily_whatsapp_flow_metrics` (mais a dimensão de calendário calculada localmente).
5. Para publicar, configure a credencial da fonte PostgreSQL no Power BI Service e valide um refresh. A publicação/compartilhamento depende da licença e do workspace; o projeto local não o publica automaticamente.

As consultas usam `reporting.daily_message_metrics` e
`reporting.daily_whatsapp_flow_metrics`, que têm datas em UTC. As duas tabelas
relacionam `activity_date` à dimensão `DimDate`. As medidas DAX fazem parte do
modelo e também estão documentadas em [`MEASURES.dax`](MEASURES.dax).
`conversation_count` é uma contagem distinta dentro de cada grupo da view e
não deve ser somada entre eventos. O significado/limite de cada indicador está
em [`../docs/BI_DATA_CONTRACT.md`](../docs/BI_DATA_CONTRACT.md).

O arquivo `ClinicaFisio_PowerBI_v5.zip` contém sete páginas de referência
visual, baseadas em dados fictícios e uma planilha local. O relatório do
ChatManager mantém duas páginas, pois somente mensagens e eventos observados no
fluxo têm fonte real hoje. As páginas simuladas de agenda, faltas, ocupação,
financeiro e campanhas podem orientar o design futuro, mas não devem ser
ligadas a mensagens nem misturadas no modelo atual. Ainda não há fonte para
agenda, consultas
concluídas/canceladas, capacidade, cobrança, convênios ou campanhas. O evento
`menu_agendar` representa intenção de contato e não confirmação de consulta.
As métricas do fluxo só aparecem após os eventos correspondentes chegarem e o
modelo ser atualizado.

## Uso pela equipe

O relatório publicado atualmente está em **Meu workspace**, associado à conta
que o publicou. Isso serve para demonstração individual, mas não é um espaço
de propriedade da clínica. Para uso continuado pela empresa, a clínica deve
usar um tenant Microsoft 365 controlado por ela, publicar o projeto em um
workspace da organização e conceder acesso nominativo somente às pessoas que
precisam visualizar ou editar. Não use **Publicar na Web**: esse recurso torna
o relatório e os dados subjacentes acessíveis a qualquer pessoa na Internet.

O compartilhamento organizacional exige licenças compatíveis para quem publica
e para os leitores; usuários gratuitos só conseguem consumir conteúdo
compartilhado quando o workspace está em capacidade Fabric/Premium adequada.
O período de avaliação mostrado no serviço não deve ser considerado licença
permanente. Confirmar a licença do tenant antes de organizar o acesso da equipe.

Para manter o relatório atualizado, configure no Power BI Service as
credenciais do usuário PostgreSQL somente leitura e uma agenda de atualização
do modelo semântico. A conexão ao Neon é uma fonte de nuvem e deve ser validada
por uma atualização concluída e pelo histórico de atualização. Não colocar a
senha no PBIP nem neste repositório.
