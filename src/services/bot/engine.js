// Motor do bot (máquina de estados da seção 6.1 de plan.md).
//
// O engine NÃO envia nada: `handle(inbound)` devolve as respostas já
// normalizadas aos limites do WhatsApp e quem chama (T17) envia na ordem.
// `sendReply` é aceito na fábrica só por compatibilidade com o contrato da
// seção 3.2 de plan-backlog.md e não é usado.
//
// ---------------------------------------------------------------------------
// Entrada (`inbound`), montada a partir da mensagem normalizada do webhook
// (veja `inboundFromNormalizedMessage`):
//   { waId, receivedAt, kind: 'text'|'list_reply'|'button_reply', text, replyId }
//   - text:    corpo do texto (ou o título da opção clicada, em respostas
//              interativas). O texto chega aqui original, só em memória.
//   - replyId: id da linha da lista ou do botão; null em texto.
//
// Contexto dos fluxos (`ctx`):
//   { waId, now, config, state, patient, inBusinessHours, repos }
//   - state: null ou { flow, step, context, cpfAttempts, misunderstoodCount,
//            expiresAt } do próprio fluxo. Num fluxo iniciado por transição
//            (veja abaixo), é o `next` que pediu a transição.
//   - patient: `state.context.patient` ({ id, firstName }) ou null. Os
//            fluxos gravam `context.patient` depois de verificar o CPF; o
//            engine carrega esse valor de um estado para o seguinte enquanto
//            a conversa tiver estado. Quando o estado expira ou é limpo
//            (`next: null`, handoff, MENU), o paciente some e o CPF é pedido
//            de novo. Para limpar explicitamente: `context.patient = null`.
//
// Entrada dos fluxos (`input`):
//   { kind, text, replyId, intent, reply }
//   - intent: `detectIntent(text)` em texto; em respostas interativas só os
//            ids legados (`btn_atendente`/`menu_atendente` → 'human',
//            `btn_voltar_menu` → 'menu'), senão null.
//   - reply:  { flow, step, value } quando o replyId segue
//            `<flow>:<step>|<valor>`, senão null.
//
// FlowResult (seção 3.3), com os refinamentos:
//   { replies, next, handoff, events, misunderstood }
//   - next: { flow, step, context, cpfAttempts? } | null.
//       * cpfAttempts (opcional) grava `conversation_state.cpf_attempts`;
//         se omitido, mantém o valor do estado anterior do mesmo fluxo
//         (0 ao trocar de fluxo).
//       * Transição: se `next.flow` é diferente do fluxo que respondeu, o
//         engine chama `flows[next.flow].start(ctx)` (sem `input`) com
//         `ctx.state = { flow, step, context }` do `next` e junta as
//         respostas dos dois, na ordem. Até 3 transições por mensagem.
//         Ex.: menu → booking, booking sem paciente → triage,
//         triage → booking em `choose_day`.
//   - handoff: { reason }. O engine abre o handoff, limpa o estado, ignora
//         `next` e acrescenta o texto padrão da equipe (com a próxima
//         abertura, se fora do horário). O fluxo não deve escrever esse
//         texto, só a explicação do motivo, se quiser.
//   - misunderstood: true soma 1 em `misunderstood_count` (só persiste se
//         houver `next`); qualquer resultado entendido zera a contagem. No
//         limite `maxMisunderstoodReplies`, as respostas do fluxo são
//         trocadas pelo handoff `bot_failure`.
//   - listas com mais de 10 linhas são paginadas pelo engine; as páginas
//         seguintes ficam em `context._pages` (chave reservada, invisível
//         aos fluxos) e o clique em "Ver mais" (`<flow>:<step>|more:<n>`) é
//         respondido pelo engine sem chamar o fluxo. Exige `next` não nulo.
//
// Saída de `handle`: { replies, events, handoff, flow, silenced }
//   - handoff: null ou { reason, inBusinessHours, nextOpeningAt: Date|null }.
//   - events: [{ stepKey }] dos fluxos, mais `handoff:<reason>` quando o
//            engine abre um handoff.
//   - flow:   último fluxo que respondeu (ou null), para o current_intent.
//   - silenced: true quando o bot ficou em silêncio por handoff aberto.
//   `handle` nunca lança: erro de fluxo, de repositório ou de validação das
//   respostas vira handoff `bot_failure` e uma mensagem genérica.
// ---------------------------------------------------------------------------

