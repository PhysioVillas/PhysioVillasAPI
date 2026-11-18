// Lembretes ativos de consulta com confirmação (T19, plan.md 6.6).
//
// O que faz: seleciona consultas `Agendado` de clinica_simulada cujo
// lembrete (`config.reminderHoursBefore`, padrão [24, 4] h antes, fuso
// America/Bahia) vence na próxima janela de execução, e agenda o template
// pela Messages API com `sendAt`. Quem roda é `scripts/schedule-reminders.js`
// (manual ou por cron); não há rota HTTP.
//
// Flag e segurança (tudo DESLIGADO por padrão):
//   BOT_REMINDERS_ENABLED=true        liga o envio (qualquer outro valor = off)
//   BOT_REMINDERS_ALLOWED_WA_IDS=a,b  números de teste aprovados na Infobip;
//                                     no modo envio, só eles recebem. Vazio =
//                                     nada é enviado (plan.md 6.6: na POC, só
//                                     números de teste).
//   BOT_REMINDER_TEMPLATE_NAME        padrão `lembrete_consulta`
//   BOT_REMINDER_TEMPLATE_LANGUAGE    padrão `pt_BR`
//   BOT_REMINDERS_WINDOW_MINUTES      padrão 60 (intervalo do cron)
// Modos: flag off → `disabled` (só relatório); flag on sem `--send` →
// `dry_run` (só relatório); flag on + `--send` → `send`. Nos dois primeiros
// nada é gravado nem enviado.
//
// Contrato Infobip usado (docs/INFOBIP_RULES.md, conferido em 2026-09-20):
// só `channel`, `sender`, `destinations[].to`, `template.templateName`,
// `template.language`, `content.body` TEXT com parâmetros numerados e
// `sendAt` — via `buildTemplateMessage` de infobipMessagesClient.js.
// NÃO confirmado e por isso fora do payload: botões do template em `content`
// (os quick replies Confirmo/Remarcar/Cancelar vêm do template aprovado na
// Meta; não mandamos payload próprio), `messageId` informado pelo cliente,
// limite de `sendAt` para WhatsApp e o formato da resposta de envio.
// Parâmetros: {{1}} primeiro nome, {{2}} data dd/mm/aaaa, {{3}} hora HH:00
// (AUT-01 de docs/INFOBIP_AUTOMATIONS.md); a linha mock de
// message_templates diz parameter_count = 1 — conferir no template real.
//
// Idempotência sem coluna nova: a chave determinística
// `BOT_REMINDER_<agendamento_id>_<horas>H` vai em
// clinica_simulada.messages.infobip_message_id (UNIQUE), seguindo o padrão
// `SIM_REMINDER_<id>` da simulação. A linha é reservada (insert ... on
// conflict do nothing, sob advisory lock) ANTES da chamada à Infobip: é no
// máximo uma vez. Falha da Infobip deixa o disparo `failed` e não é
// re-tentada automaticamente.
//
// Gravação (só no modo send): messages (direction out, sent_via api,
// message_type template, body nulo) → dispatches (template_id, scheduled_for)
// → dispatch_events (created, scheduled|failed) e, se a consulta foi marcada
// pelo bot e ainda não tem disparo, agendamento_chatbot.dispatch_id (para o
// BI ligar disparo → consulta). lembrete_enviado não é alterado ao agendar
// (a simulação mantém nulo enquanto o disparo está `scheduled`).
//
// Resposta aos botões: ids `my_appointments:reminder|confirm|reschedule|cancel`.
// `templateButtonReplyId` traduz o payload/texto do quick reply (formato do
// inbound de template ainda não capturado) para esses ids.

const DEFAULT_TIMEZONE = 'America/Bahia';
const DEFAULT_TEMPLATE_NAME = 'lembrete_consulta';
const DEFAULT_TEMPLATE_LANGUAGE = 'pt_BR';
const DEFAULT_WINDOW_MINUTES = 60;
const MAX_WINDOW_MINUTES = 7 * 24 * 60;
// O sendAt precisa estar no futuro quando a Infobip recebe o pedido.
const MIN_LEAD_MINUTES = 2;
const KEY_PREFIX = 'BOT_REMINDER_';
const ACTOR_SCOPE = 'chatbot';

export const REMINDER_FLOW = 'my_appointments';
export const REMINDER_STEP = 'reminder';

export const REMINDER_ACTIONS = Object.freeze(['confirm', 'reschedule', 'cancel']);

