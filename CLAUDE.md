# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**No implementation code exists yet.** The repo was fully reset from a prior
architecture (Meta Cloud API + Express + Socket.io, and an unimplemented
Twilio + Next.js + Supabase line) — none of that survives. Everything here is
documentation for the rebuild in progress. Before writing code, read:

- `docs/PRD_PhysioVilas_WhatsApp.md` — the single source of truth, product
  framing **and** all technical architecture decisions (stack, routes,
  coexistence, scheduling, schema, env vars, risks).
- `docs/BACKLOG.md` — the ticket breakdown, organized by delivery activity
  (`AT1`–`AT4`), in dependency order (`SET-01` first: confirming the real
  Infobip webhook/send payloads before coding anything against them).

## Architecture (planned — not yet built)

**Backend-only, no frontend, no auth, no bot logic in code.** The project is
reduced to a connector between Infobip (WhatsApp channel, FAQ/bot, templates
— all configured on Infobip's platform, not here) and Neon (Postgres), plus
outbound sends back through Infobip. Reading/reporting on the data happens in
Power BI, connected directly to Neon — this repo has no read/list endpoints.

```
Patient (WhatsApp) → Infobip → POST /webhook/infobip → backend → Neon
                                                      ↖ POST /messages, /messages/template → Infobip API
Power BI → direct Postgres connection → Neon
```

Planned stack: Node.js + Express (ESM, `"type": "module"`, same style as the
removed backend), packaged as a Vercel Serverless Function (no Next.js — API
only). No Socket.io, no real-time layer — there is no UI to push updates to.

Planned routes (none implemented yet):
- `POST /webhook/infobip` — receive inbound messages / status updates, persist to Neon.
- `POST /messages`, `POST /messages/template` — send via Infobip's API.
- `GET /health`.

### Schema is a public interface

Power BI reads directly from the Neon tables — there's no API layer in
between for reporting. Treat table/column names as a contract: renaming one
silently breaks a Power BI report rather than failing loudly like an API
consumer would. See `PRD_PhysioVilas_WhatsApp.md` section 5 for the current
schema (`contacts`, `messages`) and the read-only `powerbi_reader` role.

### Open questions before coding the Infobip integration

`docs/PRD_PhysioVilas_WhatsApp.md` section 7 (Riscos e pendências) /
`BACKLOG.md` `SET-01` list what must be confirmed against the real Infobip
account before writing the parser or client: exact webhook payload shape,
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

No `package.json` exists yet — nothing to install or run until `SET-01`/`API-01`
land. Once the scaffold exists, update this section with the real commands.
