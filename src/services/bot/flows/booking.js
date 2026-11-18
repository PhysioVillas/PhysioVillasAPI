// Fluxo `booking` (T14): agendamento de consulta pelo chatbot.
//
// Etapas (`next.step`) e ids das linhas/botões (`booking:<step>|<valor>`):
//   choose_service      booking:choose_service|<serviceId>
//   choose_professional booking:choose_professional|<professionalId>|any
//                       (pulada quando o serviço tem 1 profissional)
//   choose_payment      booking:choose_payment|ins:<insuranceId>|avulso|pacote|mensalidade
//                       (só as combinações com preço, seção 3.3.3 do backlog;
//                       com uma única opção, ela é escolhida sozinha)
//   choose_day          booking:choose_day|YYYY-MM-DD (o engine pagina > 10)
//   choose_time         booking:choose_time|<hora>-<professionalId>|other_day
//   confirm             booking:confirm|yes|change|cancel
//   no_slots            booking:no_slots|other_professional|human
//                       (+ `menu:main|show`, do fluxo menu)
// Eventos: `booking:<step>` sempre que a etapa é mostrada, `booking:booked`
// ao marcar e `booking:cancelled` quando a pessoa desiste na confirmação.
//
// Contexto (`next.context`, sem `patient`, que o engine carrega sozinho):
//   serviceId, professionalId (preferência; null = sem preferência),
//   payment {method, insuranceId}, date (YYYY-MM-DD),
//   time {hour, professionalId, professionalName}, newPatient.
//
// Entradas:
// - Sem paciente verificado (`ctx.patient`) → `next` para a triagem em
//   `choose_service`; se o serviço já é conhecido, vai em `context.serviceId`
//   (a triagem então pula para o pagamento). `newPatient` sem `patient` não
//   basta: `book` exige o id do paciente, e a triagem (3.3.3) o envia.
// - Triagem → `start` com `ctx.state.step === 'choose_day'`, `serviceId` e
//   `payment`: começa direto nos dias (qualquer profissional).
// - Texto numa etapa de escolha: casa com o título (sem caixa e sem acento),
//   com apelidos (ex.: "10h", "27/11") ou com o número da linha; senão,
//   `misunderstood: true` e a etapa é repetida.
//
// Regras: antes de confirmar (e de novo ao confirmar) confere `listUpcoming`
// para o mesmo paciente não marcar duas consultas na mesma data e hora;
// `slot_unavailable` no `book` volta para os horários do mesmo dia. O lead
// (`upsertLead`) é atualizado nas etapas serviço, horário e marcou; falha do
// lead nunca interrompe o agendamento.

import { PAYMENT_METHODS } from '../../clinic/appointmentRepository.js';

const FLOW = 'booking';
const DEFAULT_TIMEZONE = 'America/Bahia';
const DEFAULT_HORIZON_DAYS = 21;
const DEFAULT_MIN_NOTICE_HOURS = 24;

export const BOOKING_STEPS = Object.freeze({
  service: 'choose_service',
  professional: 'choose_professional',
  payment: 'choose_payment',
  day: 'choose_day',
  time: 'choose_time',
  confirm: 'confirm',
  noSlots: 'no_slots',
});

const PARTICULAR_KINDS = Object.freeze({
  'Particular avulso': { value: 'avulso', kind: 'avulso', suffix: 'por sessão' },
  'Pacote particular': { value: 'pacote', kind: 'pacote', suffix: 'o pacote' },
  Mensalidade: { value: 'mensalidade', kind: 'mensalidade', suffix: 'por mês' },
});

const WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const WEEKDAYS_LONG = [
  'domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado',
];
const MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

