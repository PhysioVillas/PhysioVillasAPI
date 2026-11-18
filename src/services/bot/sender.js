// Envio das respostas do engine (T17) pela API dedicada de WhatsApp da
// Infobip, usando os mesmos métodos de `infobipMessagesClient` que o FAQ
// antigo usava:
//   text    → sendWhatsAppText            (/whatsapp/1/message/text)
//   list    → sendWhatsAppInteractiveList (/whatsapp/1/message/interactive/list)
//   buttons → sendWhatsAppInteractiveButtons (/whatsapp/1/message/interactive/buttons)
//
// As respostas vão em ordem. Na primeira falha o envio para (as seguintes
// dependeriam da anterior) e a falha é registrada sem PII: nada de telefone,
// texto ou detalhes da resposta do provedor.

const METHOD_BY_TYPE = Object.freeze({
  text: 'sendWhatsAppText',
  list: 'sendWhatsAppInteractiveList',
  buttons: 'sendWhatsAppInteractiveButtons',
});

function payloadFor(reply) {
  switch (reply.type) {
    case 'text':
      return { text: reply.text };
    case 'list':
      return {
        ...(reply.header === undefined ? {} : { header: reply.header }),
        body: reply.body,
        ...(reply.footer === undefined ? {} : { footer: reply.footer }),
        buttonTitle: reply.buttonTitle,
        sections: reply.sections,
      };
    case 'buttons':
      return {
        ...(reply.header === undefined ? {} : { header: reply.header }),
        body: reply.body,
        ...(reply.footer === undefined ? {} : { footer: reply.footer }),
        buttons: reply.buttons,
      };
    default:
      return null;
  }
}

/** Texto que representa a resposta na tabela `messages`. */
export function replyBody(reply) {
  return reply?.type === 'text' ? reply.text : reply?.body;
}

export function createBotSender({ client, sender, logger = console } = {}) {
  if (!client || typeof sender !== 'string' || sender.trim() === '') {
    throw new TypeError('createBotSender requires client and sender.');
  }

  /**
   * Envia as respostas em ordem. Devolve um item por resposta tentada:
   * `{ reply, ok: true, messageId, status }` ou `{ reply, ok: false }` (a
   * última). `messageId` é null quando o provedor não devolveu um.
   */
  async function send(waId, replies = []) {
    const results = [];
    for (const [index, reply] of replies.entries()) {
      const method = METHOD_BY_TYPE[reply?.type];
      const payload = method ? payloadFor(reply) : null;
      if (!method || typeof client[method] !== 'function' || payload === null) {
        logger.error?.('Bot reply has no sender method; stopping.', { replyType: reply?.type ?? null, index });
        results.push({ reply, ok: false });
        break;
      }
      try {
        const receipt = await client[method]({ sender, to: waId, ...payload });
        const messageId = typeof receipt?.messageId === 'string' && receipt.messageId.trim() !== ''
          ? receipt.messageId.trim()
          : null;
        results.push({ reply, ok: true, messageId, status: receipt?.status?.name ?? 'accepted' });
      } catch (error) {
        logger.error?.('Bot reply send failed; stopping.', {
          replyType: reply.type,
          index,
          errorName: error?.name ?? 'Error',
          upstreamStatus: error?.status ?? null,
        });
        results.push({ reply, ok: false });
        break;
      }
    }
    return results;
  }

  return { send };
}
