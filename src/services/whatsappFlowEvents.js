import {
  BUTTON_BACK_TO_MENU,
  BUTTON_TALK_TO_TEAM,
  faqAnswers,
  handoffReplies,
  mainMenu,
} from '../config/faqContent.js';

const selectableFlowSteps = new Set([
  ...mainMenu.sections.flatMap((section) => section.rows.map((row) => row.id)),
  ...Object.keys(faqAnswers),
  ...Object.keys(handoffReplies),
  BUTTON_BACK_TO_MENU,
  BUTTON_TALK_TO_TEAM,
]);

// Etapas do bot novo (engine, T17): `<flow>:<step>` e `handoff:<reason>`.
// REQUER a migration 014 (T18), que amplia `whatsapp_flow_events_check` para
// aceitar `bot_step_sent` com step_key neste formato; sem ela o insert falha
// e derruba a gravação da resposta.
const BOT_STEP_KEY = /^[a-z_]+:[a-z0-9_|:-]+$/;

// Devolve o step_key aceito pelo banco, ou null. Se só a parte de valor
// (depois do primeiro `|`) tiver caracteres fora do formato, ela é removida.
function toBotStepKey(stepKey) {
  if (typeof stepKey !== 'string') {
    return null;
  }
  if (BOT_STEP_KEY.test(stepKey)) {
    return stepKey;
  }
  const [head] = stepKey.split('|');
  return BOT_STEP_KEY.test(head) ? head : null;
}

function flowEventForMessage(message) {
  if (message.direction === 'in') {
    const events = [{
      eventType: 'message_received',
      stepKey: null,
      source: 'patient',
      occurredAt: message.createdAt ?? null,
    }];

    if (
      (message.messageType === 'interactive_list_reply'
        || message.messageType === 'interactive_button_reply')
      && selectableFlowSteps.has(message.replyId)
    ) {
      events.push({
        eventType: 'flow_option_selected',
        stepKey: message.replyId,
        source: 'patient',
        occurredAt: message.createdAt ?? null,
      });
    }

    return events;
  }

  if (message.direction === 'out' && message.sentVia === 'business_app') {
    return [{
      eventType: 'team_message_sent',
      stepKey: null,
      source: 'team',
      occurredAt: message.createdAt ?? null,
    }];
  }

  if (
    message.direction === 'out'
    && message.sentVia === 'api'
    && ['faq_menu', 'faq_answer', 'faq_handoff'].includes(message.messageType)
  ) {
    return [{
      eventType: 'bot_step_sent',
      stepKey: toBotStepKey(message.botStepKey) ?? message.messageType,
      source: 'bot',
      occurredAt: message.createdAt ?? null,
    }];
  }

  return [];
}

export { flowEventForMessage, toBotStepKey };
