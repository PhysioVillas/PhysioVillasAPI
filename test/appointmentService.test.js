import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppointmentCommandBoundary } from '../src/services/appointmentCommandBoundary.js';
import { createAppointmentService, parseClinicAppointmentCommand, parseClinicConfirmation } from '../src/services/appointmentService.js';
import { createFaqBot } from '../src/services/faqBot.js';
import { buildInteractiveListMessage } from '../src/services/infobipMessagesClient.js';

test('booking clicks use the database catalog and availability, and save only a pending request', async () => {
  const catalog = { serviceCode: 'novo_servico', serviceName: 'Novo serviço', professionalCode: 'nova_profissional', professionalName: 'Nova profissional' };
  const requestWrites = [];
  const schedule = {
    date: '2026-12-01', time: '14:00',
    startsAt: new Date('2026-12-01T17:00:00Z'), endsAt: new Date('2026-12-01T17:30:00Z'),
  };
  let offerSlots = true;
  let rendered;
  let textSent;
  const database = {
    listAppointmentProfessionals: async () => [catalog],
    listAvailableAppointmentSlots: async ({ serviceCode, professionalCode, date }) => {
      assert.equal(serviceCode, catalog.serviceCode);
      assert.equal(professionalCode, catalog.professionalCode);
      assert.ok(date === undefined || date === schedule.date);
      return offerSlots ? [schedule] : [];
    },
    createAppointmentRequest: async (input) => {
      requestWrites.push(input);
      return { status: 'requested' };
    },
    persistOutboundMessage: async () => {},
  };
  const commandBoundary = createAppointmentCommandBoundary({ clinicWhatsappSender: 'clinic', confirmationUtcOffset: '-03:00' });
  const principal = commandBoundary.createVerifiedWebhookPrincipal({ webhookAuthenticated: true });
  const appointments = createAppointmentService({ database, commandBoundary });
  const bot = createFaqBot({
    database,
    sender: '5511000000000',
    client: {
      sendWhatsAppInteractiveList: async (payload) => {
        rendered = buildInteractiveListMessage(payload);
        return { messageId: 'sent-list' };
      },
      sendWhatsAppText: async ({ text }) => {
        textSent = text;
        return { messageId: 'sent-text' };
      },
    },
  });
  async function click(replyId) {
    const message = { direction: 'in', waId: '5511999999999', messageType: 'interactive_list_reply', replyId };
    const appointmentResult = await appointments.handleVerifiedWebhookMessage({
      principal, message, persistedMessage: { id: 'last-click' },
    });
    await bot.handleInbound({ ...message, appointmentResult });
    return appointmentResult;
  }
  const first = () => rendered.content.action.sections[0].rows[0];
  await click('menu_agendar');
  assert.equal(first().title, catalog.serviceName);
  await click(first().id);
  assert.equal(first().title, catalog.professionalName);
  await click(first().id);
  await click(first().id);
  assert.equal(first().title, schedule.time);
  const slotReplyId = first().id;
  assert.equal(requestWrites.length, 0);
  assert.equal((await click(slotReplyId)).action, 'request_created');
  assert.equal(requestWrites[0].professionalCode, catalog.professionalCode);
  assert.equal(requestWrites[0].startsAt, schedule.startsAt);
  assert.match(textSent, /equipe ainda precisa confirmar/);

  offerSlots = false;
  assert.equal((await click(slotReplyId)).action, 'slot_unavailable');
  assert.equal(first().id, 'menu_agendar');
  assert.equal(requestWrites.length, 1);
});

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
    listAvailableAppointmentSlots: async ({ serviceCode, professionalCode, date }) => {
      assert.deepEqual({ serviceCode, professionalCode, date }, {
        serviceCode: 'fisioterapia', professionalCode: 'moises', date: '2026-12-01',
      });
      return [{ time: '07:30', startsAt: '2026-12-01T10:30:00.000Z', endsAt: '2026-12-01T11:00:00.000Z' }];
    },
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
