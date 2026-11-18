import { listAppointmentSlots } from '../config/appointmentSchedule.js';

const APPOINTMENT_REQUEST_REPLY_ID = 'menu_agendar';
const DATE_TIME = '(\\d{4}-\\d{2}-\\d{2}), das (\\d{2}:\\d{2}) às (\\d{2}:\\d{2})';

function isValidUtcOffset(offset) {
  if (typeof offset !== 'string' || !/^[-+]\d{2}:\d{2}$/.test(offset)) return false;
  const [, hoursText, minutesText] = offset.match(/^[-+](\d{2}):(\d{2})$/);
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  return hours <= 14 && minutes <= 59 && (hours < 14 || minutes === 0);
}

function parseSlot(date, start, end, offset) {
  const [year, month, day] = date.split('-').map(Number);
  const times = [start, end].map((time) => time.split(':').map(Number));
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > 31 ||
    times.some(([hour, minute]) => hour > 23 || minute > 59)
  ) return null;

  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) return null;

  const startsAt = new Date(`${date}T${start}:00${offset}`);
  const endsAt = new Date(`${date}T${end}:00${offset}`);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) return null;
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exact full-string clinic account commands. No free-text or intent parsing.
function parseClinicAppointmentCommand(body, confirmationUtcOffset) {
  if (typeof body !== 'string' || !isValidUtcOffset(confirmationUtcOffset)) return null;
  const slotPattern = DATE_TIME;
  const offset = escapeRegExp(confirmationUtcOffset);
  const singleSlot = (prefix) => new RegExp(`^${prefix}${slotPattern} \\(UTC${offset}\\)\\.$`).exec(body);

  let match = singleSlot('Consulta confirmada para ');
  if (match) {
    const slot = parseSlot(match[1], match[2], match[3], confirmationUtcOffset);
    return slot === null ? null : { action: 'confirm', ...slot };
  }

  match = singleSlot('Consulta cancelada para ');
  if (match) {
    const slot = parseSlot(match[1], match[2], match[3], confirmationUtcOffset);
    return slot === null ? null : { action: 'cancel', ...slot };
  }

  match = new RegExp(`^Consulta remarcada: a consulta de ${slotPattern} foi transferida para ${slotPattern} \\(UTC${offset}\\)\\.$`).exec(body);
  if (match) {
    const previous = parseSlot(match[1], match[2], match[3], confirmationUtcOffset);
    const resulting = parseSlot(match[4], match[5], match[6], confirmationUtcOffset);
    return previous === null || resulting === null
      ? null
      : { action: 'reschedule', ...previous, resultingStartsAt: resulting.startsAt, resultingEndsAt: resulting.endsAt };
  }

  match = singleSlot('Comparecimento confirmado para ');
  if (match) {
    const slot = parseSlot(match[1], match[2], match[3], confirmationUtcOffset);
    return slot === null ? null : { action: 'attend', ...slot };
  }

  return null;
}

function parseClinicConfirmation(body, confirmationUtcOffset) {
  const command = parseClinicAppointmentCommand(body, confirmationUtcOffset);
  return command?.action === 'confirm'
    ? { startsAt: command.startsAt, endsAt: command.endsAt }
    : null;
}

function parsePatientAppointmentRequest(body, confirmationUtcOffset) {
  if (typeof body !== 'string') return null;
  const normalized = body.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase();
  const match = /^AGENDAR\s*\|\s*(FISIOTERAPIA|RPG|PILATES|URO)\s*\|\s*(MOISES|ANTONIO|LUARCA|CAMILA)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{2}:\d{2})$/.exec(normalized);
  if (!match || !isValidUtcOffset(confirmationUtcOffset)) return null;

  const serviceCode = match[1].toLowerCase();
  const professionalCode = match[2].toLowerCase();
  const date = match[3];
  const startsAtLocal = match[4];
  const slot = listAppointmentSlots({ date, serviceCode, professionalCode })
    .find((candidate) => candidate.startsAtLocal === startsAtLocal);
  if (slot === undefined) return null;

  const instant = parseSlot(date, slot.startsAtLocal, slot.endsAtLocal, confirmationUtcOffset);
  if (instant === null || new Date(instant.startsAt).getTime() <= Date.now()) return null;
  return { serviceCode, professionalCode, ...instant };
}