export const BOOKING_TEXTS = Object.freeze({
  chooseService: 'Qual serviço você quer agendar?',
  chooseProfessional: (service) => `Com qual profissional de ${service} você prefere?`,
  choosePayment: (service) => `Como vai ser o pagamento de ${service}?`,
  singlePayment: (service, label) => `${service} é atendido na modalidade ${label}.`,
  chooseDay: (service, professional) => `Escolha o dia para ${service}${professional ? ` com ${professional}` : ''}:`,
  chooseTime: (day) => `Horários livres em ${day}:`,
  noSlots: (service, professional, days) => `Não encontrei horários livres para ${service}`
    + `${professional ? ` com ${professional}` : ''} nos próximos ${days} dias.`,
  noPayment: 'Não encontrei uma forma de pagamento disponível para esse serviço.',
  noServices: 'Não consegui carregar os serviços agora.',
  dayFull: 'Esse dia não tem mais horários livres. Escolha outro dia:',
  slotGone: 'Esse horário acabou de ser preenchido. Escolha outro:',
  slotLost: 'Que pena, esse horário foi reservado por outra pessoa agora há pouco. Escolha outro:',
  duplicate: (when) => `Você já tem uma consulta marcada para ${when}. Escolha outro horário:`,
  confirm: ({ service, professional, when, payment }) => [
    'Confira os dados da consulta:',
    '',
    `*Serviço:* ${service}`,
    `*Profissional:* ${professional}`,
    `*Data:* ${when}`,
    `*Pagamento:* ${payment}`,
    '',
    'Posso confirmar?',
  ].join('\n'),
  cancelled: 'Tudo bem, não marquei nenhum horário. Quando quiser, é só enviar MENU.',
  misunderstood: 'Não entendi sua resposta. Toque em uma das opções ou digite o número dela.',
  bookingFailed: 'Não consegui concluir o agendamento por aqui.',
  booked: ({ name, service, professional, when, payment, address, bring, noticeHours }) => [
    `Pronto${name ? `, ${name}` : ''}! Sua consulta está marcada.`,
    '',
    `*${service}* com ${professional}`,
    `*Quando:* ${when}`,
    `*Pagamento:* ${payment}`,
    '',
    `*Endereço:* ${address}`,
    '',
    `*O que levar:* ${bring}`,
    '',
    `Precisa remarcar ou cancelar? Pelo menu "Minhas consultas" você faz isso até ${noticeHours} h antes`
      + ` do horário. Com menos de ${noticeHours} h, nossa equipe te ajuda.`,
  ].join('\n'),
  defaultAddress: 'nossa equipe envia o endereço por aqui.',
  defaultBring: 'um documento com foto e, se for usar convênio, a carteirinha.',
});

