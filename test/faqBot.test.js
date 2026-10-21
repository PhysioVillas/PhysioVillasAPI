import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import * as faqContent from '../src/config/faqContent.js';
import { createFaqBot } from '../src/services/faqBot.js';
import {
  buildInteractiveButtonsMessage,
  buildInteractiveListMessage,
  createInfobipMessagesClient,
} from '../src/services/infobipMessagesClient.js';
import { normalizeInfobipWebhookPayload } from '../src/services/infobipWebhookNormalizer.js';

const PATIENT = '5571999990000';
const silentLogger = { warn() {}, error() {} };

function fakeClient() {
  const calls = [];
  let counter = 0;
  const receipt = () => {
    counter += 1;
    return { to: PATIENT, messageCount: 1, messageId: `bot-${counter}`, status: { name: 'PENDING_ENROUTE' } };
  };

  return {
    calls,
    sendWhatsAppInteractiveList: async (message) => {
      calls.push(['list', message]);
      return receipt();
    },
    sendWhatsAppInteractiveButtons: async (message) => {
      calls.push(['buttons', message]);
      return receipt();
    },
    sendWhatsAppText: async (message) => {
      calls.push(['text', message]);
      return receipt();
    },
  };
}

function fakeDatabase(context = {}) {
  const persisted = [];

  return {
    persisted,
    getFaqBotContext: async () => ({ lastBotMessageType: null, teamRepliedRecently: false, ...context }),
    persistOutboundMessage: async (message) => {
      persisted.push(message);
      return { message: { id: 'stored' } };
    },
  };
}

function botWith({ context } = {}) {
  const client = fakeClient();
  const database = fakeDatabase(context);
  const bot = createFaqBot({
    client,
    database,
    sender: 'clinic-sender',
    logger: silentLogger,
  });

  return { bot, client, database };
}

test('the FAQ content respects every WhatsApp interactive limit', () => {
  assert.doesNotThrow(() => buildInteractiveListMessage({
    sender: 'clinic-sender',
    to: PATIENT,
    ...faqContent.mainMenu,
  }));

  for (const answer of Object.values(faqContent.faqAnswers)) {
    assert.doesNotThrow(() => buildInteractiveButtonsMessage({
      sender: 'clinic-sender',
      to: PATIENT,
      body: answer,
      footer: faqContent.answerFooter,
      buttons: faqContent.answerButtons,
    }));
  }

  const rowIds = faqContent.mainMenu.sections.flatMap((section) => section.rows.map((row) => row.id));
  const routed = [...Object.keys(faqContent.faqAnswers), ...Object.keys(faqContent.handoffReplies)];

  assert.deepEqual([...rowIds].sort(), [...routed].sort(), 'every menu row has exactly one reply');
});

test('interactive builders reject payloads WhatsApp would refuse', () => {
  const list = {
    sender: 's',
    to: 't',
    body: 'Menu',
    buttonTitle: 'Ver opções',
    sections: [{ rows: [{ id: 'a', title: 'Opção' }] }],
  };
  const buttons = { sender: 's', to: 't', body: 'Resposta', buttons: [{ id: 'a', title: 'Voltar' }] };

  assert.throws(() => buildInteractiveListMessage({
    ...list,
    sections: [{ rows: [{ id: 'a', title: 'x'.repeat(25) }] }],
  }), /row title must have at most 24/);
  assert.throws(() => buildInteractiveListMessage({ ...list, buttonTitle: 'x'.repeat(21) }), /at most 20/);
  assert.throws(() => buildInteractiveListMessage({
    ...list,
    sections: [{ rows: [{ id: 'a', title: 'A', description: 'x'.repeat(73) }] }],
  }), /at most 72/);
  assert.throws(() => buildInteractiveListMessage({
    ...list,
    sections: [{ rows: Array.from({ length: 11 }, (_, index) => ({ id: `r${index}`, title: 'Linha' })) }],
  }), /between 1 and 10 rows/);
  assert.throws(() => buildInteractiveListMessage({
    ...list,
    sections: [{ rows: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }],
  }), /row ids must be unique/);
  assert.throws(() => buildInteractiveListMessage({
    ...list,
    sections: [{ rows: [{ id: 'a', title: 'A' }] }, { rows: [{ id: 'b', title: 'B' }] }],
  }), /section title is required/);
  assert.throws(() => buildInteractiveButtonsMessage({
    ...buttons,
    buttons: [1, 2, 3, 4].map((n) => ({ id: `b${n}`, title: `Botão ${n}` })),
  }), /between 1 and 3/);
  assert.throws(() => buildInteractiveButtonsMessage({
    ...buttons,
    buttons: [{ id: 'a', title: 'x'.repeat(21) }],
  }), /at most 20/);
  assert.throws(() => buildInteractiveButtonsMessage({
    ...buttons,
    buttons: [{ id: 'a', title: 'Voltar 👍' }],
  }), /emojis or markdown/);
  assert.throws(() => buildInteractiveButtonsMessage({ ...buttons, body: 'x'.repeat(1025) }), /at most 1024/);
});

