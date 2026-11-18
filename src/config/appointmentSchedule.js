// Grade operacional informada pela clínica. Este catálogo descreve horários
// oferecidos; a disponibilidade real depende de consultar agendamentos ativos
// no banco e validar a capacidade dentro da transação de confirmação.
const CLINIC_TIME_ZONE = 'America/Bahia';

const appointmentServices = Object.freeze({
  fisioterapia: Object.freeze({
    name: 'Fisioterapia',
    durationMinutes: 30,
    capacityPerSlot: 6,
    professionals: Object.freeze(['moises', 'antonio']),
    windows: Object.freeze([['07:30', '12:00'], ['14:00', '18:30']]),
  }),
  rpg: Object.freeze({
    name: 'RPG',
    durationMinutes: 30,
    capacityPerSlot: 1,
    professionals: Object.freeze(['luarca']),
    windows: Object.freeze([['07:30', '12:00'], ['14:00', '18:30']]),
  }),
  pilates: Object.freeze({
    name: 'Pilates',
    durationMinutes: 60,
    capacityPerSlot: 1,
    professionals: Object.freeze(['luarca']),
    windows: Object.freeze([['07:00', '12:00'], ['14:00', '17:00']]),
  }),
  uro: Object.freeze({
    name: 'URO',
    durationMinutes: 30,
    capacityPerSlot: 1,
    professionals: Object.freeze(['camila']),
    windows: Object.freeze([['07:30', '12:00'], ['14:00', '18:30']]),
  }),
});

const professionals = Object.freeze({
  moises: 'Moisés',
  antonio: 'Antônio',
  luarca: 'Luarca',
  camila: 'Camila',
});

function toMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function toTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function isWeekday(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false;
  const dayOfWeek = parsed.getUTCDay();
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

function listAppointmentSlots({ date, serviceCode, professionalCode = null } = {}) {
  const service = appointmentServices[serviceCode];
  if (!service || !isWeekday(date)) return [];
  if (professionalCode !== null && !service.professionals.includes(professionalCode)) return [];

  return service.windows.flatMap(([windowStart, windowEnd]) => {
    const startBoundary = toMinutes(windowStart);
    const endBoundary = toMinutes(windowEnd);
    const slots = [];
    for (let start = startBoundary; start + service.durationMinutes <= endBoundary; start += service.durationMinutes) {
      slots.push({
        date,
        serviceCode,
        serviceName: service.name,
        professionalCode,
        professionalName: professionalCode === null ? null : professionals[professionalCode],
        startsAtLocal: toTime(start),
        endsAtLocal: toTime(start + service.durationMinutes),
        durationMinutes: service.durationMinutes,
        capacityPerSlot: service.capacityPerSlot,
        timeZone: CLINIC_TIME_ZONE,
      });
    }
    return slots;
  });
}

export {
  CLINIC_TIME_ZONE,
  appointmentServices,
  listAppointmentSlots,
  professionals,
};