// --- utilitários --------------------------------------------------------------

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function dateParts(date) {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

function pad(number) {
  return String(number).padStart(2, '0');
}

export function formatHour(hour) {
  return `${pad(hour)}:00`;
}

/** "sex, 27/11" */
export function formatShortDay(date) {
  const { month, day, weekday } = dateParts(date);
  return `${WEEKDAYS_SHORT[weekday]}, ${pad(day)}/${pad(month)}`;
}

/** "sexta-feira, 27 de novembro" */
export function formatLongDay(date) {
  const { month, day, weekday } = dateParts(date);
  return `${WEEKDAYS_LONG[weekday]}, ${day} de ${MONTHS[month - 1]}`;
}

/** "sexta-feira, 27 de novembro, às 08:00" */
export function formatWhen(date, hour) {
  return `${formatLongDay(date)}, às ${formatHour(hour)}`;
}

/** "R$ 1.200,00" */
export function formatMoney(amount) {
  const [int, cents] = Number(amount).toFixed(2).split('.');
  return `R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
}

function localDate(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function sameId(a, b) {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
}

function cleanContext(context) {
  const { patient: _patient, _pages, ...rest } = context && typeof context === 'object' ? context : {};
  return rest;
}

// Só o que sobrevive a um recomeço pelo serviço.
function baseOf(context) {
  return context?.newPatient === undefined ? {} : { newPatient: context.newPatient };
}

function patientOf(ctx) {
  const patient = ctx.patient ?? ctx.state?.context?.patient ?? null;
  return patient && patient.id !== undefined && patient.id !== null ? patient : null;
}

function horizonDays(ctx) {
  return Number(ctx.config?.bookingHorizonDays ?? DEFAULT_HORIZON_DAYS);
}

function timezoneOf(ctx) {
  return ctx.config?.timezone ?? DEFAULT_TIMEZONE;
}

function text(value) {
  return { type: 'text', text: value };
}

function result(replies, step, context, { events, misunderstood } = {}) {
  const out = {
    replies,
    next: { flow: FLOW, step, context: { ...context } },
    events: events ?? [{ stepKey: `${FLOW}:${step}` }],
  };
  if (misunderstood) {
    out.misunderstood = true;
  }
  return out;
}

function withNotice(notice, replies) {
  return notice ? [text(notice), ...replies] : replies;
}

function listReply(step, body, choices, buttonTitle = 'Ver opções') {
  return {
    type: 'list',
    body,
    buttonTitle,
    sections: [{
      rows: choices.map((choice) => {
        const row = { id: `${FLOW}:${step}|${choice.value}`, title: choice.title };
        if (choice.description) {
          row.description = choice.description;
        }
        return row;
      }),
    }],
  };
}

/** Escolha por texto: título/apelido exato, número da linha, ou trecho único. */
export function matchChoice(input, choices) {
  const typed = normalizeText(input);
  if (!typed) {
    return null;
  }
  const names = (choice) => [choice.title, ...(choice.aliases ?? [])].map(normalizeText);
  const exact = choices.find((choice) => names(choice).includes(typed));
  if (exact) {
    return exact;
  }
  if (/^\d{1,2}$/.test(typed)) {
    return choices[Number(typed) - 1] ?? null;
  }
  const partial = choices.filter((choice) => {
    const title = normalizeText(choice.title);
    return title.length > 2 && (title.includes(typed) || typed.includes(title));
  });
  return partial.length === 1 ? partial[0] : null;
}

async function trackLead(ctx, fields) {
  const patients = ctx.repos?.patients;
  if (typeof patients?.upsertLead !== 'function') {
    return;
  }
  const patient = patientOf(ctx);
  try {
    await patients.upsertLead({
      waId: ctx.waId,
      outsideBusinessHours: !ctx.inBusinessHours,
      ...(patient ? { patientId: patient.id } : {}),
      ...fields,
    });
  } catch {
    // O lead é métrica: falhar aqui não pode impedir o agendamento.
  }
}

// --- catálogo -------------------------------------------------------------------

async function loadServices(ctx) {
  return ctx.repos.catalog.listServices();
}

async function findService(ctx, serviceId) {
  return (await loadServices(ctx)).find((service) => sameId(service.id, serviceId)) ?? null;
}

function serviceKind(service) {
  const name = normalizeText(service?.name);
  if (name.includes('pilates')) return 'pilates';
  if (name.includes('massag')) return 'massagem';
  return 'default';
}

function insuranceLabel(plan) {
  return normalizeText(plan.name).startsWith('convenio') ? plan.name : `Convênio ${plan.name}`;
}

/**
 * Formas de pagamento oferecidas para o serviço (3.3.3): Pilates → só
 * Mensalidade; Massagem → só Particular avulso; demais → convênios,
 * Particular avulso e Pacote particular. Formas particulares sem preço em
 * `d_precos` ficam de fora.
 */
export async function paymentOptions(ctx, service) {
  const kind = serviceKind(service);
  const methods = kind === 'pilates'
    ? ['Mensalidade']
    : kind === 'massagem'
      ? ['Particular avulso']
      : ['Convênio', 'Particular avulso', 'Pacote particular'];
  const prices = await ctx.repos.catalog.listPrices();
  const plans = methods.includes('Convênio') ? await ctx.repos.catalog.listInsurancePlans() : [];
  const options = [];
  for (const method of methods) {
    if (method === 'Convênio') {
      for (const plan of plans) {
        options.push({
          value: `ins:${plan.id}`,
          title: plan.name,
          description: 'Convênio',
          label: insuranceLabel(plan),
          payment: { method: 'Convênio', insuranceId: Number(plan.id) },
        });
      }
      continue;
    }
    const info = PARTICULAR_KINDS[method];
    const price = prices.find((p) => sameId(p.serviceId, service.id) && p.kind === info.kind);
    if (!price || price.amount === null || price.amount === undefined || Number.isNaN(Number(price.amount))) {
      continue;
    }
    const money = formatMoney(price.amount);
    options.push({
      value: info.value,
      title: method,
      description: `${money} ${info.suffix}`,
      label: `${method} (${money} ${info.suffix})`,
      payment: { method, insuranceId: null },
    });
  }
  return options;
}

function samePayment(a, b) {
  return a?.method === b?.method
    && (a.method !== 'Convênio' || sameId(a.insuranceId, b.insuranceId));
}

function validPayment(payment) {
  return Boolean(payment)
    && PAYMENT_METHODS.includes(payment.method)
    && (payment.method !== 'Convênio' || (payment.insuranceId !== null && payment.insuranceId !== undefined));
}

async function paymentLabel(ctx, service, payment, sessionValue) {
  const options = await paymentOptions(ctx, service);
  const option = options.find((o) => samePayment(o.payment, payment));
  if (payment.method !== 'Convênio' && sessionValue !== null && sessionValue !== undefined) {
    const info = PARTICULAR_KINDS[payment.method];
    return `${payment.method} (${formatMoney(sessionValue)}${info ? ` ${info.suffix}` : ''})`;
  }
  return option?.label ?? payment.method;
}

// --- etapas (mostrar) -----------------------------------------------------------

function toTriage(context) {
  const triageContext = context.serviceId !== undefined ? { serviceId: context.serviceId } : {};
  return { replies: [], next: { flow: 'triage', step: 'choose_service', context: triageContext }, events: [] };
}

async function showService(ctx, context, { notice, silent } = {}) {
  const services = await loadServices(ctx);
  if (services.length === 0) {
    return { replies: [text(BOOKING_TEXTS.noServices)], next: null, handoff: { reason: 'bot_failure' }, events: [] };
  }
  if (!silent) {
    await trackLead(ctx, { stage: 'service' });
  }
  const choices = services.map((service) => ({
    value: String(service.id),
    title: service.name,
    description: service.durationMin ? `${service.durationMin} min` : undefined,
  }));
  return {
    ...result(
      withNotice(notice, [listReply(BOOKING_STEPS.service, BOOKING_TEXTS.chooseService, choices, 'Ver serviços')]),
      BOOKING_STEPS.service,
      context,
    ),
    choices,
  };
}

async function showProfessional(ctx, context, { notice, service: known } = {}) {
  const service = known ?? await findService(ctx, context.serviceId);
  if (!service) {
    return showService(ctx, baseOf(context), { notice });
  }
  const choices = [
    ...service.professionals.map((p) => ({ value: String(p.id), title: p.name })),
    { value: 'any', title: 'Sem preferência', description: 'Primeiro horário livre', aliases: ['tanto faz', 'qualquer'] },
  ];
  return {
    ...result(
      withNotice(notice, [listReply(BOOKING_STEPS.professional, BOOKING_TEXTS.chooseProfessional(service.name), choices)]),
      BOOKING_STEPS.professional,
      context,
    ),
    choices,
  };
}

async function showPayment(ctx, context, { notice, service: known, silent } = {}) {
  const service = known ?? await findService(ctx, context.serviceId);
  if (!service) {
    return showService(ctx, baseOf(context), { notice });
  }
  const options = await paymentOptions(ctx, service);
  if (options.length === 0) {
    return { replies: [text(BOOKING_TEXTS.noPayment)], next: null, handoff: { reason: 'bot_failure' }, events: [] };
  }
  if (options.length === 1) {
    const [only] = options;
    const notices = [notice, BOOKING_TEXTS.singlePayment(service.name, only.label)].filter(Boolean).join('\n\n');
    return showDay(ctx, { ...context, payment: only.payment }, { notice: notices, service, silent });
  }
  const choices = options.map(({ value, title, description }) => ({ value, title, description }));
  return {
    ...result(
      withNotice(notice, [listReply(BOOKING_STEPS.payment, BOOKING_TEXTS.choosePayment(service.name), choices)]),
      BOOKING_STEPS.payment,
      context,
    ),
    choices,
  };
}

async function showDay(ctx, context, { notice, service: known, silent } = {}) {
  const service = known ?? await findService(ctx, context.serviceId);
  if (!service) {
    return showService(ctx, baseOf(context), { notice });
  }
  const next = { ...context };
  delete next.date;
  delete next.time;
  if (!silent) {
    await trackLead(ctx, { stage: 'time', serviceInterestId: service.id });
  }
  const days = await ctx.repos.appointments.listAvailableDays({
    serviceId: service.id,
    professionalId: next.professionalId ?? null,
    from: localDate(ctx.now, timezoneOf(ctx)),
    horizonDays: horizonDays(ctx),
    now: ctx.now,
  });
  if (days.length === 0) {
    return showNoSlots(ctx, next, service, notice);
  }
  const professional = service.professionals.find((p) => sameId(p.id, next.professionalId));
  const choices = days.map(({ date, freeSlots }) => {
    const { day, month } = dateParts(date);
    return {
      value: date,
      title: formatShortDay(date),
      description: `${freeSlots} ${freeSlots === 1 ? 'horário livre' : 'horários livres'}`,
      aliases: [`${pad(day)}/${pad(month)}`, `${day}/${month}`, String(day), pad(day)],
    };
  });
  return {
    ...result(
      withNotice(notice, [listReply(
        BOOKING_STEPS.day,
        BOOKING_TEXTS.chooseDay(service.name, professional?.name),
        choices,
        'Ver dias',
      )]),
      BOOKING_STEPS.day,
      next,
    ),
    choices,
  };
}

function showNoSlots(ctx, context, service, notice) {
  const professional = service.professionals.find((p) => sameId(p.id, context.professionalId));
  const buttons = [];
  const choices = [];
  if (professional && service.professionals.length > 1) {
    choices.push({ value: 'other_professional', title: 'Outro profissional' });
  }
  choices.push({ value: 'human', title: 'Falar com a equipe', aliases: ['equipe', 'atendente'] });
  for (const choice of choices) {
    buttons.push({ id: `${FLOW}:${BOOKING_STEPS.noSlots}|${choice.value}`, title: choice.title });
  }
  buttons.push({ id: 'menu:main|show', title: 'Voltar ao menu' });
  return {
    ...result(
      withNotice(notice, [{
        type: 'buttons',
        body: BOOKING_TEXTS.noSlots(service.name, professional?.name, horizonDays(ctx)),
        buttons,
      }]),
      BOOKING_STEPS.noSlots,
      context,
    ),
    choices,
  };
}

async function showTime(ctx, context, { notice } = {}) {
  const next = { ...context };
  delete next.time;
  const times = await ctx.repos.appointments.listAvailableTimes({
    serviceId: Number(next.serviceId),
    professionalId: next.professionalId ?? null,
    date: next.date,
    horizonDays: horizonDays(ctx),
    now: ctx.now,
  });
  if (times.length === 0) {
    const notices = [notice, BOOKING_TEXTS.dayFull].filter(Boolean).join('\n\n');
    return showDay(ctx, next, { notice: notices, silent: true });
  }
  const choices = times.map(({ hour, professionalId, professionalName, remaining }) => ({
    value: `${hour}-${professionalId}`,
    title: formatHour(hour),
    description: `com ${professionalName}${remaining > 1 ? ` · ${remaining} vagas` : ''}`,
    aliases: [`${hour}h`, `${pad(hour)}h`, String(hour), pad(hour), `${hour}:00`],
  }));
  choices.push({ value: 'other_day', title: 'Outro dia', description: 'Ver outros dias' });
  return {
    ...result(
      withNotice(notice, [listReply(
        BOOKING_STEPS.time,
        BOOKING_TEXTS.chooseTime(formatShortDay(next.date)),
        choices,
        'Ver horários',
      )]),
      BOOKING_STEPS.time,
      next,
    ),
    choices,
  };
}

async function showConfirm(ctx, context, { notice } = {}) {
  const service = await findService(ctx, context.serviceId);
  if (!service) {
    return showService(ctx, baseOf(context), { notice });
  }
  const choices = [
    { value: 'yes', title: 'Confirmar', aliases: ['sim', 'confirmo', 'ok', 'pode', 'pode confirmar', 's'] },
    { value: 'change', title: 'Trocar horário', aliases: ['trocar', 'outro horario'] },
    { value: 'cancel', title: 'Cancelar', aliases: ['nao', 'desistir', 'n'] },
  ];
  const body = BOOKING_TEXTS.confirm({
    service: service.name,
    professional: context.time.professionalName,
    when: formatWhen(context.date, context.time.hour),
    payment: await paymentLabel(ctx, service, context.payment),
  });
  return {
    ...result(
      withNotice(notice, [{
        type: 'buttons',
        body,
        buttons: choices.map((c) => ({ id: `${FLOW}:${BOOKING_STEPS.confirm}|${c.value}`, title: c.title })),
      }]),
      BOOKING_STEPS.confirm,
      context,
    ),
    choices,
  };
}

/** Mostra a etapa atual de novo (texto não entendido, clique antigo etc.). */
async function showStep(ctx, step, context, options = {}) {
  const opts = { silent: true, ...options };
  if (step === BOOKING_STEPS.professional && context.serviceId !== undefined) {
    return showProfessional(ctx, context, opts);
  }
  if (step === BOOKING_STEPS.payment && context.serviceId !== undefined) {
    return showPayment(ctx, context, opts);
  }
  if (step === BOOKING_STEPS.day && context.serviceId !== undefined && validPayment(context.payment)) {
    return showDay(ctx, context, opts);
  }
  if (step === BOOKING_STEPS.noSlots && context.serviceId !== undefined && validPayment(context.payment)) {
    return showDay(ctx, context, opts);
  }
  if (step === BOOKING_STEPS.time && context.date && validPayment(context.payment)) {
    return showTime(ctx, context, opts);
  }
  if (step === BOOKING_STEPS.confirm && context.time && context.date && validPayment(context.payment)) {
    return showConfirm(ctx, context, opts);
  }
  return showService(ctx, baseOf(context), opts);
}

// --- etapas (escolher) ----------------------------------------------------------

async function selectService(ctx, context, value) {
  const service = await findService(ctx, value);
  if (!service) {
    return misunderstood(await showService(ctx, context, { silent: true }));
  }
  const next = { ...baseOf(context), serviceId: service.id };
  await trackLead(ctx, { stage: 'service', serviceInterestId: service.id });
  if (service.professionals.length > 1) {
    return showProfessional(ctx, next, { service });
  }
  next.professionalId = service.professionals[0]?.id ?? null;
  return showPayment(ctx, next, { service });
}

async function selectProfessional(ctx, context, value) {
  const service = await findService(ctx, context.serviceId);
  if (!service) {
    return showService(ctx, baseOf(context));
  }
  const professional = service.professionals.find((p) => sameId(p.id, value));
  if (value !== 'any' && !professional) {
    return misunderstood(await showProfessional(ctx, context, { service }));
  }
  const next = { ...context, professionalId: professional ? professional.id : null };
  if (validPayment(next.payment)) {
    return showDay(ctx, next, { service });
  }
  return showPayment(ctx, next, { service });
}

async function selectPayment(ctx, context, value) {
  const service = await findService(ctx, context.serviceId);
  if (!service) {
    return showService(ctx, baseOf(context));
  }
  const option = (await paymentOptions(ctx, service)).find((o) => o.value === value);
  if (!option) {
    return misunderstood(await showPayment(ctx, context, { service, silent: true }));
  }
  return showDay(ctx, { ...context, payment: option.payment }, { service });
}

async function selectDay(ctx, context, value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return misunderstood(await showDay(ctx, context, { silent: true }));
  }
  return showTime(ctx, { ...context, date: value });
}

async function hasConflict(ctx, patient, date, hour) {
  const upcoming = await ctx.repos.appointments.listUpcoming({ patientId: patient.id, now: ctx.now });
  return upcoming.some((a) => a.date === date && Number(a.hour) === Number(hour));
}

async function selectTime(ctx, context, value, patient) {
  if (value === 'other_day') {
    return showDay(ctx, context, { silent: true });
  }
  const match = /^(\d{1,2})-(\d+)$/.exec(value);
  if (!match) {
    return misunderstood(await showTime(ctx, context));
  }
  const hour = Number(match[1]);
  const times = await ctx.repos.appointments.listAvailableTimes({
    serviceId: Number(context.serviceId),
    professionalId: context.professionalId ?? null,
    date: context.date,
    horizonDays: horizonDays(ctx),
    now: ctx.now,
  });
  const slot = times.find((t) => t.hour === hour && sameId(t.professionalId, match[2]));
  if (!slot) {
    return showTime(ctx, context, { notice: BOOKING_TEXTS.slotGone });
  }
  if (await hasConflict(ctx, patient, context.date, hour)) {
    return showTime(ctx, context, { notice: BOOKING_TEXTS.duplicate(formatWhen(context.date, hour)) });
  }
  return showConfirm(ctx, {
    ...context,
    time: { hour, professionalId: slot.professionalId, professionalName: slot.professionalName },
  });
}

async function faqAnswers(ctx) {
  try {
    const entries = await ctx.repos.catalog.listFaqEntries();
    const bySlug = Object.fromEntries(entries.map((e) => [e.slug, e.answer]));
    return { address: bySlug.endereco, bring: bySlug.o_que_levar };
  } catch {
    return {};
  }
}

async function confirmBooking(ctx, context, patient) {
  const { date, time, payment } = context;
  if (await hasConflict(ctx, patient, date, time.hour)) {
    return showTime(ctx, context, { notice: BOOKING_TEXTS.duplicate(formatWhen(date, time.hour)) });
  }
  const booked = await ctx.repos.appointments.book({
    patientId: patient.id,
    waId: ctx.waId,
    serviceId: Number(context.serviceId),
    professionalId: Number(time.professionalId),
    date,
    hour: Number(time.hour),
    paymentMethod: payment.method,
    insuranceId: payment.method === 'Convênio' ? payment.insuranceId : null,
    now: ctx.now,
  });
  if (!booked?.ok) {
    if (booked?.reason === 'slot_unavailable') {
      return showTime(ctx, context, { notice: BOOKING_TEXTS.slotLost });
    }
    return { replies: [text(BOOKING_TEXTS.bookingFailed)], next: null, handoff: { reason: 'bot_failure' }, events: [] };
  }

  const service = await findService(ctx, context.serviceId);
  await trackLead(ctx, {
    stage: 'booked',
    booked: true,
    patientId: patient.id,
    serviceInterestId: Number(context.serviceId),
  });
  const faq = await faqAnswers(ctx);
  const serviceName = service?.name ?? booked.appointment?.serviceName ?? 'Consulta';
  const message = BOOKING_TEXTS.booked({
    name: patient.firstName,
    service: serviceName,
    professional: time.professionalName,
    when: formatWhen(date, time.hour),
    payment: service
      ? await paymentLabel(ctx, service, payment, booked.appointment?.sessionValue)
      : payment.method,
    address: faq.address ?? BOOKING_TEXTS.defaultAddress,
    bring: faq.bring ?? BOOKING_TEXTS.defaultBring,
    noticeHours: Number(ctx.config?.rescheduleMinNoticeHours ?? DEFAULT_MIN_NOTICE_HOURS),
  });
  return { replies: [text(message)], next: null, events: [{ stepKey: `${FLOW}:booked` }] };
}

async function selectConfirm(ctx, context, value, patient) {
  if (value === 'cancel') {
    return { replies: [text(BOOKING_TEXTS.cancelled)], next: null, events: [{ stepKey: `${FLOW}:cancelled` }] };
  }
  if (value === 'change') {
    return showTime(ctx, context);
  }
  if (value === 'yes') {
    return confirmBooking(ctx, context, patient);
  }
  return misunderstood(await showConfirm(ctx, context));
}

async function selectNoSlots(ctx, context, value) {
  if (value === 'human') {
    return { replies: [], next: null, handoff: { reason: 'patient_request' }, events: [] };
  }
  if (value === 'other_professional') {
    return showProfessional(ctx, { ...context, professionalId: null });
  }
  return misunderstood(await showDay(ctx, context, { silent: true }));
}

function misunderstood(shown) {
  return {
    ...shown,
    replies: [text(BOOKING_TEXTS.misunderstood), ...shown.replies],
    events: [],
    misunderstood: true,
  };
}

// Pré-requisitos de cada etapa no contexto; sem eles, recomeça.
function hasPrerequisites(step, context) {
  switch (step) {
    case BOOKING_STEPS.service:
      return true;
    case BOOKING_STEPS.professional:
    case BOOKING_STEPS.payment:
      return context.serviceId !== undefined;
    case BOOKING_STEPS.day:
    case BOOKING_STEPS.noSlots:
      return context.serviceId !== undefined && validPayment(context.payment);
    case BOOKING_STEPS.time:
      return context.serviceId !== undefined && validPayment(context.payment) && Boolean(context.date);
    case BOOKING_STEPS.confirm:
      return context.serviceId !== undefined && validPayment(context.payment)
        && Boolean(context.date) && Boolean(context.time);
    default:
      return false;
  }
}

async function dispatch(ctx, step, context, value, patient) {
  switch (step) {
    case BOOKING_STEPS.service: return selectService(ctx, context, value);
    case BOOKING_STEPS.professional: return selectProfessional(ctx, context, value);
    case BOOKING_STEPS.payment: return selectPayment(ctx, context, value);
    case BOOKING_STEPS.day: return selectDay(ctx, context, value);
    case BOOKING_STEPS.time: return selectTime(ctx, context, value, patient);
    case BOOKING_STEPS.confirm: return selectConfirm(ctx, context, value, patient);
    case BOOKING_STEPS.noSlots: return selectNoSlots(ctx, context, value);
    default: return showService(ctx, baseOf(context));
  }
}

function strip(flowResult) {
  const { choices: _choices, ...rest } = flowResult;
  return rest;
}

// --- contrato do fluxo ----------------------------------------------------------

async function start(ctx) {
  const context = cleanContext(ctx.state?.context);
  if (!patientOf(ctx)) {
    return toTriage(context);
  }
  const fromState = ctx.state?.flow === FLOW || ctx.state?.flow === undefined;
  if (fromState && ctx.state?.step === BOOKING_STEPS.day && context.serviceId !== undefined) {
    if (validPayment(context.payment)) {
      // Entrada pela triagem: serviço e pagamento já escolhidos.
      return strip(await showDay(ctx, { ...context, professionalId: context.professionalId ?? null }));
    }
    return strip(await selectService(ctx, context, context.serviceId));
  }
  return strip(await showService(ctx, baseOf(context)));
}

async function handle(ctx, input) {
  const context = cleanContext(ctx.state?.context);
  const patient = patientOf(ctx);
  const reply = input?.reply?.flow === FLOW ? input.reply : null;

  if (!patient) {
    if (reply?.step === BOOKING_STEPS.service && /^\d+$/.test(reply.value)) {
      return toTriage({ serviceId: Number(reply.value) });
    }
    return toTriage(context);
  }

  if (reply) {
    if (!hasPrerequisites(reply.step, context)) {
      if (reply.step === BOOKING_STEPS.service) {
        return strip(await dispatch(ctx, reply.step, context, reply.value, patient));
      }
      // Clique antigo sem a conversa salva: recomeça pelo serviço.
      return strip(await showService(ctx, baseOf(context)));
    }
    return strip(await dispatch(ctx, reply.step, context, reply.value, patient));
  }

  const step = ctx.state?.step ?? BOOKING_STEPS.service;
  if (!hasPrerequisites(step, context)) {
    return strip(await showService(ctx, baseOf(context)));
  }
  const shown = await showStep(ctx, step, context);
  if (input?.kind === 'text' && Array.isArray(shown.choices) && shown.next?.step === step) {
    const choice = matchChoice(input.text, shown.choices);
    if (choice) {
      return strip(await dispatch(ctx, step, context, choice.value, patient));
    }
  }
  return strip(misunderstood(shown));
}

export const bookingFlow = Object.freeze({ name: FLOW, start, handle });
export default bookingFlow;