test('the client sends interactive messages to the dedicated WhatsApp endpoints', async () => {
  const calls = [];
  const client = createInfobipMessagesClient({
    baseUrl: 'https://example.api.infobip.com/',
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ messageId: 'id-1' }) };
    },
  });

  await client.sendWhatsAppInteractiveList({
    sender: 'clinic-sender',
    to: PATIENT,
    header: 'Cabeçalho',
    body: 'Escolha',
    footer: 'Rodapé',
    buttonTitle: 'Ver opções',
    sections: [{ title: 'Seção', rows: [{ id: 'r1', title: 'Linha', description: 'Descrição' }] }],
  });
  await client.sendWhatsAppInteractiveButtons({
    sender: 'clinic-sender',
    to: PATIENT,
    body: 'Resposta',
    buttons: [{ id: 'btn_voltar_menu', title: 'Voltar ao menu' }],
  });
  await client.sendWhatsAppText({ sender: 'clinic-sender', to: PATIENT, text: 'Olá' });

  assert.deepEqual(calls.map(({ url }) => url), [
    'https://example.api.infobip.com/whatsapp/1/message/interactive/list',
    'https://example.api.infobip.com/whatsapp/1/message/interactive/buttons',
    'https://example.api.infobip.com/whatsapp/1/message/text',
  ]);
  assert.equal(calls[0].options.headers.Authorization, 'App test-key');
  assert.deepEqual(calls[0].body, {
    from: 'clinic-sender',
    to: PATIENT,
    content: {
      body: { text: 'Escolha' },
      header: { type: 'TEXT', text: 'Cabeçalho' },
      footer: { text: 'Rodapé' },
      action: {
        title: 'Ver opções',
        sections: [{ title: 'Seção', rows: [{ id: 'r1', title: 'Linha', description: 'Descrição' }] }],
      },
    },
  });
  assert.deepEqual(calls[1].body, {
    from: 'clinic-sender',
    to: PATIENT,
    content: {
      body: { text: 'Resposta' },
      action: { buttons: [{ type: 'REPLY', id: 'btn_voltar_menu', title: 'Voltar ao menu' }] },
    },
  });
  assert.deepEqual(calls[2].body, { from: 'clinic-sender', to: PATIENT, content: { text: 'Olá' } });
});

test('a plain text message gets the main menu and the reply is persisted', async () => {
  const { bot, client, database } = botWith();

  const result = await bot.handleInbound({ waId: PATIENT, messageType: 'text', body: 'Oi' });

  assert.deepEqual(result, { action: 'sent', messageType: 'faq_menu', persisted: true });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0][0], 'list');
  assert.equal(client.calls[0][1].sender, 'clinic-sender');
  assert.equal(client.calls[0][1].to, PATIENT);
  assert.deepEqual(client.calls[0][1].sections, faqContent.mainMenu.sections);
  assert.deepEqual(database.persisted, [{
    infobipMessageId: 'bot-1',
    waId: PATIENT,
    body: faqContent.mainMenu.body,
    messageType: 'faq_menu',
    status: 'PENDING_ENROUTE',
    conversationIntent: 'faq',
  }]);
});

test('a FAQ list option is answered with the back-to-menu and team buttons', async () => {
  const { bot, client, database } = botWith();

  await bot.handleInbound({ waId: PATIENT, messageType: 'interactive_list_reply', replyId: 'faq_horarios' });

  assert.equal(client.calls[0][0], 'buttons');
  assert.equal(client.calls[0][1].body, faqContent.faqAnswers.faq_horarios);
  assert.deepEqual(client.calls[0][1].buttons.map(({ id }) => id), ['btn_voltar_menu', 'btn_atendente']);
  assert.equal(database.persisted[0].messageType, 'faq_answer');
});

test('handoff options send a text and mark the conversation for the team', async () => {
  const { bot, client, database } = botWith();

  await bot.handleInbound({ waId: PATIENT, messageType: 'interactive_list_reply', replyId: 'menu_agendar' });
  await bot.handleInbound({ waId: PATIENT, messageType: 'interactive_button_reply', replyId: 'btn_atendente' });

  assert.deepEqual(client.calls.map(([kind, message]) => [kind, message.text]), [
    ['text', faqContent.handoffReplies.menu_agendar],
    ['text', faqContent.handoffReplies.menu_atendente],
  ]);
  assert.deepEqual(database.persisted.map(({ messageType, conversationIntent }) => [messageType, conversationIntent]), [
    ['faq_handoff', 'human_handoff'],
    ['faq_handoff', 'human_handoff'],
  ]);
});

