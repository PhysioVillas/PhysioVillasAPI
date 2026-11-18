# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**POC chatbot implemented (2026-11-18).** Waves 1–5 of `plan-backlog.md` are
merged: the bot engine answers the inbound webhook, books/reschedules/cancels
on the mock clinic in `clinica_simulada`, and migrations 010–014 are applied
to Neon production. Local validation: `npm run check` and `npm test` green.
Pending: Vercel deploy and the rehearsal on the test number (G3).

One Infobip sandbox template request was accepted (HTTP 200) and received by
the verified trial recipient on 2026-09-18. It used the platform's dedicated
WhatsApp test endpoint, outside this repository; it does not validate the
Messages API contract chosen for production, a deployment, database, or
real webhook delivery.

`docs/INFOBIP_RULES.md` records the sandbox evidence available so far and the
remaining gaps for payloads, webhook security, and template contracts.
`docs/INFOBIP_AUTOMATIONS.md` is the versioned configuration package for
AUT-01 through AUT-04. The repository has a validation-only Messages API
client, a protected webhook receiver, and a versioned initial database
migration set; the inbound webhook now runs the bot and sends session replies
when `DATABASE_URL` and the Infobip send config exist.
Before writing further integration code, read:

- `docs/PRD_PhysioVilas_WhatsApp.md` — the single source of truth, product
  framing **and** all technical architecture decisions (stack, routes,
  coexistence, scheduling, schema, env vars, risks).
- `docs/BACKLOG.md` — the ticket breakdown, organized by delivery activity
  (`AT1`–`AT4`), in dependency order (`SET-01` first: confirming the real
  Infobip webhook/send payloads before coding anything against them).
- `docs/IMPLEMENTATION_STATUS.md` — dated implementation facts and the
  remaining evidence gaps.
- `docs/INFOBIP_RULES.md` — observed Infobip behavior, with production
  assumptions kept explicitly out of the record.
- `docs/INFOBIP_AUTOMATIONS.md` — templates, triage, FAQ and reminder
  configuration prepared for the Infobip platform.

## POC decisions (2026-11-18) — read before changing the bot

The system is a **POC for an investor presentation**, with no real patients.
These decisions hold **until the end of the POC**; don't "fix" them without
the user asking:

- **The inbound webhook runs without authentication.**
  `allowUnauthenticatedInbound: true` stays in `src/bootstrap.js`. The bot's
  patient scheduling flows (book, reschedule, cancel) will also run without
  an authenticated webhook. Accepted risk: anyone who knows the URL can forge
  messages and change appointments, which is acceptable only because the data
  is mock. Before any use with real patients, HMAC
  (`src/middleware/infobipWebhookAuth.js`) becomes mandatory again.
- **The bot is self-sufficient on the mock data in `clinica_simulada`.** It
  reads and writes there (appointments, patients, leads) and confirms
  bookings without human validation.
- **Message retention is unlimited.** Nothing is purged, so the Power BI
  history stays intact for the presentation.
- The full plan (CPF identification, 24 h rule, support hours 08:00–18:00,
  `bot_config` table, handoff reasons) is in `plan.md`.

## Architecture

**Backend-only, no frontend, no end-user login.** The backend connects
Infobip (WhatsApp channel and templates) to Neon (Postgres) and, since the
POC (2026-11-18), runs the **patient chatbot in code** (see "Bot engine"
below). Reading/reporting happens in Power BI, connected directly to Neon —
this repo has no read/list endpoints.

```
Patient (WhatsApp) → Infobip → POST /webhooks/infobip/inbound → backend → Neon
                                     ↓ bot engine (flows)          ↑ public + clinica_simulada
                     Infobip dedicated WhatsApp API ← replies
Power BI → direct Postgres connection → Neon (public, reporting, bi_simulado)
```

Stack: Node.js + Express (ESM, `"type": "module"`), packaged as a Vercel
Serverless Function (no Next.js — API only). No Socket.io, no real-time layer.

Routes:
- `GET /health` — health check.
- `GET /docs` and `GET /docs.json` — Swagger UI and OpenAPI specification.
- `POST /webhooks/infobip/inbound` — receives the inbound envelope, persists
  it (CPF masked) and runs the bot. Needs the database configured and, during
  the POC, accepts requests without authentication (see "POC decisions").
