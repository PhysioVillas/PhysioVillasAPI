// Fluxo `my_appointments` (T15): identifica o paciente pelo CPF, lista as
// consultas futuras e permite remarcar ou cancelar (regra de 24 h do plan.md).
//
// Etapas (`next.step`): ask_cpf, none, pick, action, reschedule_day,
// reschedule_time, confirm_cancel, after_cancel.
//
// Privacidade: o CPF só existe dentro de `handleCpf` (variável local). Nunca
// vai para `context`, respostas, eventos nem log.
//
// IDs: my_appointments:pick|<appointmentId>, :action|reschedule|cancel,
// :day|YYYY-MM-DD, :time|<hora>:<profissionalId>, :confirm|yes|no,
// :after|book, :none|book. "Voltar" usa `menu:main|show` (o engine roteia
// direto para o menu).
//
// Contexto gravado: patient {id, firstName}, appointmentId, date (YYYY-MM-DD).
//
// Botões do lembrete (T19): my_appointments:reminder|confirm|reschedule|cancel
// (opcionalmente `:<appointmentId>`). Chegam sem estado; o paciente é
// identificado pelo wa_id que recebeu o lembrete (`findPatientByWaId`), sem
// CPF. A consulta é a do id, se vier, ou a próxima `Agendado` do paciente
// que começa em até max(reminderHoursBefore) + 24 h. Confirmo grava
// lembrete_confirmado = 'Sim' (ctx.repos.reminders.confirmAttendance);
// Remarcar e Cancelar entram nas etapas normais (com a regra de 24 h). Sem
// paciente pelo wa_id, cai no pedido de CPF.

import { findCpfInText, isValidCpf } from '../cpf.js';
import { parseReminderValue, REMINDER_STEP } from '../reminders.js';

const FLOW = 'my_appointments';
const DEFAULT_TIMEZONE = 'America/Bahia';
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;

export const MY_APPOINTMENTS_TEXTS = Object.freeze({
  askCpf: 'Para ver suas consultas, preciso confirmar quem é você. Envie seu CPF (só os 11 números).',
  cpfRetry: 'Não consegui confirmar esse CPF. Confira os números e envie de novo, por favor.',
  cpfGiveUp: 'Não consegui confirmar seus dados por aqui.',
  none: 'Não encontrei consultas futuras no seu cadastro.',
  listBody: 'Estas são as suas próximas consultas. Qual você quer alterar?',
  actionBody: 'O que você quer fazer com essa consulta?',
  late: (verb, hours) => `Para ${verb} a consulta, é preciso avisar com pelo menos ${hours} horas de antecedência, e esse prazo já passou. Vou pedir para a equipe te ajudar.`,
  notFound: 'Não encontrei essa consulta (talvez ela já tenha sido alterada). Vou mostrar suas consultas de novo.',
  noDays: 'Não há horários livres para esse serviço nos próximos dias.',
  pickDay: 'Para qual dia você quer remarcar?',
  pickTime: (dateLabel) => `Estes são os horários livres em ${dateLabel}. Qual você prefere?`,
  noTimes: 'Esse dia ficou sem horários livres. Escolha outro dia:',
  slotLost: 'Esse horário acabou de ser ocupado. Escolha outro, por favor:',
  confirmCancel: (label) => `Você quer mesmo cancelar ${label}?`,
  keep: 'Tudo bem, a consulta foi mantida.',
  cancelled: 'Pronto, sua consulta foi cancelada. Quer marcar um novo horário?',
  rescheduled: (label) => `Pronto, sua consulta foi remarcada para ${label}.`,
  useOptions: 'Não entendi. Escolha uma das opções abaixo:',
  reminderConfirmed: (name, label) => `${name ? `Obrigado, ${name}! ` : 'Obrigado! '}Sua presença em ${label} está confirmada.`,
  reminderNoPatient: 'Não encontrei seu cadastro por este número.',
  reminderNoAppointment: 'Não encontrei a consulta desse lembrete (talvez ela já tenha sido alterada).',
  reminderConfirmFailed: 'Não consegui registrar a confirmação agora.',
});

const BACK_BUTTON = Object.freeze({ id: 'menu:main|show', title: 'Voltar ao menu' });

// ---------------------------------------------------------------------------
// Formatação (pt-BR, fuso da clínica)
// ---------------------------------------------------------------------------

