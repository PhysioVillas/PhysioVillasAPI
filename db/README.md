# Banco de dados

O schema é PostgreSQL compatível com Neon. Ele preserva os identificadores da
Infobip para processar reentregas de webhook de modo idempotente e distingue
mensagens saídas pelo backend das enviadas pelo WhatsApp Business App.

## Aplicar a migração

Com uma `DATABASE_URL` de ambiente que use SSL, execute em ordem as migrações
`migrations/001_initial_schema.sql` e `migrations/002_reporting_views.sql` no
console SQL do Neon ou com `psql` usando um usuário proprietário do banco. As
migrações podem ser executadas novamente sem recriar tabelas, índices ou views.

Não registre a URL de conexão, usuários, senhas, números de telefone ou chaves
de API neste repositório.

## Power BI

Após criar o banco, o administrador deve criar um usuário separado para o Power
BI e conceder somente leitura no schema `reporting`. Não conceder acesso de BI
ao schema operacional `public`:

```sql
create role powerbi_reader with login password '<senha-gerada-fora-do-repo>';
grant connect on database <nome_do_banco> to powerbi_reader;
grant usage on schema reporting to powerbi_reader;
grant select on all tables in schema reporting to powerbi_reader;
alter default privileges in schema reporting grant select on tables to powerbi_reader;
```

O comando precisa ser executado pelo administrador do banco e a senha deve ser
guardada exclusivamente no gerenciador de segredos que for adotado.

O mapa de módulos, limites de dados e extensões planejadas está em
[`DATA_MODEL.md`](DATA_MODEL.md).