- `POST /messages/validate` — protected, validation-only endpoint for text and
  optional `sendAt`.

### Bot engine (replaces the old FAQ bot, 2026-11-18)

Wired in `src/services/bot/index.js` (`createBot`) and called from
`src/routes/infobipWebhooks.js` only for newly inserted inbound messages (an
Infobip retry with the same `messageId` never gets a second reply).

- **Engine** `src/services/bot/engine.js` — state machine; its header comment
  is the flow contract. Order: open handoff → silence (MENU reopens);
  urgency → SAMU 192 text + handoff; human/payment/clinical/document intents →
  handoff; `<flow>:<step>|<value>` ids → owning flow; active state → flow;
  otherwise menu. It returns replies and never sends.
- **Flows** `src/services/bot/flows/`: `menu`, `faq`, `booking`,
  `my_appointments` (CPF, reschedule, cancel, 24 h rule) and `triage` (new
  patient signup). No generative AI answers patients.
- **Support modules**: `intents.js` (keywords; bare "dor" is not clinical),
  `cpf.js`, `businessHours.js`, `replies.js` (WhatsApp limits, list paging),
  `stateStore.js` (`conversation_state`), `handoffRepository.js` (`handoffs`),
  `sender.js` (replies → dedicated WhatsApp API
  `/whatsapp/1/message/text|interactive/list|interactive/buttons`; the API key
  needs a WhatsApp send scope), `src/config/botConfig.js` (`bot_config` table,
  60 s cache, defaults when missing).
- **Clinic repositories** `src/services/clinic/` read and write the mock
  clinic in schema `clinica_simulada`: `catalogRepository.js`,
  `appointmentRepository.js` (advisory lock per slot, 24 h rules, audit to
  `clinica_simulada.audit_log` with `actor_scope='chatbot'`, one
  `clinica_simulada.conversations` row per booking because
  `agendamento_chatbot.conversation_id` is unique) and `patientRepository.js`.
  `db/poc/clinica_simulada_schema.sql` is a reference snapshot of that schema
  (not a migration).
- **CPF is never persisted in clear**: the webhook masks it
  (`***.***.***-NN`) in `messages.body` and `contacts.profile_name`; the engine
  sees the original only in memory; nothing logs CPF or names.
- **Silence**: the bot stays silent for `handoff_silence_hours` (12 h) while a
  handoff is open. A team reply from the Business App opens a
  `team_takeover` handoff if none is open. The keyword `MENU` closes the
  handoff and brings the menu back.
- **Persistence for BI**: replies keep the old `message_type` values (lists →
  `faq_menu`, text/buttons → `faq_answer`, handoff text → `faq_handoff`);
  `conversations.current_intent` follows the flow; each reply writes a
  `whatsapp_flow_events` `bot_step_sent` row with `step_key = '<flow>:<step>'`
  (allowed by migration 014). Views in `reporting.bot_*` (014) feed Power BI.
- **Runtime config** lives in table `bot_config` (support hours, 24 h notice,
  CPF attempts, timeouts), not in env vars.
- **Reminders (T19, off by default)**: `src/services/bot/reminders.js` +
  `npm run schedule-reminders` (dry-run report; `-- --send` only with
  `BOT_REMINDERS_ENABLED=true` and `BOT_REMINDERS_ALLOWED_WA_IDS` set; see
  `.env.example`). Schedules template sends with `sendAt` for `Agendado`
  appointments 24 h / 4 h ahead, idempotent via
  `clinica_simulada.messages.infobip_message_id = BOT_REMINDER_<id>_<h>H`. No
  cron is configured. Buttons Confirmo/Remarcar/Cancelar arrive as
  `my_appointments:reminder|…` and identify the patient by `wa_id` (no CPF).
  **Unconfirmed against the Infobip account** (do not treat as facts): the
  approved template name/language/variables (`lembrete_consulta` vs AUT-01's
  `physiovilas_appointment_reminder_v1`), its quick-reply buttons, how a
  button click arrives inbound (assumed `type: BUTTON` with `payload`), the
  per-destination `messageId` in the send response, WhatsApp `sendAt` limits
  and cancelling a scheduled send.
- The old `src/services/faqBot.js` and the `public` agenda path
  (`appointmentService.js`) are kept in the repo but no longer wired.
