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

**Reestruturação em andamento — sem código ainda.** O projeto anterior
(Meta Cloud API + Express + Socket.io, e uma linha não implementada de
Twilio + Next.js + Supabase) foi descartado por completo. A implementação
recomeça do zero conforme `docs/PRD_PhysioVilas_WhatsApp.md`.

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
- `docs/INFOBIP_RULES.md` — referência da API da Infobip (a escrever, ver `SET-01` no backlog).