// Títulos dos quick replies do template (plan.md 6.6).
export const REMINDER_BUTTON_TITLES = Object.freeze({
  confirm: 'Confirmo',
  reschedule: 'Remarcar',
  cancel: 'Cancelar',
});

const BUTTON_ALIASES = Object.freeze({
  confirmo: 'confirm',
  confirmar: 'confirm',
  confirm: 'confirm',
  remarcar: 'reschedule',
  reschedule: 'reschedule',
  cancelar: 'cancel',
  cancel: 'cancel',
});

const PREFIXED_ID = /^[a-z][a-z0-9_]*:[a-z0-9_]+\|/;

function normalizeLabel(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function reminderReplyId(action, appointmentId) {
  if (!REMINDER_ACTIONS.includes(action)) {
    throw new RangeError(`Unknown reminder action: ${action}`);
  }
  const suffix = appointmentId === undefined || appointmentId === null ? '' : `:${appointmentId}`;
  return `${REMINDER_FLOW}:${REMINDER_STEP}|${action}${suffix}`;
}

/** Lê o valor `confirm[:<id>]` de um id `my_appointments:reminder|...`. */
export function parseReminderValue(value) {
  const match = /^(confirm|reschedule|cancel)(?::(\d+))?$/.exec(String(value ?? ''));
  return match ? { action: match[1], appointmentId: match[2] === undefined ? null : Number(match[2]) } : null;
}

/**
 * Id do engine para o clique num quick reply de template. Aceita, nessa
 * ordem: id já no padrão `<flow>:<step>|…`; payload ou texto igual a um dos
 * botões do lembrete ("Confirmo", "Remarcar", "Cancelar"). Senão, devolve o
 * payload original (ou null).
 */
export function templateButtonReplyId(payload, text) {
  for (const candidate of [payload, text]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      continue;
    }
    if (PREFIXED_ID.test(candidate.trim())) {
      return candidate.trim();
    }
    const action = BUTTON_ALIASES[normalizeLabel(candidate)];
    if (action) {
      return reminderReplyId(action);
    }
  }
  return typeof payload === 'string' && payload.trim() !== '' ? payload.trim() : null;
}

// ---------------------------------------------------------------------------
// Configuração (env)
// ---------------------------------------------------------------------------

function readOptional(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function readReminderSettings(env = process.env) {
  const windowRaw = readOptional(env, 'BOT_REMINDERS_WINDOW_MINUTES');
  const windowMinutes = windowRaw === undefined ? DEFAULT_WINDOW_MINUTES : Number(windowRaw);
  if (!Number.isInteger(windowMinutes) || windowMinutes <= MIN_LEAD_MINUTES || windowMinutes > MAX_WINDOW_MINUTES) {
    throw new TypeError(`BOT_REMINDERS_WINDOW_MINUTES must be an integer between ${MIN_LEAD_MINUTES + 1} and ${MAX_WINDOW_MINUTES}.`);
  }
  const allowed = (readOptional(env, 'BOT_REMINDERS_ALLOWED_WA_IDS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    enabled: readOptional(env, 'BOT_REMINDERS_ENABLED')?.toLowerCase() === 'true',
    allowedWaIds: new Set(allowed),
    templateName: readOptional(env, 'BOT_REMINDER_TEMPLATE_NAME') ?? DEFAULT_TEMPLATE_NAME,
    language: readOptional(env, 'BOT_REMINDER_TEMPLATE_LANGUAGE') ?? DEFAULT_TEMPLATE_LANGUAGE,
    windowMinutes,
  };
}

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------

export function reminderKey(appointmentId, hoursBefore) {
  return `${KEY_PREFIX}${Number(appointmentId)}_${Number(hoursBefore)}H`;
}

export function normalizeHoursBefore(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map(Number).filter((hours) => Number.isInteger(hours) && hours > 0))]
    .sort((a, b) => b - a);
}

export function maskWaId(waId) {
  const digits = String(waId ?? '');
  return digits.length <= 4 ? '****' : `***${digits.slice(-4)}`;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Invalid date.');
  }
  return date;
}

