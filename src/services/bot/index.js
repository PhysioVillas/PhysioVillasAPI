// Montagem do bot (T17): config, estado, handoffs, repositórios da clínica,
// fluxos e engine, mais o envio e a gravação das respostas.
//
// O webhook chama:
//   - `maskNormalizedMessage(normalized)` ANTES de gravar a mensagem: o CPF
//     nunca é persistido (só a máscara ***.***.***-NN);
//   - `bot.handleInbound(message)` com a mensagem ORIGINAL (só em memória),
//     e só quando a mensagem do paciente acabou de ser gravada (idempotência);
//   - `bot.handleTeamReply(message)` para mensagens do app WhatsApp Business.
//
// Respostas gravadas em `messages` com os `message_type` que o BI já conhece:
//   lista → faq_menu; texto e botões → faq_answer; texto de handoff → faq_handoff.
// `conversations.current_intent`: booking/my_appointments → scheduling,
// triage → triage, faq/menu → faq, handoff → human_handoff.

import { createBotConfig } from '../../config/botConfig.js';
import { createAppointmentRepository } from '../clinic/appointmentRepository.js';
import { createCatalogRepository } from '../clinic/catalogRepository.js';
import { createPatientRepository } from '../clinic/patientRepository.js';
import { createDatabase } from '../database.js';
import { findCpfInText, maskCpf } from './cpf.js';
import { createBotEngine, inboundFromNormalizedMessage } from './engine.js';
import { bookingFlow } from './flows/booking.js';
import { faqFlow } from './flows/faq.js';
import { menuFlow } from './flows/menu.js';
import { myAppointmentsFlow } from './flows/myAppointments.js';
import { triageFlow } from './flows/triage.js';
import { createHandoffRepository } from './handoffRepository.js';
import { createBotSender, replyBody } from './sender.js';
import { createStateStore } from './stateStore.js';

const INTENT_BY_FLOW = Object.freeze({
  booking: 'scheduling',
  my_appointments: 'scheduling',
  triage: 'triage',
  faq: 'faq',
  menu: 'faq',
});

/** Troca todo CPF do texto (formatado ou 11 dígitos) pela máscara. */
export function maskCpfInText(text) {
  if (typeof text !== 'string') {
    return text;
  }
  let masked = '';
  let rest = text;
  for (let found = findCpfInText(rest); found; found = findCpfInText(rest)) {
    masked += rest.slice(0, found.start) + maskCpf(found.digits);
    rest = rest.slice(found.end);
  }
  return masked + rest;
}

/** Aplica `maskCpfInText` a todas as strings de um valor JSON (cópia). */
export function maskCpfDeep(value) {
  if (typeof value === 'string') {
    return maskCpfInText(value);
  }
  if (Array.isArray(value)) {
    return value.map(maskCpfDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskCpfDeep(item)]));
  }
  return value;
}

/**
 * Cópia da mensagem normalizada pronta para gravar: os campos de texto livre
 * (corpo e nome do perfil) saem com o CPF mascarado. Ids, telefone e datas
 * ficam como estão.
 */
export function maskNormalizedMessage(normalized) {
  return {
    ...normalized,
    contact: normalized.contact === undefined
      ? undefined
      : { ...normalized.contact, profileName: maskCpfInText(normalized.contact.profileName ?? null) },
    message: { ...normalized.message, body: maskCpfInText(normalized.message.body ?? null) },
  };
}

export function intentForFlow(flow) {
  return INTENT_BY_FLOW[flow] ?? null;
}

export function messageTypeForReply(reply, isHandoffText) {
  if (isHandoffText) {
    return 'faq_handoff';
  }
  return reply.type === 'list' ? 'faq_menu' : 'faq_answer';
}

/**
 * Distribui os eventos do engine pelas respostas enviadas (cada mensagem
 * grava no máximo um `bot_step_sent`). O handoff fica com o texto de handoff;
 * os demais eventos casam com as respostas a partir do fim (a última etapa
 * mostrada é a que vale). Resposta sem evento fica com null (o
 * `whatsappFlowEvents` usa o `message_type`).
 */
