import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppointmentCommandBoundary } from '../src/services/appointmentCommandBoundary.js';
import { createAppointmentService, parseClinicAppointmentCommand, parseClinicConfirmation, parsePatientAppointmentRequest } from '../src/services/appointmentService.js';

test('strict confirmation parser accepts only the anchored configured shared-account sentence', () => {
  assert.deepEqual(
    parseClinicConfirmation('Consulta confirmada para 2026-12-01, das 14:00 às 14:50 (UTC-03:00).', '-03:00'),
    { startsAt: '2026-12-01T17:00:00.000Z', endsAt: '2026-12-01T17:50:00.000Z' },
  );
  assert.equal(parseClinicConfirmation('Consulta confirmada para amanhã.', '-03:00'), null);
  assert.equal(parseClinicConfirmation('Consulta confirmada para 2026-02-30, das 14:00 às 14:50 (UTC-03:00).', '-03:00'), null);
  assert.equal(parseClinicConfirmation('Consulta confirmada para 2026-12-01, das 24:00 às 14:50 (UTC-03:00).', '-03:00'), null);
  assert.equal(parseClinicConfirmation('Consulta confirmada para 2026-12-01, das 14:50 às 14:00 (UTC-03:00).', '-03:00'), null);
  assert.equal(parseClinicAppointmentCommand('Consulta confirmada para 2026-12-01, das 14:00 às 14:50 (UTC+14:01).', '+14:01'), null);
  assert.deepEqual(parseClinicAppointmentCommand('Consulta cancelada para 2026-12-01, das 14:00 às 14:50 (UTC-03:00).', '-03:00'), {
    action: 'cancel', startsAt: '2026-12-01T17:00:00.000Z', endsAt: '2026-12-01T17:50:00.000Z',
  });
  assert.deepEqual(parseClinicAppointmentCommand('Consulta remarcada: a consulta de 2026-12-01, das 14:00 às 14:50 foi transferida para 2026-12-02, das 15:00 às 15:50 (UTC-03:00).', '-03:00'), {
    action: 'reschedule', startsAt: '2026-12-01T17:00:00.000Z', endsAt: '2026-12-01T17:50:00.000Z',
    resultingStartsAt: '2026-12-02T18:00:00.000Z', resultingEndsAt: '2026-12-02T18:50:00.000Z',
  });
  assert.equal(parseClinicAppointmentCommand('Comparecimento confirmado para 2026-12-01, das 14:00 às 14:50 (UTC-03:00). extra', '-03:00'), null);
});

test('patient appointment request parser accepts only an eligible service, professional and published slot', () => {
  assert.deepEqual(
    parsePatientAppointmentRequest('AGENDAR | fisioterapia | Moisés | 2026-12-01 | 07:30', '-03:00'),
    { serviceCode: 'fisioterapia', professionalCode: 'moises', startsAt: '2026-12-01T10:30:00.000Z', endsAt: '2026-12-01T11:00:00.000Z' },
  );
  assert.equal(parsePatientAppointmentRequest('AGENDAR | PILATES | CAMILA | 2026-12-01 | 07:00', '-03:00'), null);
  assert.equal(parsePatientAppointmentRequest('AGENDAR | RPG | LUARCA | 2026-12-01 | 12:30', '-03:00'), null);
  assert.equal(parsePatientAppointmentRequest('AGENDAR | URO | CAMILA | 2026-12-05 | 10:00', '-03:00'), null);
  assert.equal(parsePatientAppointmentRequest('quero agendar fisioterapia amanhã', '-03:00'), null);
});

