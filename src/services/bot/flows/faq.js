// Fluxo `faq` (T13): respostas montadas na hora a partir do catálogo
// (`ctx.repos.catalog`, seção 3.2 de plan-backlog.md). Sem banco próprio.
//
// Contrato: { name, start(ctx, input?), handle(ctx, input) }.
//
// Tópicos (valor de `ctx.state.step`, ou `input.intent` em texto livre):
//   services       serviços (duração, vagas por horário, profissionais),
//                  valores em R$ e `sobre_servico_<id>`      (intents: prices)
//   insurance      convênios + `formas_pagamento`            (insurance)
//   hours_address  horários, feriados dos próximos 30 dias, `endereco`
//                                                            (address, hours)
//   first_visit    `primeira_consulta`, `o_que_levar`, `politica_cancelamento`
//
// Cada resposta é um texto (até 4096) seguido de uma mensagem de 3 botões:
//   faq:answer|book (Agendar), menu:main|show (Voltar ao menu),
//   menu:main|human (Falar com a equipe).
// O `next` das respostas é null (a conversa volta ao estado livre; os botões
// são roteados pelo prefixo do id). Eventos: `faq:<tópico>`.
//
// `handle`: faq:answer|book -> next booking/choose_service; texto com intenção
// de FAQ -> a resposta; qualquer outra coisa -> o menu (via `menuReply`).

import { menuReply, MENU_STEP } from './menu.js';

export const FAQ_TOPICS = Object.freeze(['services', 'insurance', 'hours_address', 'first_visit']);

/** Intenção de texto livre (intents.js) -> tópico do FAQ. */
export const FAQ_TOPIC_BY_INTENT = Object.freeze({
  prices: 'services',
  insurance: 'insurance',
  address: 'hours_address',
  hours: 'hours_address',
});

const DEFAULT_TIMEZONE = 'America/Bahia';
const HOLIDAY_WINDOW_DAYS = 30;
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const PRICE_KINDS = Object.freeze({
  avulso: 'avulso (por sessão)',
  pacote: 'pacote',
  mensalidade: 'mensalidade',
});
const KIND_ORDER = ['avulso', 'pacote', 'mensalidade'];

const NO_INFO = 'Não tenho essa informação aqui. A nossa equipe pode ajudar.';

