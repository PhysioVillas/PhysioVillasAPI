# ChatManager

Backend de integração WhatsApp para a **[Physiovilas](https://www.physiovilas.com.br/)**,
clínica de saúde ortopédica (fisioterapia, RPG, Pilates, massoterapia,
reabilitação pélvica, osteopatia e microfisioterapia) com mais de 20 anos de
atuação na região metropolitana de Salvador/BA (unidades em Lauro de
Freitas, Busca Vida e Vilas do Atlântico).

## Ideia do projeto

O ChatManager é o **elo de dados** entre o WhatsApp da clínica e o Power BI:
recebe mensagens via **Infobip**, grava no **Neon (Postgres)** e permite
enviar mensagens/templates de volta. Não é um bot, não tem frontend, não tem
login — atendimento automático, FAQ e templates são configurados **na própria
plataforma Infobip**, e a consulta/análise dos dados é feita pelo **Power
BI**, conectado direto no Neon.

> Contexto completo do produto e arquitetura técnica: [`docs/PRD_PhysioVilas_WhatsApp.md`](docs/PRD_PhysioVilas_WhatsApp.md)
> Backlog de tickets: [`docs/BACKLOG.md`](docs/BACKLOG.md)

## Status atual

**API-01 concluída localmente.** Há um scaffold
Node.js/Express em ESM, com `GET /health`, `GET /health/ready` e export default
compatível com Vercel. A integração segura contém apenas a validação sem envio
da Messages API; o schema PostgreSQL está versionado e foi aplicado no Neon de
homologação.

`GET /health/ready` só retorna sucesso quando o banco configurado contém
`contacts`, `messages`, `reporting.daily_message_metrics` e a coluna de
atualização de entrega; ele não mostra
detalhes de conexão quando a verificação falha.
O receptor local de webhook normaliza eventos de entrada conhecidos e permanece
desligado até banco e token de webhook serem configurados.
O endpoint interno de validação de mensagens permanece desligado até receber as
credenciais da Infobip e um token próprio; ele não possui operação de envio.

Em 2026-09-18, um template sandbox da API WhatsApp dedicada da Infobip foi
aceito (HTTP 200) e recebido no número verificado do trial. Isso valida apenas
o remetente sandbox e a entrega inicial: não houve deploy, banco de dados,
webhook ou envio pelo código deste repositório. Também não valida o contrato da
Messages API adotada para produção.
O ticket permanece em andamento porque a Definição de Pronto exige OpenAPI em
`/docs`; essa superfície pertence ao `API-05`, que depende de `API-02` e
`API-03`. O detalhamento e as evidências disponíveis estão em
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

O app Express já foi publicado em preview isolado na Vercel, sem banco,
credenciais Infobip ou domínio próprio. A próxima publicação de homologação só
receberá `DATABASE_URL` do Neon; as integrações Infobip permanecem desligadas.
Veja a sequência e os limites em [`docs/HOMOLOGATION.md`](docs/HOMOLOGATION.md) e a
[documentação da Vercel para Express](https://vercel.com/docs/frameworks/backend/express).

## Arquitetura (planejada)

```
Paciente (WhatsApp)
      │
      ▼
  Infobip (canal, FAQ/bot, templates)
      │
      ├── POST webhook ──▶ Backend (Node/Express, serverless na Vercel) ─▶ Neon
      └── API de envio  ◀── Backend chama a Infobip para enviar mensagem/template

Power BI ──── conexão Postgres direta ────▶ Neon
```

- **Backend:** Node.js + Express, empacotado como Serverless Function na
  **Vercel** (sem Next.js — só a API).
- **Banco:** **Neon** (Postgres serverless).
- **Canal WhatsApp:** **Infobip** (conta e canal já configurados).
- **Consulta/BI:** **Power BI**, conectado direto ao Neon via conector
  Postgres nativo.
- **Sem** frontend, sem autenticação, sem tempo real (Socket.io).

Detalhes completos: [`docs/PRD_PhysioVilas_WhatsApp.md`](docs/PRD_PhysioVilas_WhatsApp.md).

## Documentação

- [`docs/PRD_PhysioVilas_WhatsApp.md`](docs/PRD_PhysioVilas_WhatsApp.md) — escopo do produto e arquitetura técnica (rotas, schema, coexistência, agendamento, riscos).
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — tickets de desenvolvimento.
- [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) — registro factual do estado da implementação e das lacunas de evidência.
- [`docs/INFOBIP_RULES.md`](docs/INFOBIP_RULES.md) — evidências de integração
  Infobip e lacunas ainda abertas.
- [`docs/INFOBIP_AUTOMATIONS.md`](docs/INFOBIP_AUTOMATIONS.md) — pacote
  versionado de templates, menu, FAQ e lembretes, conciliado com os protótipos
  anteriores sem ativar nenhuma automação.
