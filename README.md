# ChatManager

Backend de atendimento e integração WhatsApp da **[PhysioVilas](https://www.physiovilas.com.br/)**. O ChatManager recebe eventos do WhatsApp, executa regras de atendimento no backend, persiste o histórico operacional no PostgreSQL do Neon e disponibiliza dados agregados para o Power BI.

## Como o fluxo funciona

```text
Paciente (WhatsApp)
        ⇅
Infobip — transporte de mensagens e webhooks
        ⇅
API ChatManager — Node.js/Express na Vercel
   ├── aplica menu, FAQ e encaminhamento humano
   ├── persiste mensagens e conversas no Neon
   └── envia respostas pelo provedor WhatsApp
        ↓
Neon (PostgreSQL) ── schema reporting ──▶ Power BI
```

A Infobip é o provedor de transporte usado pela API; **as regras do fluxo não são configuradas em um Flow da Infobip**. O menu, as respostas de FAQ, o encaminhamento à equipe e a pausa após handoff são executados pelo código do ChatManager. A Vercel hospeda a API; o Power BI é uma aplicação separada que consulta o banco.

## Fluxo de atendimento implementado

1. A mensagem recebida chega ao webhook e é normalizada antes de ser associada ao contato, conversa e mensagem.
2. O backend responde com o menu interativo. As opções atuais cobrem agendamento/remarcação, novo paciente, equipe humana e dúvidas institucionais.
3. As perguntas frequentes disponíveis são horários, convênios, localização e serviços. A equipe pode ser acionada a partir do menu ou das respostas.
4. Após handoff ou resposta da equipe pelo WhatsApp Business App, o bot silencia por 12 horas; `MENU` reabre o menu.
5. Mensagens de saída podem ser enviadas pelas rotas internas de texto e template. Quando o envio está configurado, o recibo do provedor é persistido no Neon.

O código ainda não está ligado a um sistema de agenda. Portanto, o fluxo não confirma disponibilidade nem registra que um atendimento foi marcado, realizado, cancelado ou faltou. Essas informações precisam vir de uma agenda ou de uma atualização estruturada pela equipe; não devem ser inferidas do texto da conversa.

## Componentes

- **API:** Node.js + Express em módulos ESM, executável localmente e compatível com Vercel Functions.
- **WhatsApp:** webhooks e envio de mensagens pelo provedor configurado no backend. As regras de atendimento ficam no ChatManager.
- **Banco:** Neon/PostgreSQL. As migrações versionam contatos, conversas, mensagens, catálogos e métricas de entrega.
- **BI:** Power BI pode consumir somente views agregadas do schema `reporting` do Neon, com uma credencial somente leitura. Além de `reporting.daily_message_metrics`, a migration 007 acrescenta `reporting.daily_whatsapp_flow_metrics` para etapas observadas do autoatendimento. Não há fonte para agenda, consultas realizadas/canceladas, capacidade ou faturamento.
- **Documentação da API:** `GET /docs` e `GET /docs.json`.

As rotas de envio são internas e dependem de token próprio, banco e configuração do provedor. O webhook de entrada e as configurações de autenticação devem seguir as evidências e pendências registradas antes de qualquer operação com pacientes reais.

## Desenvolvimento local

Requisitos: Node.js `>=20 <25`.

```bash
npm ci
npm test
npm run check
npm start
```

O servidor local não precisa de credenciais externas para iniciar. `DATABASE_URL`, token interno e credenciais do provedor só devem ser configurados em ambiente apropriado, nunca commitados no repositório.

## Documentação

- [`docs/PRD_PhysioVilas_WhatsApp.md`](docs/PRD_PhysioVilas_WhatsApp.md) — escopo e arquitetura pretendida.
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — backlog e critérios de aceite.
- [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) — evidências, estado técnico e pendências.
- [`docs/HOMOLOGATION.md`](docs/HOMOLOGATION.md) — limites e procedimento de homologação.
- [`db/DATA_MODEL.md`](db/DATA_MODEL.md) — modelo operacional e camada de relatórios.
- [`docs/BI_DATA_CONTRACT.md`](docs/BI_DATA_CONTRACT.md) — contrato, significado e limites dos indicadores do Power BI.
- [`docs/INFOBIP_RULES.md`](docs/INFOBIP_RULES.md) — contratos e evidências do provedor de mensagens.
- [`docs/INFOBIP_AUTOMATIONS.md`](docs/INFOBIP_AUTOMATIONS.md) — conteúdo e regras de atendimento que ainda dependem de revisão/homologação.