import { isWithinSupportHours, nextSupportOpening } from './businessHours.js';
import { detectIntent } from './intents.js';
import { normalizeRepliesWithPages } from './replies.js';

const INPUT_KINDS = new Set(['text', 'list_reply', 'button_reply']);

// Ids legados do FAQ antigo (src/config/faqContent.js).
const LEGACY_REPLY_INTENTS = Object.freeze({
  btn_atendente: 'human',
  menu_atendente: 'human',
  btn_voltar_menu: 'menu',
});

const HANDOFF_REASON_BY_INTENT = Object.freeze({
  human: 'patient_request',
  payment: 'payment',
  clinical: 'clinical_or_urgency',
  document: 'document_request',
});

const PREFIXED_ID = /^([a-z][a-z0-9_]*):([a-z0-9_]+)\|(.*)$/s;
const MORE_VALUE = /^more:(\d+)$/;
const MAX_TRANSITIONS = 3;
const PAGES_KEY = '_pages';
const DEFAULT_TIMEZONE = 'America/Bahia';

export const ENGINE_TEXTS = Object.freeze({
  urgency:
    'Se for uma emergência, ligue agora para o SAMU (192) ou procure o pronto-socorro '
    + 'mais próximo. Não espere a resposta por aqui.',
  handoffInHours: 'Certo! Chamei alguém da nossa equipe, que vai continuar o atendimento por aqui em breve.',
  handoffOutOfHours: (start, end, when) => `Certo! Avisei nossa equipe. O atendimento humano funciona das ${start} às ${end}, então a resposta chega ${when}.`,
  handoffNoSchedule: 'Certo! Avisei nossa equipe, que vai continuar o atendimento por aqui.',
  backToMenu: 'Se quiser voltar ao atendimento automático, envie MENU.',
  misunderstood: 'Desculpe, não consegui entender suas últimas mensagens.',
  failure: 'Desculpe, tive um problema para continuar por aqui.',
});

/**
 * Converte a mensagem de `normalizeInfobipInboundPayload(...).messages[i].message`
 * no `inbound` do engine. Devolve null para tipos que o bot não trata.
 */
export function inboundFromNormalizedMessage(message) {
  const kinds = {
    text: 'text',
    interactive_list_reply: 'list_reply',
    interactive_button_reply: 'button_reply',
  };
  const kind = kinds[message?.messageType];
  if (!kind || typeof message.waId !== 'string') {
    return null;
  }
  return {
    waId: message.waId,
    receivedAt: message.createdAt ?? null,
    kind,
    text: message.body ?? null,
    replyId: kind === 'text' ? null : message.replyId ?? null,
  };
}

/** Separa `<flow>:<step>|<valor>`; null se o id não segue a convenção. */
export function parseReplyId(replyId) {
  if (typeof replyId !== 'string') {
    return null;
  }
  const match = PREFIXED_ID.exec(replyId);
  return match ? { flow: match[1], step: match[2], value: match[3] } : null;
}

function localDayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** "hoje às 08:00", "amanhã às 08:00" ou "segunda-feira, 23/11, às 08:00". */
export function formatOpening(opening, now, timeZone = DEFAULT_TIMEZONE) {
  const time = new Intl.DateTimeFormat('pt-BR', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(opening);
  const days = Math.round(
    (Date.parse(localDayKey(opening, timeZone)) - Date.parse(localDayKey(now, timeZone))) / 86400000,
  );
  if (days <= 0) {
    return `hoje às ${time}`;
  }
  if (days === 1) {
    return `amanhã às ${time}`;
  }
  const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone, weekday: 'long' }).format(opening);
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit' }).format(opening);
  return `${weekday}, ${date}, às ${time}`;
}

function toTime(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function stripPages(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  const { [PAGES_KEY]: _pages, ...rest } = context;
  return rest;
}

function patientOf(context) {
  const patient = context?.patient;
  return patient && typeof patient === 'object' ? patient : null;
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('Flow returned no FlowResult.');
  }
  const next = result.next ?? null;
  if (next !== null && (typeof next.flow !== 'string' || typeof next.step !== 'string')) {
    throw new TypeError('FlowResult.next needs flow and step.');
  }
  return {
    replies: Array.isArray(result.replies) ? result.replies : [],
    next,
    handoff: result.handoff?.reason ? { reason: result.handoff.reason } : null,
    events: Array.isArray(result.events) ? result.events.filter((e) => typeof e?.stepKey === 'string') : [],
    misunderstood: result.misunderstood === true,
  };
}

