-- Provisionamento manual e reversível do leitor de relatórios.
--
-- Pré-condições:
--   1. A role LOGIN `powerbi_reader` já foi criada fora do repositório, com
--      senha gerada e armazenada em cofre de segredos.
--   2. Este arquivo é executado pelo proprietário dos schemas `public` e
--      `reporting`, no database correto de homologação ou produção.
--
-- Não criar a role, registrar senha ou executar este arquivo automaticamente.

begin;

-- O leitor de BI não lê nem cria objetos no módulo operacional.
revoke all privileges on schema public from powerbi_reader;
revoke all privileges on all tables in schema public from powerbi_reader;

-- A interface de BI contém somente agregados sem corpo, perfil ou wa_id.
grant usage on schema reporting to powerbi_reader;
grant select on all tables in schema reporting to powerbi_reader;

-- Views e tabelas futuras do mesmo proprietário continuam legíveis, sem
-- conceder escrita ou acesso ao schema operacional.
alter default privileges in schema reporting
  revoke all privileges on tables from powerbi_reader;
alter default privileges in schema reporting
  grant select on tables to powerbi_reader;

commit;
