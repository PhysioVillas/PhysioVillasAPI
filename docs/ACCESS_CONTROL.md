# Controle de acesso por perfil

## Decisão implementada

O ChatManager separa os perfis humanos `operational`, `managerial` e
`executive`. A política executável está em `src/services/accessPolicy.js`; ela
é deliberadamente independente do provedor de login, que ainda não foi
escolhido. Uma rota nova só pode expor uma capacidade depois de declarar e
validar o escopo correspondente.

| Perfil | Pode acessar | Não pode acessar |
|---|---|---|
| `operational` | contatos, conversas e mensagens necessárias ao atendimento; leitura/edição editorial de FAQ; consulta de templates | dados de BI para gestão por padrão, credenciais, logs técnicos ou dados clínicos |
| `managerial` | relatórios agregados, consulta de templates e FAQ | identificadores de contato, corpo de mensagens e conversas individuais |
| `executive` | relatórios agregados | contatos, mensagens, conversas, FAQ editável e dados identificáveis |

O relatório agregado é a view `reporting.daily_message_metrics`, que já não
expõe `body`, `wa_id` ou `profile_name`. O acesso de Power BI deve usar somente
um papel de banco com leitura nesse schema, nunca o papel operacional do
backend.

## Limites e integração futura

- O token que autentica webhook da Infobip é uma credencial de serviço, não um
  perfil humano; ele só autoriza a entrada do webhook configurado.
- O token interno da rota de validação de mensagens também não se torna acesso
  de usuário. Ele continua separado e não pode liberar leitura de mensagens.
- Ainda não há login, tabela de usuários ou rota de consulta. Antes de expor
  qualquer uma delas, a autenticação escolhida deve mapear uma identidade ao
  perfil e aplicar `hasRoleScope` como middleware no servidor.
- Nenhum perfil libera prontuário, diagnóstico, queixa, agenda clínica ou
  histórico financeiro: esses dados permanecem fora do escopo automático do
  ChatManager.

## Critério de aceite

1. uma permissão desconhecida falha fechada;
2. somente `operational` pode ler mensagens e contatos identificáveis;
3. `managerial` e `executive` recebem somente `reporting:read` para a camada
   agregada;
4. testes automatizados protegem essas regras antes de qualquer rota humana
   ser criada.