export function createBotEngine({
  flows,
  stateStore,
  handoffs,
  config,
  clock = () => new Date(),
  // Aceito e ignorado: o engine não envia (o envio é do T17).
  sendReply: _sendReply = null,
  logger = console,
  repos = {},
} = {}) {
  if (!flows || typeof flows.menu?.start !== 'function') {
    throw new TypeError('createBotEngine requires flows with menu.start().');
  }
  if (!stateStore || !handoffs) {
    throw new TypeError('createBotEngine requires stateStore and handoffs.');
  }

  const now = () => {
    const value = typeof clock === 'function' ? clock() : clock.now();
    return value instanceof Date ? value : new Date(value);
  };

  async function resolveConfig() {
    return typeof config?.get === 'function' ? config.get() : config;
  }

  function supportInfo(at, cfg) {
    const hours = cfg?.humanSupportHours;
    const timezone = cfg?.timezone ?? DEFAULT_TIMEZONE;
    if (!hours) {
      return { inBusinessHours: true, nextOpeningAt: null };
    }
    const inBusinessHours = isWithinSupportHours(at, hours, timezone);
    return {
      inBusinessHours,
      nextOpeningAt: inBusinessHours ? null : nextSupportOpening(at, hours, timezone),
    };
  }

  function handoffText(at, cfg, info, intro) {
    let main;
    if (info.inBusinessHours) {
      main = ENGINE_TEXTS.handoffInHours;
    } else if (info.nextOpeningAt) {
      const { start, end } = cfg.humanSupportHours;
      main = ENGINE_TEXTS.handoffOutOfHours(
        start, end, formatOpening(info.nextOpeningAt, at, cfg.timezone ?? DEFAULT_TIMEZONE),
      );
    } else {
      main = ENGINE_TEXTS.handoffNoSchedule;
    }
    return [intro, main, ENGINE_TEXTS.backToMenu].filter(Boolean).join('\n\n');
  }

  // Abre o handoff e limpa o estado. Devolve a parte do resultado do engine.
  async function openHandoff(waId, reason, at, cfg, intro) {
    const info = supportInfo(at, cfg);
    await handoffs.open({ waId, reason, inBusinessHours: info.inBusinessHours });
    await stateStore.clear(waId);
    return {
      reply: { type: 'text', text: handoffText(at, cfg, info, intro) },
      event: { stepKey: `handoff:${reason}` },
      handoff: { reason, ...info },
    };
  }

  function result({ replies = [], events = [], handoff = null, flow = null, silenced = false } = {}) {
    return { replies, events, handoff, flow, silenced };
  }

  function inSilence(open, at, cfg) {
    const reference = Math.max(toTime(open.requestedAt) ?? 0, toTime(open.firstTeamReplyAt) ?? 0);
    const hours = Number(cfg?.handoffSilenceHours ?? 12);
    return reference > 0 && at.getTime() - reference < hours * 3600000;
  }

  function stateForFlow(state) {
    return state
      ? {
        flow: state.flow,
        step: state.step,
        context: stripPages(state.context),
        cpfAttempts: state.cpfAttempts ?? 0,
        misunderstoodCount: state.misunderstoodCount ?? 0,
        expiresAt: state.expiresAt ?? null,
      }
      : null;
  }

  function expiresAt(at, cfg) {
    const minutes = Number(cfg?.conversationStepTimeoutMinutes ?? 30);
    return new Date(at.getTime() + minutes * 60000);
  }

  // Roda um fluxo (e as transições que ele pedir) e aplica o resultado.
  async function runFlow({ waId, at, cfg, flowName, method, state, input, patient, trace }) {
    const info = supportInfo(at, cfg);
    const replies = [];
    const events = [];
    let currentFlow = flowName;
    let currentMethod = method;
    let currentState = stateForFlow(state);
    let currentPatient = patient;
    let outcome;
    let transitions = 0;

    for (;;) {
      const flow = flows[currentFlow];
      if (!flow || typeof flow[currentMethod] !== 'function') {
        throw new Error(`Unknown flow or method: ${currentFlow}.${currentMethod}`);
      }
      trace.flow = currentFlow;
      trace.step = currentState?.step ?? null;
      const ctx = {
        waId,
        now: at,
        config: cfg,
        state: currentState,
        patient: currentPatient,
        inBusinessHours: info.inBusinessHours,
        repos,
      };
      const flowInput = currentMethod === 'start' && transitions > 0 ? undefined : input;
      outcome = normalizeResult(await flow[currentMethod](ctx, flowInput));
      replies.push(...outcome.replies);
      events.push(...outcome.events);

      const { next } = outcome;
      if (next && Object.hasOwn(next.context ?? {}, 'patient')) {
        currentPatient = patientOf(next.context);
      }
      if (outcome.handoff || !next || next.flow === currentFlow) {
        break;
      }
      if (transitions >= MAX_TRANSITIONS) {
        throw new Error('Too many flow transitions.');
      }
      transitions += 1;
      currentFlow = next.flow;
      currentMethod = 'start';
      currentState = {
        flow: next.flow,
        step: next.step,
        context: { ...stripPages(next.context), patient: currentPatient },
        cpfAttempts: 0,
        misunderstoodCount: 0,
        expiresAt: null,
      };
    }

    // Handoff pedido pelo fluxo.
    if (outcome.handoff) {
      const opened = await openHandoff(waId, outcome.handoff.reason, at, cfg);
      return result({
        replies: [...normalizeRepliesWithPages(replies).replies, opened.reply],
        events: [...events, opened.event],
        handoff: opened.handoff,
        flow: currentFlow,
      });
    }

    // Contagem de respostas não entendidas.
    const previousCount = state?.misunderstoodCount ?? 0;
    const misunderstoodCount = outcome.misunderstood ? previousCount + 1 : 0;
    const limit = Number(cfg?.maxMisunderstoodReplies ?? 3);
    if (outcome.misunderstood && misunderstoodCount >= limit) {
      const opened = await openHandoff(waId, 'bot_failure', at, cfg, ENGINE_TEXTS.misunderstood);
      return result({
        replies: [opened.reply],
        events: [...events, opened.event],
        handoff: opened.handoff,
        flow: currentFlow,
      });
    }

    const { next } = outcome;
    const morePrefix = `${next?.flow ?? currentFlow}:${next?.step ?? 'list'}`;
    const normalized = normalizeRepliesWithPages(replies, { morePrefix: next ? morePrefix : undefined });

    if (next) {
      const context = { ...stripPages(next.context) };
      if (currentPatient) {
        context.patient = currentPatient;
      } else {
        delete context.patient;
      }
      if (normalized.pages) {
        context[PAGES_KEY] = { key: morePrefix, pages: normalized.pages };
      }
      const sameFlow = state && state.flow === next.flow;
      await stateStore.save({
        waId,
        flow: next.flow,
        step: next.step,
        context,
        cpfAttempts: Number.isInteger(next.cpfAttempts)
          ? next.cpfAttempts
          : (sameFlow ? state.cpfAttempts ?? 0 : 0),
        misunderstoodCount,
        expiresAt: expiresAt(at, cfg),
      });
    } else {
      await stateStore.clear(waId);
    }

    return result({ replies: normalized.replies, events, flow: currentFlow });
  }

  async function process(inbound, trace) {
    const at = now();
    trace.at = at;
    const cfg = await resolveConfig();
    trace.cfg = cfg;
    const { waId } = inbound;

    const intent = inbound.kind === 'text'
      ? detectIntent(inbound.text)
      : LEGACY_REPLY_INTENTS[inbound.replyId] ?? null;
    const reply = inbound.kind === 'text' ? null : parseReplyId(inbound.replyId);
    const input = {
      kind: inbound.kind,
      text: inbound.text ?? null,
      replyId: inbound.replyId ?? null,
      intent,
      reply,
    };

    // 1. Handoff aberto: silêncio dentro da janela, exceto MENU.
    const open = await handoffs.getOpen(waId);
    if (open) {
      if (inSilence(open, at, cfg) && intent !== 'menu') {
        return result({ silenced: true });
      }
      // MENU dentro da janela, ou handoff antigo (fora da janela): fecha.
      await handoffs.closeOpen(waId, at);
    }

    // 2. Urgência: SAMU primeiro, depois a equipe.
    if (intent === 'urgency') {
      trace.flow = null;
      const opened = await openHandoff(waId, 'clinical_or_urgency', at, cfg);
      return result({
        replies: [{ type: 'text', text: ENGINE_TEXTS.urgency }, opened.reply],
        events: [opened.event],
        handoff: opened.handoff,
      });
    }

    // 3. Pedido de humano, pagamento, pergunta clínica ou documento.
    if (HANDOFF_REASON_BY_INTENT[intent]) {
      const opened = await openHandoff(waId, HANDOFF_REASON_BY_INTENT[intent], at, cfg);
      return result({ replies: [opened.reply], events: [opened.event], handoff: opened.handoff });
    }

    let state = await stateStore.getActive(waId, at);
    const stateExpiry = toTime(state?.expiresAt);
    if (state && stateExpiry !== null && stateExpiry <= at.getTime()) {
      state = null;
    }
    const patient = patientOf(state?.context);

    // MENU (texto ou botão "Voltar ao menu") sempre reinicia no menu.
    if (intent === 'menu') {
      await stateStore.clear(waId);
      return runFlow({ waId, at, cfg, flowName: 'menu', method: 'start', state: null, input, patient, trace });
    }

    // 4. Id com prefixo `<flow>:`: vai para o fluxo dono, com ou sem estado.
    if (reply && flows[reply.flow]) {
      const pages = state?.context?.[PAGES_KEY];
      const more = MORE_VALUE.exec(reply.value);
      if (more && pages?.key === `${reply.flow}:${reply.step}` && pages.pages?.[Number(more[1]) - 1]) {
        await stateStore.save({ ...state, waId, expiresAt: expiresAt(at, cfg) });
        return result({ replies: [pages.pages[Number(more[1]) - 1]], flow: reply.flow });
      }
      const ownState = state?.flow === reply.flow ? state : null;
      return runFlow({
        waId, at, cfg, flowName: reply.flow, method: 'handle', state: ownState, input, patient, trace,
      });
    }

    // 5. Etapa em andamento.
    if (state && typeof flows[state.flow]?.handle === 'function') {
      return runFlow({ waId, at, cfg, flowName: state.flow, method: 'handle', state, input, patient, trace });
    }

    // 6. Sem estado: menu.
    return runFlow({ waId, at, cfg, flowName: 'menu', method: 'start', state: null, input, patient, trace });
  }

  async function fail(inbound, trace, error) {
    // Sem PII: nada de waId, texto ou mensagem do erro.
    logger.error?.('Bot engine failed; opening bot_failure handoff.', {
      flow: trace.flow ?? null,
      step: trace.step ?? null,
      errorName: error?.name ?? 'Error',
    });
    const at = trace.at ?? new Date();
    const cfg = trace.cfg ?? null;
    let info = { inBusinessHours: true, nextOpeningAt: null };
    try {
      info = supportInfo(at, cfg);
    } catch {
      // Config inválida: segue com o texto sem horário.
      info = { inBusinessHours: true, nextOpeningAt: null };
    }
    try {
      await handoffs.open({ waId: inbound.waId, reason: 'bot_failure', inBusinessHours: info.inBusinessHours });
    } catch (openError) {
      logger.error?.('Bot engine could not open bot_failure handoff.', { errorName: openError?.name ?? 'Error' });
    }
    try {
      await stateStore.clear(inbound.waId);
    } catch (clearError) {
      logger.error?.('Bot engine could not clear conversation state.', { errorName: clearError?.name ?? 'Error' });
    }
    return result({
      replies: [{ type: 'text', text: handoffText(at, cfg, info, ENGINE_TEXTS.failure) }],
      events: [{ stepKey: 'handoff:bot_failure' }],
      handoff: { reason: 'bot_failure', ...info },
      flow: trace.flow ?? null,
    });
  }

  async function handle(inbound) {
    if (!inbound || typeof inbound.waId !== 'string' || inbound.waId === '' || !INPUT_KINDS.has(inbound.kind)) {
      return result();
    }
    const trace = {};
    try {
      return await process(inbound, trace);
    } catch (error) {
      return fail(inbound, trace, error);
    }
  }

  return { handle };
}