export function stepKeysForReplies(result) {
  const replies = result.replies ?? [];
  const events = (result.events ?? []).map((event) => event.stepKey);
  const keys = replies.map(() => null);
  const hasHandoffText = Boolean(result.handoff) && replies.length > 0;
  let flowEvents = events;
  if (hasHandoffText) {
    const handoffKey = events.findLast((key) => key.startsWith('handoff:')) ?? `handoff:${result.handoff.reason}`;
    keys[replies.length - 1] = handoffKey;
    flowEvents = events.filter((key) => !key.startsWith('handoff:'));
  }
  const slots = hasHandoffText ? replies.length - 1 : replies.length;
  for (let i = 0; i < slots; i += 1) {
    const eventIndex = flowEvents.length - (slots - i);
    if (eventIndex >= 0) {
      keys[i] = flowEvents[eventIndex];
    }
  }
  return keys;
}

export function createBot({
  pool,
  messagesClient,
  whatsappSender,
  database,
  clock = () => new Date(),
  logger = console,
  config,
  repos,
  flows,
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createBot requires a pool with query().');
  }
  const now = () => {
    const value = clock();
    return value instanceof Date ? value : new Date(value);
  };
  const store = database ?? createDatabase({ pool });
  const botConfig = config ?? createBotConfig({ pool, logger });
  const stateStore = createStateStore({ pool });
  const handoffs = createHandoffRepository({ pool });
  const clinicRepos = repos ?? {
    catalog: createCatalogRepository({ pool }),
    appointments: createAppointmentRepository({ pool, clock: now }),
    patients: createPatientRepository({ pool, clock: now, logger }),
  };
  const engine = createBotEngine({
    flows: flows ?? {
      menu: menuFlow,
      faq: faqFlow,
      booking: bookingFlow,
      my_appointments: myAppointmentsFlow,
      triage: triageFlow,
    },
    stateStore,
    handoffs,
    config: botConfig,
    clock: now,
    logger,
    repos: clinicRepos,
  });
  const sender = createBotSender({ client: messagesClient, sender: whatsappSender, logger });

  async function persistReply({ waId, sent, messageType, conversationIntent, botStepKey }) {
    if (sent.messageId === null) {
      logger.warn?.('Bot reply accepted without a messageId; it was not persisted.', { messageType });
      return false;
    }
    try {
      await store.persistOutboundMessage({
        infobipMessageId: sent.messageId,
        waId,
        // Defesa extra: as respostas não deveriam conter CPF.
        body: maskCpfInText(replyBody(sent.reply)),
        messageType,
        status: sent.status,
        conversationIntent,
        botStepKey,
      });
      return true;
    } catch (error) {
      logger.error?.('Bot reply was sent but not persisted.', { messageType, errorName: error?.name ?? 'Error' });
      return false;
    }
  }

  /**
   * Responde uma mensagem do paciente. `message` é a mensagem normalizada
   * original (com o texto completo, só em memória). Nunca lança.
   */
  async function handleInbound(message) {
    const inbound = inboundFromNormalizedMessage(message);
    if (inbound === null) {
      return { action: 'skipped', reason: 'unsupported_type', replies: [] };
    }
    const result = await engine.handle(inbound);
    if (result.silenced || result.replies.length === 0) {
      return { action: 'skipped', reason: result.silenced ? 'human_handoff' : 'no_reply', replies: [] };
    }

    const sentResults = await sender.send(inbound.waId, result.replies);
    const stepKeys = stepKeysForReplies(result);
    const lastIndex = result.replies.length - 1;
    const flowIntent = intentForFlow(result.flow);
    const replies = [];
    for (const [index, sent] of sentResults.entries()) {
      if (!sent.ok) {
        replies.push({ ok: false });
        break;
      }
      const isHandoffText = Boolean(result.handoff) && index === lastIndex;
      const messageType = messageTypeForReply(sent.reply, isHandoffText);
      const persisted = await persistReply({
        waId: inbound.waId,
        sent,
        messageType,
        conversationIntent: isHandoffText ? 'human_handoff' : flowIntent,
        botStepKey: stepKeys[index],
      });
      replies.push({ ok: true, messageId: sent.messageId, messageType, persisted });
    }
    return {
      action: 'replied',
      flow: result.flow,
      handoff: result.handoff?.reason ?? null,
      replies,
    };
  }

  /** Mensagem da equipe pelo app WhatsApp Business: marca a 1ª resposta. */
  async function handleTeamReply(message) {
    if (typeof message?.waId !== 'string' || message.waId === '') {
      return null;
    }
    const at = message.createdAt ? new Date(message.createdAt) : now();
    return handoffs.markFirstTeamReply(message.waId, Number.isNaN(at.getTime()) ? now() : at);
  }

  return { handleInbound, handleTeamReply };
}
