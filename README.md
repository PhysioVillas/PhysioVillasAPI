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

O código local agora inclui uma agenda transacional: pedidos do paciente identificam serviço, profissional e horário; a API consulta as vagas do banco; a equipe confirma, cancela, remarca e registra comparecimento pelo WhatsApp Business compartilhado. Mensagens comuns não mudam uma consulta. Isso ainda depende da migration 009 estar aplicada no banco de produção e da autenticação do webhook estar configurada e validada no Infobip e na Vercel.

## Componentes

- **API:** Node.js + Express em módulos ESM, executável localmente e compatível com Vercel Functions.
- **WhatsApp:** webhooks e envio de mensagens pelo provedor configurado no backend. As regras de atendimento ficam no ChatManager.
- **Banco:** Neon/PostgreSQL. As migrations versionam contatos, conversas, mensagens, eventos do fluxo, catálogo e grade de agenda, solicitações, consultas e eventos de ciclo de vida. A migration 009 foi validada em PostgreSQL descartável; sua aplicação no Neon de produção é uma etapa separada.
- **BI:** o projeto Power BI contém páginas/modelo para mensagens, fluxo, resposta humana e agenda (pedidos, consultas por serviço/profissional, comparecimento e vagas). Ele lê somente views agregadas em `reporting`. O relatório só pode ser tratado como operacional depois da migration 009, das credenciais somente leitura e de uma atualização bem-sucedida no Power BI Service.
- **Documentação da API:** `GET /docs` e `GET /docs.json`.

As rotas de envio são internas e dependem de token próprio, banco e configuração do provedor. O webhook precisa validar uma assinatura HMAC compatível com o Infobip (ou, enquanto HMAC não estiver configurado, o token Bearer legado) antes de aceitar eventos. Em produção, configure o mesmo segredo HMAC na Vercel e na autenticação do webhook do Infobip antes de publicar alterações que dependam desse modo; não habilite comandos de agenda até confirmar a validação ponta a ponta.

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