/** Instante do lembrete em ISO 8601 UTC, com segundos (aceito por validateSendAt). */
export function reminderSendAt(startsAt, hoursBefore) {
  const at = new Date(toDate(startsAt).getTime() - Number(hoursBefore) * 3600000);
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Parâmetros {{1}} nome, {{2}} dd/mm/aaaa, {{3}} HH:00 (AUT-01). */
export function reminderParameters({ firstName, date, hour }) {
  const [year, month, day] = String(date).slice(0, 10).split('-');
  return [
    typeof firstName === 'string' && firstName.trim() !== '' ? firstName.trim() : 'paciente',
    `${day}/${month}/${year}`,
    `${String(Number(hour)).padStart(2, '0')}:00`,
  ];
}

/** Argumentos de `sendTemplateMessage` (contrato confirmado + sendAt). */
export function buildReminderMessage({ sender, candidate, settings }) {
  return {
    sender,
    to: candidate.waId,
    templateName: settings.templateName,
    language: settings.language,
    parameters: reminderParameters(candidate),
    sendAt: candidate.sendAt,
  };
}

// ---------------------------------------------------------------------------
// SQL (marcador /* t19:<nome> */ identifica a consulta nos testes)
// ---------------------------------------------------------------------------

const STARTS_AT = `((a.data + make_interval(hours => a.hora::int)) at time zone $2)`;

export const REMINDER_SQL = Object.freeze({
  // $1 now, $2 tz, $3 janela (min), $4 horas antes (int[]), $5 antecedência
  // mínima (min), $6 dias à frente a varrer (limite barato em a.data)
  candidates: `/* t19:candidates */
    select a.agendamento_id, a.paciente_id, h.horas,
           to_char(a.data, 'YYYY-MM-DD') as data, a.hora,
           ${STARTS_AT} as starts_at,
           coalesce(ac.wa_id, j.wa_id) as wa_id,
           coalesce(ac.conversation_id, j.conversation_id) as conversation_id,
           (a.canal_marcacao = 'Chatbot') as pelo_bot,
           (ac.agendamento_id is not null and ac.dispatch_id is null) as sem_disparo,
           split_part(p.paciente, ' ', 1) as first_name,
           exists (
             select 1 from clinica_simulada.messages m
              where m.infobip_message_id = '${KEY_PREFIX}' || a.agendamento_id || '_' || h.horas || 'H'
           ) as ja_agendado
    from unnest($4::int[]) as h(horas)
    join clinica_simulada.f_agendamentos a
      on a.status = 'Agendado'
     and a.data between ($1::timestamptz at time zone $2)::date
                    and ($1::timestamptz at time zone $2)::date + $6::int
     and ${STARTS_AT} - make_interval(hours => h.horas) > $1::timestamptz + make_interval(mins => $5::int)
     and ${STARTS_AT} - make_interval(hours => h.horas) <= $1::timestamptz + make_interval(mins => $3::int)
    left join clinica_simulada.agendamento_chatbot ac on ac.agendamento_id = a.agendamento_id
    left join lateral (
      select jc.wa_id, jc.conversation_id
        from clinica_simulada.jornada_contatos jc
       where jc.paciente_id = a.paciente_id
       order by jc.wa_id
       limit 1
    ) j on true
    left join clinica_simulada.d_pacientes p on p.paciente_id = a.paciente_id
    where coalesce(ac.wa_id, j.wa_id) is not null
    order by starts_at, a.agendamento_id, h.horas desc`,

  template: `/* t19:template */
    select id from clinica_simulada.message_templates
     where name = $1 and language = $2 limit 1`,

  lock: `/* t19:lock */ select pg_advisory_xact_lock(hashtextextended($1, 0))`,

  // $1 chave, $2 wa_id, $3 conversa|null, $4 now
  reserveMessage: `/* t19:reserve_message */
    insert into clinica_simulada.messages
      (infobip_message_id, wa_id, direction, sent_via, body, message_type, status,
       conversation_id, created_at)
    values ($1, $2, 'out', 'api', null, 'template', 'pending', $3, $4)
    on conflict (infobip_message_id) do nothing
    returning id`,

  // $1 message_id, $2 template_id|null, $3 scheduled_for, $4 now
  insertDispatch: `/* t19:insert_dispatch */
    insert into clinica_simulada.dispatches
      (message_id, template_id, status, scheduled_for, created_at, updated_at)
    values ($1, $2, 'pending', $3, $4, $4)
    returning id`,

  // $1 dispatch, $2 event_type, $3 detail, $4 now
  dispatchEvent: `/* t19:dispatch_event */
    insert into clinica_simulada.dispatch_events (dispatch_id, event_type, detail, occurred_at)
    values ($1, $2, $3, $4)`,

  // $1 agendamento, $2 dispatch
  linkDispatch: `/* t19:link_dispatch */
    update clinica_simulada.agendamento_chatbot
       set dispatch_id = $2
     where agendamento_id = $1 and dispatch_id is null`,

  // $1 dispatch, $2 status, $3 now
  updateDispatch: `/* t19:update_dispatch */
    update clinica_simulada.dispatches
       set status = $2, updated_at = $3,
           dispatched_at = case when $2 = 'sent' then $3 else dispatched_at end
     where id = $1`,

  // $1 message, $2 status, $3 error_code|null, $4 now
  updateMessage: `/* t19:update_message */
    update clinica_simulada.messages
       set status = $2, error_code = $3, status_updated_at = $4
     where id = $1`,

  // $1 agendamento, $2 paciente
  confirm: `/* t19:confirm */
    update clinica_simulada.f_agendamentos
       set lembrete_confirmado = 'Sim',
           lembrete_enviado = coalesce(lembrete_enviado, 'Sim')
     where agendamento_id = $1 and paciente_id = $2 and status = 'Agendado'
    returning agendamento_id`,

  audit: `/* t19:audit */
    insert into clinica_simulada.audit_log (entity_type, entity_id, action, actor_scope, created_at)
    values ('agendamento', lpad(to_hex($1::bigint), 32, '0')::uuid, $2, '${ACTOR_SCOPE}', $3)`,
});

function mapCandidate(row) {
  const startsAt = toDate(row.starts_at);
  const hoursBefore = Number(row.horas);
  return {
    appointmentId: Number(row.agendamento_id),
    patientId: row.paciente_id === null || row.paciente_id === undefined ? null : Number(row.paciente_id),
    hoursBefore,
    date: row.data,
    hour: Number(row.hora),
    startsAt,
    sendAt: reminderSendAt(startsAt, hoursBefore),
    waId: row.wa_id,
    conversationId: row.conversation_id ?? null,
    createdByBot: row.pelo_bot === true,
    linkDispatch: row.sem_disparo === true,
    firstName: row.first_name ?? null,
    alreadyScheduled: row.ja_agendado === true,
    key: reminderKey(row.agendamento_id, hoursBefore),
  };
}

// ---------------------------------------------------------------------------
// Repositório
// ---------------------------------------------------------------------------

export function createReminderRepository({ pool, clock = () => new Date(), timezone = DEFAULT_TIMEZONE } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createReminderRepository requires a pool with query().');
  }

  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // a falha original e mais util
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function listCandidates({ now, hoursBefore, windowMinutes = DEFAULT_WINDOW_MINUTES } = {}) {
    const hours = normalizeHoursBefore(hoursBefore);
    if (hours.length === 0) {
      return [];
    }
    const result = await pool.query({
      text: REMINDER_SQL.candidates,
      values: [
        toDate(now ?? clock()),
        timezone,
        windowMinutes,
        hours,
        MIN_LEAD_MINUTES,
        Math.ceil((windowMinutes / 60 + hours[0]) / 24) + 1,
      ],
    });
    return result.rows.map(mapCandidate);
  }

  async function findTemplateId({ name, language }) {
    const result = await pool.query({ text: REMINDER_SQL.template, values: [name, language] });
    return result.rows[0]?.id ?? null;
  }

  /** Reserva a chave. Devolve { messageId, dispatchId } ou null se já existia. */
  async function reserve(candidate, { templateId = null, now } = {}) {
    const at = toDate(now ?? clock());
    return withTransaction(async (client) => {
      await client.query({ text: REMINDER_SQL.lock, values: [candidate.key] });
      const message = (await client.query({
        text: REMINDER_SQL.reserveMessage,
        values: [candidate.key, candidate.waId, candidate.conversationId ?? null, at],
      })).rows[0];
      if (!message) {
        return null;
      }
      const dispatch = (await client.query({
        text: REMINDER_SQL.insertDispatch,
        values: [message.id, templateId, candidate.sendAt, at],
      })).rows[0];
      await client.query({
        text: REMINDER_SQL.dispatchEvent,
        values: [dispatch.id, 'created', `reminder_${candidate.hoursBefore}h`, at],
      });
      if (candidate.linkDispatch) {
        await client.query({ text: REMINDER_SQL.linkDispatch, values: [candidate.appointmentId, dispatch.id] });
      }
      return { messageId: message.id, dispatchId: dispatch.id };
    });
  }

  /** status ∈ 'scheduled' | 'failed'. */
  async function markResult(reservation, { status, detail = null, errorCode = null, now } = {}) {
    const at = toDate(now ?? clock());
    return withTransaction(async (client) => {
      await client.query({ text: REMINDER_SQL.updateDispatch, values: [reservation.dispatchId, status, at] });
      await client.query({ text: REMINDER_SQL.updateMessage, values: [reservation.messageId, status, errorCode, at] });
      await client.query({
        text: REMINDER_SQL.dispatchEvent,
        values: [reservation.dispatchId, status, detail === null ? null : String(detail).slice(0, 120), at],
      });
    });
  }

  /** Botão "Confirmo": lembrete_confirmado = 'Sim' na consulta do paciente. */
  async function confirmAttendance({ patientId, appointmentId, now } = {}) {
    const at = toDate(now ?? clock());
    return withTransaction(async (client) => {
      const row = (await client.query({
        text: REMINDER_SQL.confirm,
        values: [Number(appointmentId), Number(patientId)],
      })).rows[0];
      if (!row) {
        return { ok: false, reason: 'not_found' };
      }
      await client.query({ text: REMINDER_SQL.audit, values: [Number(appointmentId), 'reminder_confirmed', at] });
      return { ok: true, appointmentId: Number(row.agendamento_id) };
    });
  }

  return { listCandidates, findTemplateId, reserve, markResult, confirmAttendance };
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

function infobipMessageIdOf(response) {
  const id = response?.messages?.[0]?.messageId ?? response?.messageId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Seleciona e (só no modo `send`) agenda os lembretes.
 * Devolve { mode, items: [{ appointmentId, hoursBefore, sendAt, to, createdByBot, status }], counts }.
 * Nenhum item traz nome, telefone completo ou corpo de mensagem.
 */
export async function scheduleReminders({
  repository,
  settings,
  botConfig,
  send = false,
  messagesClient,
  sender,
  clock = () => new Date(),
  logger = console,
} = {}) {
  if (!repository || !settings) {
    throw new TypeError('scheduleReminders requires repository and settings.');
  }
  const now = toDate(clock());
  const mode = !settings.enabled ? 'disabled' : send ? 'send' : 'dry_run';

  if (mode === 'send') {
    if (!messagesClient || typeof messagesClient.sendTemplateMessage !== 'function' || !sender) {
      throw new TypeError('Send mode requires an Infobip messages client and sender.');
    }
    if (settings.allowedWaIds.size === 0) {
      throw new TypeError('Send mode requires BOT_REMINDERS_ALLOWED_WA_IDS (test numbers approved on Infobip).');
    }
  }

  const cfg = typeof botConfig?.get === 'function' ? await botConfig.get() : botConfig ?? {};
  const hoursBefore = normalizeHoursBefore(cfg.reminderHoursBefore ?? [24, 4]);
  const candidates = await repository.listCandidates({ now, hoursBefore, windowMinutes: settings.windowMinutes });

  const templateId = mode === 'send'
    ? await repository.findTemplateId({ name: settings.templateName, language: settings.language })
    : null;

  const items = [];
  for (const candidate of candidates) {
    const item = {
      appointmentId: candidate.appointmentId,
      hoursBefore: candidate.hoursBefore,
      sendAt: candidate.sendAt,
      to: maskWaId(candidate.waId),
      createdByBot: candidate.createdByBot,
      status: null,
    };
    items.push(item);

    if (candidate.alreadyScheduled) {
      item.status = 'already_scheduled';
      continue;
    }
    const allowed = settings.allowedWaIds.has(candidate.waId);
    if (mode !== 'send') {
      item.status = allowed || settings.allowedWaIds.size === 0 ? 'would_schedule' : 'not_allowlisted';
      continue;
    }
    if (!allowed) {
      item.status = 'not_allowlisted';
      continue;
    }

    const reservation = await repository.reserve(candidate, { templateId, now });
    if (!reservation) {
      item.status = 'already_scheduled';
      continue;
    }
    try {
      const response = await messagesClient.sendTemplateMessage(
        buildReminderMessage({ sender, candidate, settings }),
      );
      await repository.markResult(reservation, {
        status: 'scheduled',
        detail: infobipMessageIdOf(response),
        now,
      });
      item.status = 'scheduled';
    } catch (error) {
      const errorCode = error?.status ? String(error.status) : error?.details?.code ?? error?.name ?? 'Error';
      logger.error?.('Reminder could not be scheduled.', { appointmentId: candidate.appointmentId, errorCode });
      try {
        await repository.markResult(reservation, { status: 'failed', detail: errorCode, errorCode, now });
      } catch (markError) {
        logger.error?.('Reminder failure could not be recorded.', { errorName: markError?.name ?? 'Error' });
      }
      item.status = 'failed';
    }
  }

  const counts = items.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }), {});
  return { mode, hoursBefore, windowMinutes: settings.windowMinutes, items, counts };
}
