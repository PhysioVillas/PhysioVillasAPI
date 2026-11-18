# Power BI do ChatManager

O projeto do relatório está em [`powerbi/ChatManager/ChatManager.pbip`](powerbi/ChatManager/ChatManager.pbip). Ele contém **Visão geral**, **Fluxo WhatsApp** e **Agendamentos**. As duas primeiras páginas mostram indicadores já disponíveis no banco atual. A página de agenda e suas medidas são um preparo local para a migração `009_appointments.sql`; não haverá números reais de agenda até essa migração e o fluxo seguro de confirmação estarem ativos.

O projeto usa o conector PostgreSQL nativo do Power BI em modo Import. Ao abrir o projeto em uma nova máquina, configure `NeonServer` com o endpoint pooled do ambiente escolhido. Informe a credencial de leitura `powerbi_reader` diretamente no Power BI.

## Preparação

1. Extraia/clone o repositório e abra `bi/powerbi/ChatManager/ChatManager.pbip` no Power BI Desktop recente.
2. Em **Transformar dados > Gerenciar parâmetros**, confirme `NeonServer` com o host pooled do Neon e `:5432`, e `NeonDatabase` como `neondb`. Se o Power BI já estava aberto durante a mudança do arquivo, clique em **Aplicar alterações externas** antes de atualizar.
3. Quando solicitado, use a autenticação de banco de dados para a role `powerbi_reader`, informe a senha guardada no cofre e habilite SSL. Não cole a senha em arquivo do projeto ou no GitHub.
4. Antes da migração 009, confirme que as tabelas carregadas são apenas `reporting.daily_message_metrics`, `reporting.daily_whatsapp_flow_metrics` e `reporting.daily_human_response_metrics`. Depois que a migração revisada for aplicada, valide também as três views agregadas de agenda; elas não expõem telefone, texto de mensagem ou conteúdo clínico.
5. Para publicar, configure a credencial da fonte PostgreSQL no Power BI Service e valide um refresh. A publicação/compartilhamento depende da licença e do workspace; o projeto local não o publica automaticamente.

As consultas atuais usam `reporting.daily_message_metrics`,
`reporting.daily_whatsapp_flow_metrics` e
`reporting.daily_human_response_metrics`, que têm datas em UTC. As três tabelas
relacionam `activity_date` à dimensão `DimDate`. A página **Agendamentos** usa
`reporting.appointment_request_status_metrics`,
`reporting.daily_appointment_event_metrics` e
`reporting.scheduled_appointment_metrics`, definidas localmente na migração 009.
As medidas DAX fazem parte do modelo e também estão documentadas em [`MEASURES.dax`](MEASURES.dax).
`conversation_count` é uma contagem distinta dentro de cada grupo da view e
não deve ser somada entre eventos. O significado/limite de cada indicador está
em [`../docs/BI_DATA_CONTRACT.md`](../docs/BI_DATA_CONTRACT.md).

O arquivo `ClinicaFisio_PowerBI_v5.zip` contém sete páginas de referência
visual, baseadas em dados fictícios e uma planilha local. O relatório não usa
as tabelas fictícias de agenda, faltas, ocupação, financeiro ou campanhas. A
página de agendamentos lê as views da migration 009, aplicada no Neon. Ela
exibe horários com vaga por serviço e consultas por profissional. O menu do
WhatsApp consulta o mesmo catálogo e a mesma capacidade. O modelo atual registra
comparecimento confirmado; não há estado de falta (`no-show`). O webhook de
produção também precisa de autenticação compatível antes de aceitar comandos
de agenda. O evento `menu_agendar` sozinho continua sendo uma intenção, não uma
consulta marcada. Cobrança, convênios e campanhas ainda não têm fontes
confiáveis.

O cartão de tempo de resposta depende de ecos de mensagens da equipe no
WhatsApp Business App. Uma contagem zero significa que ainda não há intervalos
pareados na fonte carregada; não deve ser apresentada como tempo zero de
atendimento. Depois de abrir o PBIP no Power BI Desktop, é necessário publicar
o modelo atualizado no workspace escolhido, configurar a credencial do banco,
executar um refresh e confirmar o histórico de atualização. Alterar o PBIP no
GitHub não atualiza automaticamente o relatório já publicado.

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