/** 120 -> "R$ 120,00"; 1234.5 -> "R$ 1.234,50". */
export function formatBRL(amount) {
  const [integer, cents] = Number(amount).toFixed(2).split('.');
  return `R$ ${integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
}

/** Data local (YYYY-MM-DD) de `date` no fuso. */
function localDate(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-12-25" -> "25/12 (sexta-feira)". */
function formatHoliday(isoDate) {
  const [, month, day] = isoDate.split('-');
  const weekday = WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()];
  return `${day}/${month} (${weekday})`;
}

const hourLabel = (hour) => `${hour}h`;

function listJoin(items) {
  if (items.length <= 1) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

function entryMap(entries) {
  return new Map((entries ?? []).map((entry) => [entry.slug, entry.answer]));
}

async function servicesAnswer(catalog) {
  const [services, prices, entries] = await Promise.all([
    catalog.listServices(), catalog.listPrices(), catalog.listFaqEntries(),
  ]);
  if (!services.length) {
    return NO_INFO;
  }
  const faq = entryMap(entries);
  const blocks = services.map((service) => {
    const lines = [`*${service.name}*`];
    const details = [`${service.durationMin} min por sessão`];
    details.push(service.slotCapacity === 1
      ? '1 vaga por horário'
      : `${service.slotCapacity} vagas por horário`);
    lines.push(details.join(' · '));
    if (service.professionals?.length) {
      lines.push(`Profissionais: ${listJoin(service.professionals.map((p) => p.name))}`);
    }
    const own = prices
      .filter((price) => price.serviceId === service.id)
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    for (const price of own) {
      lines.push(`${PRICE_KINDS[price.kind] ?? price.kind}: ${formatBRL(price.amount)}`);
    }
    const about = faq.get(`sobre_servico_${service.id}`);
    if (about) {
      lines.push(about);
    }
    return lines.join('\n');
  });
  return `Nossos serviços e valores:\n\n${blocks.join('\n\n')}`;
}

async function insuranceAnswer(catalog) {
  const [plans, entries] = await Promise.all([catalog.listInsurancePlans(), catalog.listFaqEntries()]);
  const faq = entryMap(entries);
  const parts = [];
  if (plans.length) {
    parts.push(`Convênios aceitos: ${listJoin(plans.map((plan) => plan.name))}.\nCobrem Fisioterapia ambulatorial, RPG e Fisioterapia pélvica. Pilates é por mensalidade e Massagem é só particular.`);
  } else {
    parts.push(NO_INFO);
  }
  if (faq.get('formas_pagamento')) {
    parts.push(`Formas de pagamento:\n${faq.get('formas_pagamento')}`);
  }
  return parts.join('\n\n');
}

function groupOpeningHours(hours) {
  const groups = [];
  for (const entry of [...hours].sort((a, b) => a.weekday - b.weekday)) {
    const last = groups[groups.length - 1];
    if (last && last.firstHour === entry.firstHour && last.lastHour === entry.lastHour
      && last.days[last.days.length - 1] === entry.weekday - 1) {
      last.days.push(entry.weekday);
    } else {
      groups.push({ days: [entry.weekday], firstHour: entry.firstHour, lastHour: entry.lastHour });
    }
  }
  return groups.map((group) => {
    const first = WEEKDAYS_SHORT[group.days[0]];
    const last = WEEKDAYS_SHORT[group.days[group.days.length - 1]];
    const days = group.days.length === 1 ? first : `${first} a ${last}`;
    return `${days}: horários das ${hourLabel(group.firstHour)} às ${hourLabel(group.lastHour)}`;
  });
}

async function hoursAddressAnswer(catalog, ctx) {
  const timezone = ctx.config?.timezone ?? DEFAULT_TIMEZONE;
  const from = localDate(ctx.now, timezone);
  const to = addDays(from, HOLIDAY_WINDOW_DAYS);
  const [hours, holidays, entries] = await Promise.all([
    catalog.getOpeningHours(), catalog.listHolidays({ from, to }), catalog.listFaqEntries(),
  ]);
  const faq = entryMap(entries);
  const parts = [];
  const lines = groupOpeningHours(hours);
  parts.push(lines.length
    ? `Horários de atendimento:\n${lines.join('\n')}`
    : `Horários de atendimento: ${NO_INFO}`);
  parts.push(holidays.length
    ? `Feriados nos próximos 30 dias (não atendemos):\n${holidays.map(formatHoliday).join('\n')}`
    : 'Não há feriados nos próximos 30 dias.');
  parts.push(faq.get('endereco') ? `Endereço:\n${faq.get('endereco')}` : `Endereço: ${NO_INFO}`);
  return parts.join('\n\n');
}

async function firstVisitAnswer(catalog) {
  const faq = entryMap(await catalog.listFaqEntries());
  const sections = [
    ['Primeira consulta', 'primeira_consulta'],
    ['O que levar', 'o_que_levar'],
    ['Cancelamento e remarcação', 'politica_cancelamento'],
  ];
  const parts = sections
    .filter(([, slug]) => faq.get(slug))
    .map(([title, slug]) => `*${title}*\n${faq.get(slug)}`);
  return parts.length ? parts.join('\n\n') : NO_INFO;
}

const BUILDERS = Object.freeze({
  services: (ctx) => servicesAnswer(ctx.repos.catalog),
  insurance: (ctx) => insuranceAnswer(ctx.repos.catalog),
  hours_address: (ctx) => hoursAddressAnswer(ctx.repos.catalog, ctx),
  first_visit: (ctx) => firstVisitAnswer(ctx.repos.catalog),
});

export const FAQ_BUTTONS = Object.freeze([
  { id: 'faq:answer|book', title: 'Agendar' },
  { id: 'menu:main|show', title: 'Voltar ao menu' },
  { id: 'menu:main|human', title: 'Falar com a equipe' },
]);

/** Resposta pronta (texto + botões) de um tópico; null se o tópico não existe. */
export async function answerFor(ctx, topic) {
  const build = BUILDERS[topic];
  if (!build) {
    return null;
  }
  const text = await build(ctx);
  return {
    replies: [
      { type: 'text', text },
      { type: 'buttons', body: 'Posso ajudar com mais alguma coisa?', buttons: FAQ_BUTTONS.map((b) => ({ ...b })) },
    ],
    next: null,
    events: [{ stepKey: `faq:${topic}` }],
  };
}

function showMenu(ctx) {
  return {
    replies: [menuReply(ctx, { misunderstood: true })],
    next: { flow: 'menu', step: MENU_STEP, context: {} },
    events: [{ stepKey: 'menu:show' }],
    misunderstood: true,
  };
}

async function respondByText(ctx, input) {
  const topic = FAQ_TOPIC_BY_INTENT[input?.intent];
  return topic ? answerFor(ctx, topic) : null;
}

export const faqFlow = {
  name: 'faq',

  // Tópico vem de `input.intent` (texto livre) ou de `ctx.state.step`
  // (transição do menu). Sem tópico válido, mostra o menu.
  async start(ctx, input) {
    const topic = FAQ_TOPIC_BY_INTENT[input?.intent] ?? ctx.state?.step;
    return (await answerFor(ctx, topic)) ?? showMenu(ctx);
  },

  async handle(ctx, input) {
    if (input?.reply?.flow === 'faq' && input.reply.step === 'answer' && input.reply.value === 'book') {
      return { replies: [], next: { flow: 'booking', step: 'choose_service', context: {} }, events: [] };
    }
    return (await respondByText(ctx, input))
      ?? (BUILDERS[input?.reply?.step] && input?.reply?.flow === 'faq'
        ? answerFor(ctx, input.reply.step)
        : showMenu(ctx));
  },
};

export default faqFlow;
