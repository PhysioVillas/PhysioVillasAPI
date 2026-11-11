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
      stepKey: message.messageType,
      source: 'bot',
      occurredAt: message.createdAt ?? null,
    }];
  }

  return [];
}

export { flowEventForMessage };