test('exact clinic WhatsApp commands call cancellation, rescheduling, and attendance transitions', async () => {
  const calls = [];
  const database = {
    createAppointmentRequest: async () => null,
    confirmSinglePendingAppointmentRequest: async () => null,
    cancelConfirmedAppointment: async (input) => { calls.push(['cancel', input]); return { status: 'cancelled' }; },
    rescheduleConfirmedAppointment: async (input) => { calls.push(['reschedule', input]); return { status: 'confirmed' }; },
    recordAppointmentAttendance: async (input) => { calls.push(['attendance', input]); return { attendance_status: 'attended' }; },
  };
  const boundary = createAppointmentCommandBoundary({ clinicWhatsappSender: 'clinic', confirmationUtcOffset: '-03:00' });
  const service = createAppointmentService({ database, commandBoundary: boundary });
  const principal = boundary.createVerifiedWebhookPrincipal({ webhookAuthenticated: true });
  const commands = [
    ['Consulta cancelada para 2026-12-01, das 14:00 às 14:50 (UTC-03:00).', 'appointment_cancelled'],
    ['Consulta remarcada: a consulta de 2026-12-01, das 14:00 às 14:50 foi transferida para 2026-12-02, das 15:00 às 15:50 (UTC-03:00).', 'appointment_rescheduled'],
    ['Comparecimento confirmado para 2026-12-01, das 14:00 às 14:50 (UTC-03:00).', 'attended'],
  ];

  for (const [body, expectedAction] of commands) {
    const result = await service.handleVerifiedWebhookMessage({
      principal,
      persistedMessage: { id: `message-${calls.length}` },
      message: { direction: 'out', sentVia: 'business_app', sourceSender: 'clinic', messageType: 'text', waId: 'patient', body },
    });
    assert.equal(result.action, expectedAction);
  }
  assert.deepEqual(calls.map(([name]) => name), ['cancel', 'reschedule', 'attendance']);
  assert.equal(Object.hasOwn(calls[2][1], 'attendanceStatus'), false);
});

test('appointment service writes only an authenticated structured patient request or strict shared-sender confirmation', async () => {
  const calls = [];
  const database = {
    createAppointmentRequest: async (input) => { calls.push(['request', input]); return { id: 'request-id' }; },
    confirmSinglePendingAppointmentRequest: async (input) => { calls.push(['confirm', input]); return { id: 'appointment-id' }; },
  };
  const boundary = createAppointmentCommandBoundary({ clinicWhatsappSender: 'clinic', confirmationUtcOffset: '-03:00' });
  const service = createAppointmentService({ database, commandBoundary: boundary });
  const principal = boundary.createVerifiedWebhookPrincipal({ webhookAuthenticated: true });

  const requestResult = await service.handleVerifiedWebhookMessage({
    principal,
    persistedMessage: { id: 'patient-message' },
    message: { direction: 'in', messageType: 'text', body: 'AGENDAR | FISIOTERAPIA | MOISES | 2026-12-01 | 07:30', waId: 'patient', createdAt: '2026-12-01T10:00:00Z' },
  });
  assert.equal(requestResult.action, 'request_created');
  assert.equal(calls[0][1].serviceCode, 'fisioterapia');
  assert.equal(calls[0][1].professionalCode, 'moises');
  assert.equal(calls[0][1].startsAt, '2026-12-01T10:30:00.000Z');

  const confirmationResult = await service.handleVerifiedWebhookMessage({
    principal,
    persistedMessage: { id: 'clinic-message' },
    message: { direction: 'out', sentVia: 'business_app', sourceSender: 'clinic', messageType: 'text', waId: 'patient', createdAt: '2026-12-01T11:00:00Z', body: 'Consulta confirmada para 2026-12-01, das 14:00 às 14:50 (UTC-03:00).' },
  });
  assert.equal(confirmationResult.action, 'appointment_confirmed');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].startsAt, '2026-12-01T17:00:00.000Z');

  const ignored = await service.handleVerifiedWebhookMessage({
    principal,
    persistedMessage: { id: 'free-text' },
    message: { direction: 'out', sentVia: 'business_app', sourceSender: 'clinic', messageType: 'text', waId: 'patient', body: 'Marca para amanhã' },
  });
  assert.deepEqual(ignored, { action: 'ignored', reason: 'not_exact_clinic_command' });
  assert.equal(calls.length, 2);
});
