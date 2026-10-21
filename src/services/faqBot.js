import * as defaultContent from '../config/faqContent.js';

// How long the bot stays silent on text after a handoff or a team reply
// from the WhatsApp Business App.
const HANDOFF_SILENCE_HOURS = 12;

// FAQ/self-service bot answering inbound WhatsApp messages with an
// interactive list (main menu), interactive buttons (FAQ answers) or a text
// (handoff to the clinic team). Every reply is persisted as an outbound API
// message with message_type faq_menu, faq_answer or faq_handoff.
function createFaqBot({
  client,
  database,
  sender,
  handoffHours = HANDOFF_SILENCE_HOURS,
  content = defaultContent,
  logger = console,
}) {
  const menuKeywords = new Set(content.MENU_KEYWORDS);

  async function send(method, payload, { waId, body, messageType, conversationIntent }) {
    const receipt = await client[method]({ sender, to: waId, ...payload });
    const messageId = typeof receipt?.messageId === 'string' ? receipt.messageId.trim() : '';

    if (messageId === '') {
      logger.warn('FAQ bot reply accepted without a messageId; it was not persisted.', { messageType });
      return { action: 'sent', messageType, persisted: false };
    }

    try {
      await database.persistOutboundMessage({
        infobipMessageId: messageId,
        waId,
        body,
        messageType,
        status: receipt?.status?.name ?? 'accepted',
        conversationIntent,
      });
      return { action: 'sent', messageType, persisted: true };
    } catch (error) {
      logger.error('FAQ bot reply was sent but not persisted.', { messageType, name: error?.name });
      return { action: 'sent', messageType, persisted: false };
    }
  }

  function sendMenu(waId) {
    const { header, body, footer, buttonTitle, sections } = content.mainMenu;

    return send('sendWhatsAppInteractiveList', { header, body, footer, buttonTitle, sections }, {
      waId,
      body,
      messageType: 'faq_menu',
      conversationIntent: 'faq',
    });
  }

  function sendAnswer(waId, answer) {
    return send('sendWhatsAppInteractiveButtons', {
      body: answer,
      footer: content.answerFooter,
      buttons: content.answerButtons,
    }, {
      waId,
      body: answer,
      messageType: 'faq_answer',
      conversationIntent: 'faq',
    });
  }

  function sendHandoff(waId, text) {
    return send('sendWhatsAppText', { text }, {
      waId,
      body: text,
      messageType: 'faq_handoff',
      conversationIntent: 'human_handoff',
    });
  }

  async function handleText(waId, body) {
    if (typeof body === 'string' && menuKeywords.has(body.trim().toLowerCase())) {
      return sendMenu(waId);
    }

    // Stay silent while the team is attending this contact: after a handoff
    // option or after a reply sent from the WhatsApp Business App.
    const context = await database.getFaqBotContext(waId, { windowHours: handoffHours });

    if (context.lastBotMessageType === 'faq_handoff' || context.teamRepliedRecently) {
      return { action: 'skipped', reason: 'human_handoff' };
    }

    return sendMenu(waId);
  }

  async function handleInbound({ waId, messageType, replyId = null, body = null }) {
    switch (messageType) {
      case 'text':
        return handleText(waId, body);

      case 'interactive_list_reply':
        if (Object.hasOwn(content.faqAnswers, replyId)) {
          return sendAnswer(waId, content.faqAnswers[replyId]);
        }

        if (Object.hasOwn(content.handoffReplies, replyId)) {
          return sendHandoff(waId, content.handoffReplies[replyId]);
        }

        return sendMenu(waId);

      case 'interactive_button_reply':
        if (replyId === content.BUTTON_TALK_TO_TEAM) {
          return sendHandoff(waId, content.handoffReplies.menu_atendente);
        }

        // btn_voltar_menu and any unknown button bring the menu back.
        return sendMenu(waId);

      default:
        return { action: 'skipped', reason: 'unsupported_type' };
    }
  }

  return { handleInbound };
}

export { createFaqBot };