function dateKey(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function formatDate(date) {
  const [year, month, day] = dateKey(date).split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' })
    .format(utc).replace('.', '');
  return `${weekday} ${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`;
}

function formatHour(hour) {
  return `${Number(hour)}h`;
}

function todayKey(now, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function startsAtMs(appointment) {
  if (appointment.startsAt) {
    const time = new Date(appointment.startsAt).getTime();
    if (!Number.isNaN(time)) {
      return time;
    }
  }
  // Fallback: Bahia não tem horário de verão (UTC-3).
  const hh = String(Number(appointment.hour)).padStart(2, '0');
  return Date.parse(`${dateKey(appointment.date)}T${hh}:00:00-03:00`);
}

function appointmentLabel(appointment) {
  return `${appointment.serviceName ?? 'sua consulta'} em ${formatDate(appointment.date)} às ${formatHour(appointment.hour)}`;
}

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------

function patientContext(patient, extra = {}) {
  return { patient: { id: patient.id, firstName: patient.firstName }, ...extra };
}

function text(value) {
  return { type: 'text', text: value };
}

function stay({ replies, step, context, cpfAttempts, misunderstood }) {
  const next = { flow: FLOW, step, context };
  if (cpfAttempts !== undefined) {
    next.cpfAttempts = cpfAttempts;
  }
  const out = { replies, next, events: [{ stepKey: `${FLOW}:${step}` }] };
  if (misunderstood) {
    out.misunderstood = true;
  }
  return out;
}

function finish(replies, stepKey) {
  return { replies, next: null, events: [{ stepKey: `${FLOW}:${stepKey}` }] };
}

function handoffResult(stepKey, replies, reason) {
  return { replies, next: null, handoff: { reason }, events: [{ stepKey: `${FLOW}:${stepKey}` }] };
}

function toBooking(patient, stepKey) {
  return {
    replies: [],
    next: { flow: 'booking', step: 'choose_service', context: patientContext(patient) },
    events: [{ stepKey: `${FLOW}:${stepKey}` }],
  };
}

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------

function askCpf(prefix, attempts) {
  return stay({
    replies: [...prefix, text(prefix.length ? MY_APPOINTMENTS_TEXTS.cpfRetry : MY_APPOINTMENTS_TEXTS.askCpf)],
    step: 'ask_cpf',
    context: {},
    cpfAttempts: attempts,
  });
}

async function listStep(ctx, patient, prefix = []) {
  const upcoming = await ctx.repos.appointments.listUpcoming({ patientId: patient.id, now: ctx.now });
  if (!upcoming || upcoming.length === 0) {
    return stay({
      replies: [
        ...prefix,
        {
          type: 'buttons',
          body: MY_APPOINTMENTS_TEXTS.none,
          buttons: [{ id: `${FLOW}:none|book`, title: 'Agendar consulta' }, BACK_BUTTON],
        },
      ],
      step: 'none',
      context: patientContext(patient),
    });
  }
  const rows = upcoming.map((appointment) => ({
    id: `${FLOW}:pick|${appointment.id}`,
    title: `${formatDate(appointment.date)}, ${formatHour(appointment.hour)}`,
    description: [appointment.serviceName, appointment.professionalName].filter(Boolean).join(' - '),
  }));
  const summary = upcoming
    .map((a) => `- ${a.serviceName ?? 'Consulta'}, ${formatDate(a.date)} às ${formatHour(a.hour)}${a.professionalName ? `, com ${a.professionalName}` : ''}`)
    .join('\n');
  return stay({
    replies: [
      ...prefix,
      {
        type: 'list',
        body: `${MY_APPOINTMENTS_TEXTS.listBody}\n\n${summary}`,
        buttonTitle: 'Ver consultas',
        sections: [{ title: 'Consultas', rows }],
      },
    ],
    step: 'pick',
    context: patientContext(patient),
  });
}

async function findAppointment(ctx, patient, appointmentId) {
  if (appointmentId === undefined || appointmentId === null) {
    return null;
  }
  const upcoming = await ctx.repos.appointments.listUpcoming({ patientId: patient.id, now: ctx.now });
  return (upcoming ?? []).find((a) => String(a.id) === String(appointmentId)) ?? null;
}

function actionStep(patient, appointment, prefix = [], misunderstood = false) {
  const professional = appointment.professionalName ? `, com ${appointment.professionalName}` : '';
  return stay({
    replies: [
      ...prefix,
      {
        type: 'buttons',
        body: `${appointmentLabel(appointment)}${professional}.\n\n${MY_APPOINTMENTS_TEXTS.actionBody}`,
        buttons: [
          { id: `${FLOW}:action|reschedule`, title: 'Remarcar' },
          { id: `${FLOW}:action|cancel`, title: 'Cancelar' },
          BACK_BUTTON,
        ],
      },
    ],
    step: 'action',
    context: patientContext(patient, { appointmentId: appointment.id }),
    misunderstood,
  });
}

function minNotice(ctx, action) {
  const value = action === 'cancel' ? ctx.config.cancelMinNoticeHours : ctx.config.rescheduleMinNoticeHours;
  return Number(value ?? 24);
}

function isLate(ctx, appointment, action) {
  return (startsAtMs(appointment) - ctx.now.getTime()) / 3600000 < minNotice(ctx, action);
}

function lateHandoff(ctx, action, stepKey) {
  const verb = action === 'cancel' ? 'cancelar' : 'remarcar';
  return handoffResult(stepKey, [text(MY_APPOINTMENTS_TEXTS.late(verb, minNotice(ctx, action)))], 'late_change');
}

async function dayStep(ctx, patient, appointment, prefix = [], misunderstood = false) {
  const days = await ctx.repos.appointments.listAvailableDays({
    serviceId: appointment.serviceId,
    from: todayKey(ctx.now, ctx.config.timezone ?? DEFAULT_TIMEZONE),
    now: ctx.now,
  });
  if (!days || days.length === 0) {
    return handoffResult('reschedule_day', [...prefix, text(MY_APPOINTMENTS_TEXTS.noDays)], 'patient_request');
  }
  return stay({
    replies: [
      ...prefix,
      {
        type: 'list',
        body: MY_APPOINTMENTS_TEXTS.pickDay,
        buttonTitle: 'Ver dias',
        sections: [{
          title: 'Dias livres',
          rows: days.map((day) => ({
            id: `${FLOW}:day|${dateKey(day.date)}`,
            title: formatDate(day.date),
            description: `${day.freeSlots} ${day.freeSlots === 1 ? 'horário livre' : 'horários livres'}`,
          })),
        }],
      },
    ],
    step: 'reschedule_day',
    context: patientContext(patient, { appointmentId: appointment.id }),
    misunderstood,
  });
}

async function timeStep(ctx, patient, appointment, date, prefix = [], misunderstood = false) {
  const times = await ctx.repos.appointments.listAvailableTimes({
    serviceId: appointment.serviceId,
    date,
    now: ctx.now,
  });
  // Não oferece o horário atual da própria consulta (plan-backlog 3.3.2).
  const free = (times ?? []).filter((slot) => !(
    date === dateKey(appointment.date)
    && Number(slot.hour) === Number(appointment.hour)
    && Number(slot.professionalId) === Number(appointment.professionalId)
  ));
  if (free.length === 0) {
    return dayStep(ctx, patient, appointment, [text(MY_APPOINTMENTS_TEXTS.noTimes)]);
  }
  return stay({
    replies: [
      ...prefix,
      {
        type: 'list',
        body: MY_APPOINTMENTS_TEXTS.pickTime(formatDate(date)),
        buttonTitle: 'Ver horários',
        sections: [{
          title: 'Horários livres',
          rows: free.map((slot) => ({
            id: `${FLOW}:time|${Number(slot.hour)}:${slot.professionalId}`,
            title: formatHour(slot.hour),
            description: slot.professionalName ?? '',
          })),
        }],
      },
    ],
    step: 'reschedule_time',
    context: patientContext(patient, { appointmentId: appointment.id, date }),
    misunderstood,
  });
}

function confirmCancelStep(patient, appointment, prefix = [], misunderstood = false) {
  return stay({
    replies: [
      ...prefix,
      {
        type: 'buttons',
        body: MY_APPOINTMENTS_TEXTS.confirmCancel(appointmentLabel(appointment)),
        buttons: [
          { id: `${FLOW}:confirm|yes`, title: 'Sim, cancelar' },
          { id: `${FLOW}:confirm|no`, title: 'Não, manter' },
        ],
      },
    ],
    step: 'confirm_cancel',
    context: patientContext(patient, { appointmentId: appointment.id }),
    misunderstood,
  });
}

function afterCancelStep(patient, prefix = [], misunderstood = false) {
  return stay({
    replies: [
      ...prefix,
      {
        type: 'buttons',
        body: MY_APPOINTMENTS_TEXTS.cancelled,
        buttons: [{ id: `${FLOW}:after|book`, title: 'Marcar novo horário' }, BACK_BUTTON],
      },
    ],
    step: 'after_cancel',
    context: patientContext(patient),
    misunderstood,
  });
}

async function handleCpf(ctx, input) {
  const attempts = (ctx.state?.cpfAttempts ?? 0) + 1;
  let found = null;
  if (input.kind === 'text') {
    const candidate = findCpfInText(input.text);
    if (candidate && isValidCpf(candidate.digits)) {
      found = await ctx.repos.patients.findPatientByCpf(candidate.digits);
    }
  }
  if (!found) {
    // Inválido e não encontrado recebem exatamente a mesma resposta.
    if (attempts >= Number(ctx.config.cpfMaxAttempts ?? 3)) {
      return handoffResult('ask_cpf', [text(MY_APPOINTMENTS_TEXTS.cpfGiveUp)], 'identity_failure');
    }
    return askCpf([text(MY_APPOINTMENTS_TEXTS.cpfRetry)], attempts);
  }
  const patient = { id: found.id, firstName: found.firstName };
  try {
    await ctx.repos.patients.linkContact({ waId: ctx.waId, patientId: patient.id });
  } catch {
    // Falha ao vincular o contato não impede o atendimento.
  }
  const greeting = patient.firstName ? `Obrigado, ${patient.firstName}!` : 'Obrigado!';
  return listStep(ctx, patient, [text(greeting)]);
}

// ---------------------------------------------------------------------------
// Fluxo
// ---------------------------------------------------------------------------

function reminderWindowHours(ctx) {
  const hours = (Array.isArray(ctx.config.reminderHoursBefore) ? ctx.config.reminderHoursBefore : [24])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return (hours.length ? Math.max(...hours) : 24) + 24;
}

async function reminderAppointment(ctx, patient, appointmentId) {
  const upcoming = await ctx.repos.appointments.listUpcoming({ patientId: patient.id, now: ctx.now });
  if (appointmentId !== null) {
    return (upcoming ?? []).find((a) => String(a.id) === String(appointmentId)) ?? null;
  }
  const limit = ctx.now.getTime() + reminderWindowHours(ctx) * 3600000;
  return [...(upcoming ?? [])]
    .sort((a, b) => startsAtMs(a) - startsAtMs(b))
    .find((a) => startsAtMs(a) <= limit) ?? null;
}

async function handleReminder(ctx, value) {
  const parsed = parseReminderValue(value);
  let patient = ctx.patient;
  if (!patient) {
    const found = await ctx.repos.patients.findPatientByWaId?.(ctx.waId);
    patient = found ? { id: found.id, firstName: found.firstName } : null;
  }
  if (!patient) {
    return askCpf([text(MY_APPOINTMENTS_TEXTS.reminderNoPatient)], 0);
  }
  if (!parsed) {
    return listStep(ctx, patient, [text(MY_APPOINTMENTS_TEXTS.useOptions)]);
  }
  const appointment = await reminderAppointment(ctx, patient, parsed.appointmentId);
  if (!appointment) {
    return listStep(ctx, patient, [text(MY_APPOINTMENTS_TEXTS.reminderNoAppointment)]);
  }

  if (parsed.action === 'confirm') {
    let outcome = { ok: false, reason: 'unavailable' };
    if (typeof ctx.repos.reminders?.confirmAttendance === 'function') {
      outcome = await ctx.repos.reminders.confirmAttendance({
        patientId: patient.id,
        appointmentId: appointment.id,
        now: ctx.now,
      });
    }
    if (outcome.ok) {
      return finish([{
        type: 'buttons',
        body: MY_APPOINTMENTS_TEXTS.reminderConfirmed(patient.firstName, appointmentLabel(appointment)),
        buttons: [BACK_BUTTON],
      }], 'reminder_confirmed');
    }
    if (outcome.reason === 'not_found') {
      return listStep(ctx, patient, [text(MY_APPOINTMENTS_TEXTS.reminderNoAppointment)]);
    }
    return actionStep(patient, appointment, [text(MY_APPOINTMENTS_TEXTS.reminderConfirmFailed)]);
  }

  if (isLate(ctx, appointment, parsed.action)) {
    return lateHandoff(ctx, parsed.action, `reminder_${parsed.action}`);
  }
  return parsed.action === 'cancel'
    ? confirmCancelStep(patient, appointment)
    : dayStep(ctx, patient, appointment);
}

async function start(ctx) {
  return ctx.patient ? listStep(ctx, ctx.patient) : askCpf([], 0);
}

async function handle(ctx, input) {
  if (input?.reply?.flow === FLOW && input.reply.step === REMINDER_STEP) {
    return handleReminder(ctx, input.reply.value);
  }
  if (!ctx.patient) {
    return ctx.state?.step === 'ask_cpf' ? handleCpf(ctx, input) : askCpf([], 0);
  }
  const patient = ctx.patient;
  const own = input.reply?.flow === FLOW ? input.reply : null;
  const step = own ? own.step : ctx.state?.step;
  const value = own ? own.value : null;
  const appointmentId = ctx.state?.context?.appointmentId;
  const options = [text(MY_APPOINTMENTS_TEXTS.useOptions)];

  if (step === 'none') {
    return value === 'book' ? toBooking(patient, 'none') : listStep(ctx, patient);
  }
  if (step === 'after_cancel' || step === 'after') {
    return value === 'book'
      ? toBooking(patient, 'after_cancel')
      : afterCancelStep(patient, options, true);
  }
  if (step === 'pick') {
    if (value === null) {
      return listStep(ctx, patient, options);
    }
    const appointment = await findAppointment(ctx, patient, value);
    return appointment
      ? actionStep(patient, appointment)
      : listStep(ctx, patient, [text(MY_APPOINTMENTS_TEXTS.notFound)]);
  }
  if (!['action', 'reschedule_day', 'day', 'reschedule_time', 'time', 'confirm_cancel', 'confirm'].includes(step)) {
    // ask_cpf com paciente já identificado, ou etapa desconhecida.
    return listStep(ctx, patient);
  }

  const appointment = await findAppointment(ctx, patient, appointmentId);
  if (!appointment) {
    return listStep(ctx, patient, [text(MY_APPOINTMENTS_TEXTS.notFound)]);
  }

  if (step === 'action') {
    if (value !== 'reschedule' && value !== 'cancel') {
      return actionStep(patient, appointment, options, true);
    }
    if (isLate(ctx, appointment, value)) {
      return lateHandoff(ctx, value, 'action');
    }
    return value === 'cancel'
      ? confirmCancelStep(patient, appointment)
      : dayStep(ctx, patient, appointment);
  }

  if (step === 'reschedule_day' || step === 'day') {
    if (own?.step !== 'day' || !DATE_VALUE.test(value ?? '')) {
      return dayStep(ctx, patient, appointment, options, true);
    }
    return timeStep(ctx, patient, appointment, value);
  }

  if (step === 'reschedule_time' || step === 'time') {
    const date = ctx.state?.context?.date;
    const match = own?.step === 'time' ? /^(\d{1,2}):(\d+)$/.exec(value ?? '') : null;
    if (!date) {
      return dayStep(ctx, patient, appointment, options, true);
    }
    if (!match) {
      return timeStep(ctx, patient, appointment, date, options, true);
    }
    const hour = Number(match[1]);
    const professionalId = Number(match[2]);
    if (date === dateKey(appointment.date) && hour === Number(appointment.hour)
      && professionalId === Number(appointment.professionalId)) {
      return timeStep(ctx, patient, appointment, date, options, true);
    }
    // O repositório mantém serviço e forma de pagamento da consulta original.
    const outcome = await ctx.repos.appointments.reschedule({
      patientId: patient.id,
      waId: ctx.waId,
      appointmentId: appointment.id,
      date,
      hour,
      professionalId,
      minNoticeHours: minNotice(ctx, 'reschedule'),
      now: ctx.now,
    });
    if (outcome.ok) {
      const label = `${formatDate(outcome.appointment.date)} às ${formatHour(outcome.appointment.hour)}`;
      return finish([{
        type: 'buttons',
        body: MY_APPOINTMENTS_TEXTS.rescheduled(label),
        buttons: [BACK_BUTTON],
      }], 'rescheduled');
    }
    if (outcome.reason === 'too_late') {
      return lateHandoff(ctx, 'reschedule', 'reschedule_time');
    }
    if (outcome.reason === 'not_found') {
      return listStep(ctx, patient, [text(MY_APPOINTMENTS_TEXTS.notFound)]);
    }
    return timeStep(ctx, patient, appointment, date, [text(MY_APPOINTMENTS_TEXTS.slotLost)]);
  }

  // confirm_cancel
  if (value === 'no') {
    return listStep(ctx, patient, [text(MY_APPOINTMENTS_TEXTS.keep)]);
  }
  if (value !== 'yes') {
    return confirmCancelStep(patient, appointment, options, true);
  }
  const outcome = await ctx.repos.appointments.cancel({
    patientId: patient.id,
    appointmentId: appointment.id,
    minNoticeHours: minNotice(ctx, 'cancel'),
    now: ctx.now,
  });
  if (outcome.ok) {
    return afterCancelStep(patient);
  }
  if (outcome.reason === 'too_late') {
    return lateHandoff(ctx, 'cancel', 'confirm_cancel');
  }
  return listStep(ctx, patient, [text(MY_APPOINTMENTS_TEXTS.notFound)]);
}

export const myAppointmentsFlow = Object.freeze({ name: FLOW, start, handle });
export default myAppointmentsFlow;
