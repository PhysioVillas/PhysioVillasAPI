# Banco de dados

O schema é PostgreSQL compatível com Neon. Ele preserva os identificadores da
Infobip para processar reentregas de webhook de modo idempotente e distingue
mensagens saídas pelo backend das enviadas pelo WhatsApp Business App.

## Aplicar a migração

Com uma `DATABASE_URL` de ambiente que use SSL, execute `npm run migrate` com
um usuário proprietário do banco. O executor aplica em ordem os arquivos SQL
de `migrations/`, registra o checksum de cada um em `schema_migrations` e
recusa uma migration já aplicada que tenha sido alterada. Ele não é executado
na inicialização da API ou no deploy.

Alternativamente, execute no console SQL do Neon, em ordem, os arquivos
`migrations/001_initial_schema.sql` a
`migrations/005_active_conversations.sql`. Depois, `GET /health/ready` deve
confirmar tabelas operacionais, a conversa ativa por contato, a visão analítica
e a coluna de entrega antes de liberar o webhook em um preview.

Não registre a URL de conexão, usuários, senhas, números de telefone ou chaves
de API neste repositório.

## Power BI

Após criar o banco, o administrador deve criar um usuário separado para o Power
BI e conceder somente leitura no schema `reporting`. Não conceder acesso de BI
ao schema operacional `public`:

```sql
-- Criar a role com senha gerada fora do repositório, em operação administrativa.
-- Em seguida, executar db/provisioning/powerbi_reader.sql como proprietário do schema.
```

O arquivo `provisioning/powerbi_reader.sql` contém os grants e revogações
mínimos: remove qualquer acesso ao módulo `public` e permite apenas leitura do
schema `reporting`, inclusive para objetos futuros. A role de login e sua senha
devem ser criadas pelo administrador fora do repositório e em operação
explicitamente autorizada.

O mapa de módulos, limites de dados e extensões planejadas está em
[`DATA_MODEL.md`](DATA_MODEL.md).