test('the back-to-menu button and unknown options resend the menu', async () => {
  const { bot, client } = botWith();

  await bot.handleInbound({ waId: PATIENT, messageType: 'interactive_button_reply', replyId: 'btn_voltar_menu' });
  await bot.handleInbound({ waId: PATIENT, messageType: 'interactive_list_reply', replyId: 'removed_option' });

  assert.deepEqual(client.calls.map(([kind]) => kind), ['list', 'list']);
});

test('the bot stays silent on text while the team attends, except for the MENU keyword', async () => {
  const afterHandoff = botWith({ context: { lastBotMessageType: 'faq_handoff' } });
  const afterTeamReply = botWith({ context: { teamRepliedRecently: true } });

  assert.deepEqual(
    await afterHandoff.bot.handleInbound({ waId: PATIENT, messageType: 'text', body: 'Pode ser amanhã?' }),
    { action: 'skipped', reason: 'human_handoff' },
  );
  assert.deepEqual(
    await afterTeamReply.bot.handleInbound({ waId: PATIENT, messageType: 'text', body: 'Obrigado' }),
    { action: 'skipped', reason: 'human_handoff' },
  );
  assert.equal(afterHandoff.client.calls.length + afterTeamReply.client.calls.length, 0);

  await afterHandoff.bot.handleInbound({ waId: PATIENT, messageType: 'text', body: ' Menu ' });
  assert.deepEqual(afterHandoff.client.calls.map(([kind]) => kind), ['list']);
});

test('unsupported inbound types are ignored by the bot', async () => {
  const { bot, client } = botWith();

  assert.deepEqual(
    await bot.handleInbound({ waId: PATIENT, messageType: 'image' }),
    { action: 'skipped', reason: 'unsupported_type' },
  );
  assert.equal(client.calls.length, 0);
});

test('interactive replies are normalized with the clicked id and title', () => {
  const normalized = normalizeInfobipWebhookPayload({
    results: [{
      from: PATIENT,
      to: 'clinic-sender',
      messageId: 'in-2',
      receivedAt: '2026-10-21T12:00:00.000+0000',
      message: { type: 'INTERACTIVE_LIST_REPLY', id: 'faq_horarios', title: 'Horários' },
    }],
  });

  assert.equal(normalized.inboundMessages[0].message.messageType, 'interactive_list_reply');
  assert.equal(normalized.inboundMessages[0].message.replyId, 'faq_horarios');
  assert.equal(normalized.inboundMessages[0].message.body, 'Horários');
});

async function postInbound(app, payload) {
  const server = app.listen(0);

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/infobip/inbound`, {
      method: 'POST',
      headers: { authorization: 'Bearer receiver-token', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function textPayload(messageId) {
  return {
    results: [{
      from: PATIENT,
      messageId,
      receivedAt: '2026-10-21T12:00:00.000+0000',
      message: { type: 'TEXT', text: 'Oi' },
    }],
  };
}

test('the webhook triggers the bot once per newly stored patient message', async () => {
  const handled = [];
  const stored = new Set();
  const app = createApp({
    database: {
      persistWebhookMessage: async ({ message }) => {
        const isNew = !stored.has(message.infobipMessageId);
        stored.add(message.infobipMessageId);
        return { message: isNew ? { id: message.infobipMessageId } : null };
      },
    },
    infobipWebhookToken: 'receiver-token',
    faqBot: { handleInbound: async (message) => handled.push(message) },
  });

  assert.equal((await postInbound(app, textPayload('in-1'))).status, 200);
  assert.equal((await postInbound(app, textPayload('in-1'))).status, 200);

  assert.deepEqual(handled, [{ waId: PATIENT, messageType: 'text', replyId: null, body: 'Oi' }]);
});

test('a bot failure does not fail the webhook that already stored the message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const app = createApp({
    database: { persistWebhookMessage: async () => ({ message: { id: 'stored' } }) },
    infobipWebhookToken: 'receiver-token',
    faqBot: {
      handleInbound: async () => {
        throw new Error('Infobip down');
      },
    },
  });

  const response = await postInbound(app, textPayload('in-3'));

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { accepted: 1, ignored: 0 });
  assert.equal(console.error.mock.callCount(), 1);
});

test('coexistence echoes from the Business App never trigger the bot', async () => {
  const handled = [];
  const app = createApp({
    database: { persistWebhookMessage: async () => ({ message: { id: 'stored' } }) },
    infobipWebhookToken: 'receiver-token',
    faqBot: { handleInbound: async (message) => handled.push(message) },
  });

  await postInbound(app, {
    entry: [{
      changes: [{
        field: 'smb_message_echoes',
        value: {
          messageEchoes: [{
            from: 'clinic',
            to: PATIENT,
            id: 'wamid.echo',
            timestamp: '1790362521',
            type: 'text',
            text: { body: 'Olá, aqui é a equipe' },
          }],
        },
      }],
    }],
  });

  assert.equal(handled.length, 0);
});
