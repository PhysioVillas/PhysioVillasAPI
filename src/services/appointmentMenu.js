const BOOKING_MENU_ID = 'menu_agendar';
const PREFIX = 'agenda:';
const PAGE_SIZE = 7;
const catalogCode = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const timeFormat = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function actionId(step, ...parts) {
  return PREFIX + [step, ...parts].join('|');
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function menu(body, title, rows, restartId = BOOKING_MENU_ID) {
  return {
    action: 'appointment_menu',
    list: {
      body,
      buttonTitle: 'Ver opções',
      sections: [{
        title,
        rows: [...rows, { id: restartId, title: restartId === 'menu_atendente' ? 'Falar com a equipe' : 'Recomeçar agendamento' }],
      }],
    },
  };
}

function paginatedMenu({ body, title, options, page, pageId, restartId }) {
  const lastPage = Math.max(0, Math.ceil(options.length / PAGE_SIZE) - 1);
  const current = Math.min(page, lastPage);
  const rows = options.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  if (current > 0) rows.push({ id: pageId(current - 1), title: 'Opções anteriores' });
  if (current < lastPage) rows.push({ id: pageId(current + 1), title: 'Mais opções' });
  return menu(body, title, rows, restartId);
}

function buildRow(id, title) {
  return { id, title: Array.from(title).slice(0, 24).join('') };
}

const dateLabel = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC',
});

function describeDate(date) {
  return dateLabel.format(new Date(date + 'T00:00:00Z'));
}

function parsePatientAppointmentRequest(body) {
  if (typeof body !== 'string') return null;
  const normalized = body.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const parts = normalized.split('|').map((part) => part.trim());
  const [command, serviceCode, professionalCode, date, time] = parts;
  if (parts.length !== 5 || command !== 'agendar' || !catalogCode.test(serviceCode)
    || !catalogCode.test(professionalCode) || !validDate(date) || !timeFormat.test(time)) return null;
  return { serviceCode, professionalCode, date, time };
}

async function requestAvailableSlot({ database, selection, registerRequest }) {
  const { serviceCode, professionalCode, date, time } = selection;
  const slots = await database.listAvailableAppointmentSlots({ serviceCode, professionalCode, date });
  const slot = slots.find((candidate) => candidate.time === time);
  return slot
    ? registerRequest({ serviceCode, professionalCode, startsAt: slot.startsAt, endsAt: slot.endsAt })
    : { action: 'slot_unavailable' };
}

async function handleAppointmentMenu({ database, replyId, registerRequest }) {
  if (typeof replyId !== 'string' || (replyId !== BOOKING_MENU_ID && !replyId.startsWith(PREFIX))) {
    return null;
  }

  const [step, ...args] = replyId === BOOKING_MENU_ID
    ? ['services', '0']
    : replyId.slice(PREFIX.length).split('|');
  const pageParam = args.at(-1);
  const page = /^\d{1,2}$/.test(pageParam ?? '') ? Number(pageParam) : 0;
  const [serviceCode, professionalCode, date, time] = args;

  if (step === 'services' && args.length === 1) {
    const catalog = await database.listAppointmentProfessionals();
    const services = new Map(catalog.map((row) => [row.serviceCode, row.serviceName]));
    return paginatedMenu({
      body: services.size ? 'Escolha o serviço para solicitar uma consulta.' : 'A agenda está indisponível no momento. Nossa equipe pode ajudar.',
      title: 'Serviços',
      options: [...services].map(([code, name]) => buildRow(actionId('professionals', code, 0), name)),
      page,
      pageId: (next) => actionId('services', next),
      restartId: 'menu_atendente',
    });
  }

  if (!catalogCode.test(serviceCode ?? '')) return null;
  if (step === 'professionals' && args.length === 2) {
    const catalog = await database.listAppointmentProfessionals(serviceCode);
    return paginatedMenu({
      body: catalog.length ? 'Escolha o profissional.' : 'Este serviço está indisponível. Escolha outro serviço.',
      title: 'Profissionais',
      options: catalog.map((row) => buildRow(actionId('dates', serviceCode, row.professionalCode, 0), row.professionalName)),
      page,
      pageId: (next) => actionId('professionals', serviceCode, next),
    });
  }

  if (!catalogCode.test(professionalCode ?? '')) return null;
  if (step === 'dates' && args.length === 3) {
    const slots = await database.listAvailableAppointmentSlots({ serviceCode, professionalCode });
    const dates = [...new Set(slots.map((slot) => slot.date))];
    return paginatedMenu({
      body: dates.length ? 'Escolha um dia com horários disponíveis.' : 'Não há horários disponíveis nos próximos 21 dias para essa escolha.',
      title: 'Dias disponíveis',
      options: dates.map((day) => buildRow(actionId('times', serviceCode, professionalCode, day, 0), describeDate(day))),
      page,
      pageId: (next) => actionId('dates', serviceCode, professionalCode, next),
    });
  }

  if (!validDate(date) || args.length !== 4) return null;
  if (step === 'times') {
    const slots = await database.listAvailableAppointmentSlots({ serviceCode, professionalCode, date });
    return paginatedMenu({
      body: slots.length ? `Escolha um horário para ${describeDate(date)}.` : 'Os horários desse dia não estão mais disponíveis.',
      title: 'Horários disponíveis',
      options: slots.map((slot) => buildRow(actionId('request', serviceCode, professionalCode, date, slot.time), slot.time)),
      page,
      pageId: (next) => actionId('times', serviceCode, professionalCode, date, next),
    });
  }

  if (step === 'request' && timeFormat.test(time)) {
    return requestAvailableSlot({ database, selection: { serviceCode, professionalCode, date, time }, registerRequest });
  }
  return null;
}

export { BOOKING_MENU_ID, handleAppointmentMenu, parsePatientAppointmentRequest, requestAvailableSlot };