- Demo walkthrough: `docs/POC_DEMO_SCRIPT.md`. Wave plan and decisions:
  `plan.md`, `plan-backlog.md`.

### Migrations

`npm run migrate` applies `db/migrations/*.sql` in order and records each
file's checksum in `schema_migrations` — never edit an applied migration.
010–014 (bot runtime, clinic POC prep, schedule extension, FAQ content, bot
reporting) were applied to Neon production on 2026-11-18. Anything touching
`clinica_simulada` must sit inside
`do $$ begin if to_regnamespace('clinica_simulada') is not null then … end if; end $$;`
so preview databases without that schema still migrate.
`npm run extend-schedule` extends the mock clinic calendar/capacity.

### Schema is a public interface

Power BI reads directly from the Neon tables — there's no API layer in
between for reporting. Treat table/column names as a contract: renaming one
silently breaks a Power BI report rather than failing loudly like an API
consumer would. See `PRD_PhysioVilas_WhatsApp.md` section 5 for the current
schema (`contacts`, `messages`) and the read-only `powerbi_reader` role.

### Open questions before coding the Infobip integration

`docs/PRD_PhysioVilas_WhatsApp.md` section 7 (Riscos e pendências) /
`BACKLOG.md` `SET-01` list what must be confirmed against the real Infobip
account before expanding the parser or implementing sending: exact webhook payload shape,
status update format, how the sender/`wa_id` is formatted (do not assume it
matches the old Meta format — verify against a real payload), webhook
security mechanism, and the send/template API contracts. Don't guess these
from the old Meta Cloud API docs — Infobip is a different BSP with its own
payload shapes.

Two additional features are confirmed as required, each with its own
unresolved gap (`PRD_PhysioVilas_WhatsApp.md` section 4.3/4.4,
`BACKLOG.md` `SET-04`/`SET-05`):

- **WhatsApp Business App coexistence** — the clinic keeps using the phone
  app on the same number connected to the API. Confirmed via public Infobip
  docs (Embedded Signup with `featureType: whatsapp_business_app_onboarding`),
  but the exact webhook payload for the `smb_message_echoes` event (messages
  sent from the phone app) and for history-sync events is **not publicly
  documented** — don't invent field names for these; they must come from a
  real webhook capture against the account. The webhook parser (`API-02`)
  needs to handle these payload shapes from day one, not as a later addition,
  because the clinic's migration is conditioned on coexistence working.
- **Scheduled message sending** — a route initially assumed to be
  `POST /whatsapp/1/events` ("Send WhatsApp events") was verified against
  Infobip's public OpenAPI spec to be unrelated to scheduling — it only
  supports `TYPING_INDICATOR` content; do not use it. The real, **confirmed**
  mechanism is the **Messages API** (`POST /messages-api/1/messages`,
  omnichannel — routes by a `channel` field, e.g. `"WHATSAPP"`), with an
  optional `sendAt` field (present = scheduled, absent = immediate send).
  User provided and verified a working example payload — see
  `PRD_PhysioVilas_WhatsApp.md` section 4.4. **Decision: this Messages API
  is now the single client used for all sends** (text, template, and
  scheduled) — not just for scheduling. Exception: the bot's interactive
  session replies (text, lists, buttons) go through the dedicated WhatsApp
  API, as described in "Bot engine". What's still unconfirmed and must be verified
  against the real account before implementing `API-03`/`API-05`: the exact
  `content` shape for templates, whether the Messages API's inbound webhook
  (patient replies) matches the dedicated WhatsApp API's format or needs its
  own parser branch in `API-02`, whether a per-destination `messageId` is
  returned for idempotency, and whether WhatsApp has its own `sendAt` limit
  (180 days is documented for other channels like SMS, not confirmed for
  WhatsApp). Do not invent answers to these — they require a live test
  against the account. Also: `POST /omni/1/advanced` is a different, older
  OMNI failover endpoint — unrelated, do not use it here.

## Commands

```bash
npm run start
npm run dev
npm run check
npm test
npm run migrate
npm run extend-schedule
```

Run `npm run check` and `npm test` after every code change. `npm run check`
syntax-checks every `.js` under `src/` and `scripts/` (`scripts/check.js`).
The test suite covers health, OpenAPI, webhook and validation routes, the bot
engine and flows (fake pool and fake Infobip client), clinic repositories,
Infobip payloads and migration/schema invariants.