function createAppointmentService({ database, commandBoundary } = {}) {
  if (database === undefined || commandBoundary === undefined) {
    throw new TypeError('database and commandBoundary are required.');
  }

  async function handleVerifiedWebhookMessage({ principal, message, persistedMessage }) {
    const trustedPrincipal = commandBoundary.requireTrustedWebhookPrincipal(principal);
    if (persistedMessage === null || persistedMessage === undefined) {
      return { action: 'ignored', reason: 'duplicate_message' };
    }

    if (message.direction === 'in' && message.messageType === 'text') {
      const request = parsePatientAppointmentRequest(message.body, trustedPrincipal.confirmationUtcOffset);
      if (request === null) return { action: 'ignored', reason: 'not_structured_appointment_request' };
      const result = await database.createAppointmentRequest({
        contactWaId: message.waId,
        sourceMessageId: persistedMessage.id,
        serviceCode: request.serviceCode,
        professionalCode: request.professionalCode,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        occurredAt: message.createdAt,
      });
      return result?.unavailable === true
        ? { action: 'slot_unavailable', request }
        : { action: 'request_created', request: result };
    }

    if (message.direction === 'in' && message.messageType === 'interactive_list_reply' && message.replyId === APPOINTMENT_REQUEST_REPLY_ID) {
      return { action: 'request_instructions' };
    }

    if (
      message.direction !== 'out' ||
      message.sentVia !== 'business_app' ||
      message.messageType !== 'text' ||
      message.sourceSender !== trustedPrincipal.clinicWhatsappSender
    ) return { action: 'ignored', reason: 'unsupported_message' };

    const command = parseClinicAppointmentCommand(message.body, trustedPrincipal.confirmationUtcOffset);
    if (command === null) return { action: 'ignored', reason: 'not_exact_clinic_command' };

    const common = {
      contactWaId: message.waId,
      sourceMessageId: persistedMessage.id,
      occurredAt: message.createdAt,
    };
    let result;
    switch (command.action) {
      case 'confirm':
        result = await database.confirmSinglePendingAppointmentRequest({ ...common, startsAt: command.startsAt, endsAt: command.endsAt });
        break;
      case 'cancel':
        result = await database.cancelConfirmedAppointment({ ...common, startsAt: command.startsAt, endsAt: command.endsAt });
        break;
      case 'reschedule':
        result = await database.rescheduleConfirmedAppointment({
          ...common,
          previousStartsAt: command.startsAt,
          previousEndsAt: command.endsAt,
          resultingStartsAt: command.resultingStartsAt,
          resultingEndsAt: command.resultingEndsAt,
        });
        break;
      case 'attend':
        result = await database.recordAppointmentAttendance({ ...common, startsAt: command.startsAt, endsAt: command.endsAt });
        break;
      default:
        return { action: 'ignored', reason: 'unsupported_command' };
    }
    if (result === null) return { action: 'ignored', reason: 'no_unique_matching_appointment' };
    const actionNames = {
      confirm: 'appointment_confirmed',
      cancel: 'appointment_cancelled',
      reschedule: 'appointment_rescheduled',
      attend: 'attended',
    };
    return { action: actionNames[command.action], appointment: result };
  }

  return { handleVerifiedWebhookMessage };
}

export {
  APPOINTMENT_REQUEST_REPLY_ID,
  createAppointmentService,
  parseClinicAppointmentCommand,
  parseClinicConfirmation,
  parsePatientAppointmentRequest,
};
