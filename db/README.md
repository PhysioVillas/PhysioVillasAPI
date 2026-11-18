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

## Estado de produção e reconciliação do ledger

O Neon de produção já tem as migrations `001`–`009` registradas. Antes da
aplicação, as colunas, os índices, as restrições e as views antigas foram
comparadas com as de um PostgreSQL descartável. A reconciliação e a migration
`009` foram aplicadas na mesma transação. O procedimento abaixo serve para um
banco legado equivalente que ainda não possua o histórico.

Não execute `npm run migrate` enquanto o ledger de produção estiver ausente: o
runner criaria um ledger vazio e tentaria reaplicar DDL antigo. Depois de
reconfirmar os objetos, índices, constraints e views de `001`–`008`, use
`provisioning/reconcile_legacy_migrations.sql` para registrar no ledger somente
os oito arquivos legados e seus checksums locais. O script verifica o inventário
de objetos e colunas legadas esperados e aborta se o banco divergir. Em seguida,
execute `npm run migrate` uma única vez em ambiente confiável com
`DATABASE_URL`; o runner aplicará `009` e registrará o checksum real na mesma
transação. Se qualquer objeto divergir, pare e investigue; não marque a
migration como aplicada para contornar a divergência.

```sql
-- Relações e tipos de objeto nos schemas operacionais e de relatório.
select n.nspname as schema_name, c.relname as object_name, c.relkind
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'reporting')
  and c.relkind in ('r', 'p', 'v', 'm', 'i', 'S')
order by n.nspname, c.relkind, c.relname;

-- Colunas, tipos e nulabilidade.
select table_schema, table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema in ('public', 'reporting')
order by table_schema, table_name, ordinal_position;

-- Índices, constraints e definições de views existentes.
select schemaname, tablename, indexname, indexdef
from pg_indexes where schemaname in ('public', 'reporting')
order by schemaname, tablename, indexname;
select n.nspname as schema_name, c.relname as table_name, con.conname, pg_get_constraintdef(con.oid)
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'reporting')
order by n.nspname, c.relname, con.conname;
select schemaname, viewname, definition
from pg_views where schemaname = 'reporting' order by viewname;

-- Estado do ledger e extensões já instaladas.
select to_regclass('public.schema_migrations') as migration_ledger;
select extname, extversion from pg_extension order by extname;
```

O estado conhecido é que `006` foi reconstruída localmente e precisa ser
comparada cuidadosamente com a estrutura remota antes de entrar na baseline.
Não registre `009` como aplicada durante a baseline. Se a auditoria encontrar
diferença em qualquer migration antiga, faça a reconciliação específica dessa
migration antes de seguir.

Depois da aplicação aprovada, `GET /health/ready` deve confirmar o schema
operacional e as views antes de liberar integrações. A presença de tabelas de
agendamento, por si só, não habilita comandos: a autenticação do webhook e a
desativação do bypass continuam bloqueios independentes.

## Agenda pelo WhatsApp

O paciente toca em **Agendar consulta** e escolhe serviço, profissional, dia e
horário em listas do WhatsApp. O catálogo, a grade e as vagas dos próximos
21 dias vêm do Neon. A API valida novamente a vaga na seleção final e grava o
pedido como pendente. A equipe responde pelo WhatsApp Business compartilhado. Comandos
de confirmação, cancelamento, remarcação e comparecimento precisam ser ecos de
saída `business_app` do remetente compartilhado configurado e passar pela
autenticação válida do webhook, com `allowUnauthenticatedInbound` desligado.

Para produção, configure HMAC tanto no Infobip quanto em
`INFOBIP_WEBHOOK_HMAC_SECRET` na Vercel, usando o mesmo segredo e algoritmo
suportado, e valide uma chamada assinada antes de habilitar mutações. O código
permite fallback Bearer legado quando HMAC não está configurado, mas o webhook
de produção não deve permanecer sem autenticação. A autenticação não pode ser
considerada pronta só por estar implementada no código.

São aceitas somente estas frases completas, com data, horários e offset UTC
configurado, sem prefixo ou sufixo:

```text
Consulta confirmada para YYYY-MM-DD, das HH:MM às HH:MM (UTC-03:00).
Consulta cancelada para YYYY-MM-DD, das HH:MM às HH:MM (UTC-03:00).
Consulta remarcada: a consulta de YYYY-MM-DD, das HH:MM às HH:MM foi transferida para YYYY-MM-DD, das HH:MM às HH:MM (UTC-03:00).
Comparecimento confirmado para YYYY-MM-DD, das HH:MM às HH:MM (UTC-03:00).
```

O offset deve ser configurado e válido; horários são avaliados em
`America/Bahia`. Cancelar ou remarcar exige exatamente uma consulta confirmada
ainda não atendida. Comparecimento exige exatamente uma consulta confirmada
cujo horário final já passou. RPG, Pilates e URO bloqueiam sobreposição do
mesmo profissional; profissionais diferentes podem atender ao mesmo tempo.
Fisioterapia permite até seis pacientes simultâneos por faixa de 30 minutos,
inclusive com o mesmo fisioterapeuta. A migration 009 implementa essa regra no
banco e as views agregadas para o BI. O menu usa essas mesmas informações.
O fluxo depende da publicação da API e da autenticação do webhook para receber
eventos no número da clínica.
Histórico de eventos é append-only e as views de reporting expõem somente
contagens agregadas. Comparecimento só é contado quando registrado pela equipe.

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

Depois de aplicar `009`, as views incluem pedidos, eventos, consultas
confirmadas/canceladas/realizadas e capacidade por serviço/profissional. Antes
de marcar o BI como publicado, atualize as credenciais no Power BI Service e
confirme uma atualização concluída. O mapa de módulos, limites de dados e
extensões planejadas está em
[`DATA_MODEL.md`](DATA_MODEL.md). O contrato do BI, a semântica das novas
métricas e os limites do modelo PBIP de exemplo estão em
[`../docs/BI_DATA_CONTRACT.md`](../docs/BI_DATA_CONTRACT.md).
