# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**API-01 is complete locally.** The Express/ESM scaffold exports the
application, `GET /health` is implemented, and Swagger UI is available at
`/docs` with its OpenAPI 3.1 specification at `/docs.json`. The recorded local
validation passed `npm run check` and `npm test` (27/27 tests) on 2026-09-19.

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
migration; none sends messages or connects to a live database by default.
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

## Architecture

**Backend-only, no frontend, no end-user login, no bot logic in code.** The project is
reduced to a connector between Infobip (WhatsApp channel, FAQ/bot, templates
— all configured on Infobip's platform, not here) and Neon (Postgres), plus
outbound sends back through Infobip. Reading/reporting on the data happens in
Power BI, connected directly to Neon — this repo has no read/list endpoints.

```
Patient (WhatsApp) → Infobip → POST /webhooks/infobip/inbound → backend → Neon
                                                               ↖ POST /messages/validate → Infobip validation API
Power BI → direct Postgres connection → Neon
```

Planned stack: Node.js + Express (ESM, `"type": "module"`, same style as the
removed backend), packaged as a Vercel Serverless Function (no Next.js — API
only). No Socket.io, no real-time layer — there is no UI to push updates to.

Routes:
- `GET /health` — health check.
- `GET /docs` and `GET /docs.json` — Swagger UI and OpenAPI specification.
- `POST /webhooks/infobip/inbound` — receives the documented inbound envelope;
  it remains disabled until database and webhook Bearer token are configured.
- `POST /messages/validate` — protected, validation-only endpoint for text and
  optional `sendAt`; there is no send route or real send implementation.

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
  scheduled) — not just for scheduling — so there is no separate WhatsApp-
  dedicated send client. What's still unconfirmed and must be verified
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
```

Run `npm run check` and `npm test` after every code change. The test suite
covers health, OpenAPI, protected webhook and validation routes, Infobip
validation payloads, and database schema invariants.
