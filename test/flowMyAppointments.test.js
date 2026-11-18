import assert from 'node:assert/strict';
import test from 'node:test';
import { myAppointmentsFlow, MY_APPOINTMENTS_TEXTS } from '../src/services/bot/flows/myAppointments.js';
import { parseReplyId } from '../src/services/bot/engine.js';

const WA_ID = '5571999990000';
const VALID_CPF = '529.982.247-25';
const VALID_DIGITS = '52998224725';
// Quarta-feira, 18/11/2026, 10:00 em America/Bahia.
const NOW = new Date('2026-11-18T13:00:00Z');
const CONFIG = Object.freeze({
  timezone: 'America/Bahia',
  rescheduleMinNoticeHours: 24,
  cancelMinNoticeHours: 24,
  cpfMaxAttempts: 3,
});
const PATIENT = { id: 7, firstName: 'Ana' };

function appointmentAt(hoursAhead, overrides = {}) {
  const startsAt = new Date(NOW.getTime() + hoursAhead * 3600000);
  const local = new Date(startsAt.getTime() - 3 * 3600000);
  return {
    id: 101,
    patientId: 7,
    serviceId: 2,
    serviceName: 'Fisioterapia',
    professionalId: 5,
    professionalName: 'Dra. Lia',
    date: local.toISOString().slice(0, 10),
    hour: local.getUTCHours(),
    startsAt,
    status: 'Agendado',
    paymentMethod: 'Particular avulso',
    ...overrides,
  };
}

function createRepos({ upcoming = [], patient = PATIENT, rescheduleResult, cancelResult, days, times } = {}) {
  const calls = { reschedule: [], cancel: [], link: [], cpfLookups: [], listUpcoming: 0 };
  return {
    calls,
    appointments: {
      async listUpcoming() {
        calls.listUpcoming += 1;
        return upcoming;
      },
      async listAvailableDays() {
        return days ?? [{ date: '2026-11-25', freeSlots: 2 }, { date: '2026-11-26', freeSlots: 1 }];
      },
      async listAvailableTimes({ date }) {
        return times ?? [
          { hour: 9, professionalId: 5, professionalName: 'Dra. Lia', remaining: 1 },
          { hour: 10, professionalId: 5, professionalName: 'Dra. Lia', remaining: 2, date },
        ];
      },
      async reschedule(args) {
        calls.reschedule.push(args);
        return rescheduleResult ?? {
          ok: true,
          appointment: { ...appointmentAt(30), date: args.date, hour: args.hour },
        };
      },
      async cancel(args) {
        calls.cancel.push(args);
        return cancelResult ?? { ok: true, appointment: { id: args.appointmentId } };
      },
    },
    patients: {
      async findPatientByCpf(cpf) {
        calls.cpfLookups.push(cpf);
        return cpf === VALID_DIGITS ? patient : null;
      },
      async linkContact(args) {
        calls.link.push(args);
        return {};
      },
    },
  };
}

function makeCtx(repos, { state = null, patient = null, config = CONFIG } = {}) {
  return { waId: WA_ID, now: NOW, config, state, patient, inBusinessHours: true, repos };
}

function textInput(text) {
  return { kind: 'text', text, replyId: null, intent: null, reply: null };
}

function replyInput(replyId, kind = 'list_reply') {
  return { kind, text: 'x', replyId, intent: null, reply: parseReplyId(replyId) };
}

function state(step, context = {}, cpfAttempts = 0) {
  return { flow: 'my_appointments', step, context, cpfAttempts };
}

function allText(result) {
  return JSON.stringify(result.replies);
}

test('flow exposes its name, start and handle', () => {
  assert.equal(myAppointmentsFlow.name, 'my_appointments');
  assert.equal(typeof myAppointmentsFlow.start, 'function');
  assert.equal(typeof myAppointmentsFlow.handle, 'function');
});

test('start asks for the CPF when the patient is unknown', async () => {
  const result = await myAppointmentsFlow.start(makeCtx(createRepos()));
  assert.equal(result.next.step, 'ask_cpf');
  assert.equal(result.next.cpfAttempts, 0);
  assert.deepEqual(result.events, [{ stepKey: 'my_appointments:ask_cpf' }]);
  assert.equal(result.replies[0].text, MY_APPOINTMENTS_TEXTS.askCpf);
});

test('already identified patient skips the CPF step', async () => {
  const repos = createRepos({ upcoming: [appointmentAt(48)] });
  const result = await myAppointmentsFlow.start(makeCtx(repos, { patient: PATIENT }));
  assert.equal(result.next.step, 'pick');
  assert.deepEqual(result.next.context.patient, PATIENT);
  assert.equal(repos.calls.cpfLookups.length, 0);
  assert.equal(result.replies[0].type, 'list');
});

test('valid CPF inside free text identifies, links the contact and lists appointments', async () => {
  const repos = createRepos({ upcoming: [appointmentAt(48)] });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { state: state('ask_cpf') }),
    textInput(`meu cpf é ${VALID_CPF}, obrigada`),
  );
  assert.deepEqual(repos.calls.cpfLookups, [VALID_DIGITS]);
  assert.deepEqual(repos.calls.link, [{ waId: WA_ID, patientId: 7 }]);
  assert.equal(result.next.step, 'pick');
  assert.deepEqual(result.next.context.patient, { id: 7, firstName: 'Ana' });
  assert.ok(!('patientId' in result.next.context));
  const list = result.replies.find((reply) => reply.type === 'list');
  assert.match(list.sections[0].rows[0].id, /^my_appointments:pick\|101$/);
  assert.match(list.sections[0].rows[0].description, /Fisioterapia/);
  assert.match(list.sections[0].rows[0].description, /Dra\. Lia/);
  // CPF nunca aparece em respostas, contexto ou eventos.
  const dump = JSON.stringify(result);
  assert.ok(!dump.includes(VALID_DIGITS));
  assert.ok(!dump.includes(VALID_CPF));
});

test('linkContact failure is tolerated', async () => {
  const repos = createRepos({ upcoming: [appointmentAt(48)] });
  repos.patients.linkContact = async () => {
    throw new Error('db down');
  };
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { state: state('ask_cpf') }),
    textInput(VALID_DIGITS),
  );
  assert.equal(result.next.step, 'pick');
});

test('invalid and not-found CPF get the same reply and increment attempts', async () => {
  const repos = createRepos();
  const invalid = await myAppointmentsFlow.handle(
    makeCtx(repos, { state: state('ask_cpf', {}, 0) }),
    textInput('111.111.111-11'),
  );
  const notFound = await myAppointmentsFlow.handle(
    makeCtx(repos, { state: state('ask_cpf', {}, 0) }),
    textInput('390.533.447-05'),
  );
  assert.deepEqual(invalid, notFound);
  assert.equal(invalid.next.step, 'ask_cpf');
  assert.equal(invalid.next.cpfAttempts, 1);
  assert.equal(invalid.handoff, undefined);
  assert.ok(!allText(invalid).includes('111'));
  // Só o CPF válido foi consultado no repositório.
  assert.deepEqual(repos.calls.cpfLookups, ['39053344705']);

  const second = await myAppointmentsFlow.handle(
    makeCtx(repos, { state: state('ask_cpf', {}, 1) }),
    textInput('sem número'),
  );
  assert.equal(second.next.cpfAttempts, 2);
});

test('reaching cpfMaxAttempts opens an identity_failure handoff', async () => {
  const result = await myAppointmentsFlow.handle(
    makeCtx(createRepos(), { state: state('ask_cpf', {}, 2) }),
    textInput('111.111.111-11'),
  );
  assert.deepEqual(result.handoff, { reason: 'identity_failure' });
  assert.equal(result.next, null);
});

test('no upcoming appointments offers booking or the menu', async () => {
  const repos = createRepos({ upcoming: [] });
  const result = await myAppointmentsFlow.start(makeCtx(repos, { patient: PATIENT }));
  assert.equal(result.next.step, 'none');
  const buttons = result.replies[0].buttons;
  assert.deepEqual(buttons.map((button) => button.id), ['my_appointments:none|book', 'menu:main|show']);

  const book = await myAppointmentsFlow.handle(
    makeCtx(repos, { patient: PATIENT, state: state('none', { patient: PATIENT }) }),
    replyInput('my_appointments:none|book', 'button_reply'),
  );
  assert.equal(book.next.flow, 'booking');
  assert.equal(book.next.step, 'choose_service');
});

test('picking an appointment shows the three action buttons', async () => {
  const repos = createRepos({ upcoming: [appointmentAt(48)] });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { patient: PATIENT, state: state('pick', { patient: PATIENT }) }),
    replyInput('my_appointments:pick|101'),
  );
  assert.equal(result.next.step, 'action');
  assert.equal(result.next.context.appointmentId, 101);
  assert.deepEqual(
    result.replies[0].buttons.map((button) => button.title),
    ['Remarcar', 'Cancelar', 'Voltar ao menu'],
  );
});

function actionState() {
  return state('action', { patient: PATIENT, appointmentId: 101 });
}

test('23 h before: reschedule and cancel end in a late_change handoff', async () => {
  for (const action of ['reschedule', 'cancel']) {
    const repos = createRepos({ upcoming: [appointmentAt(23)] });
    const result = await myAppointmentsFlow.handle(
      makeCtx(repos, { patient: PATIENT, state: actionState() }),
      replyInput(`my_appointments:action|${action}`, 'button_reply'),
    );
    assert.deepEqual(result.handoff, { reason: 'late_change' });
    assert.equal(result.next, null);
    assert.equal(repos.calls.reschedule.length + repos.calls.cancel.length, 0);
  }
});

test('25 h before: reschedule lists days and cancel asks for confirmation', async () => {
  const repos = createRepos({ upcoming: [appointmentAt(25)] });
  const reschedule = await myAppointmentsFlow.handle(
    makeCtx(repos, { patient: PATIENT, state: actionState() }),
    replyInput('my_appointments:action|reschedule', 'button_reply'),
  );
  assert.equal(reschedule.handoff, undefined);
  assert.equal(reschedule.next.step, 'reschedule_day');
  const cancel = await myAppointmentsFlow.handle(
    makeCtx(repos, { patient: PATIENT, state: actionState() }),
    replyInput('my_appointments:action|cancel', 'button_reply'),
  );
  assert.equal(cancel.next.step, 'confirm_cancel');
  assert.deepEqual(cancel.replies[0].buttons.map((b) => b.id), [
    'my_appointments:confirm|yes',
    'my_appointments:confirm|no',
  ]);
});

test('repository too_late maps to the same handoff', async () => {
  const repos = createRepos({
    upcoming: [appointmentAt(30)],
    rescheduleResult: { ok: false, reason: 'too_late' },
    cancelResult: { ok: false, reason: 'too_late' },
  });
  const reschedule = await myAppointmentsFlow.handle(
    makeCtx(repos, {
      patient: PATIENT,
      state: state('reschedule_time', { patient: PATIENT, appointmentId: 101, date: '2026-11-25' }),
    }),
    replyInput('my_appointments:time|9:5'),
  );
  assert.deepEqual(reschedule.handoff, { reason: 'late_change' });
  const cancel = await myAppointmentsFlow.handle(
    makeCtx(repos, {
      patient: PATIENT,
      state: state('confirm_cancel', { patient: PATIENT, appointmentId: 101 }),
    }),
    replyInput('my_appointments:confirm|yes', 'button_reply'),
  );
  assert.deepEqual(cancel.handoff, { reason: 'late_change' });
});

test('reschedule day then time succeeds, hides the current slot and calls the repository', async () => {
  const appointment = appointmentAt(48, { date: '2026-11-25', hour: 10, professionalId: 5 });
  const repos = createRepos({ upcoming: [appointment] });
  const dayState = state('reschedule_day', { patient: PATIENT, appointmentId: 101 });
  const times = await myAppointmentsFlow.handle(
    makeCtx(repos, { patient: PATIENT, state: dayState }),
    replyInput('my_appointments:day|2026-11-25'),
  );
  assert.equal(times.next.step, 'reschedule_time');
  assert.equal(times.next.context.date, '2026-11-25');
  const ids = times.replies.at(-1).sections[0].rows.map((row) => row.id);
  assert.deepEqual(ids, ['my_appointments:time|9:5']); // 10h/prof 5 é o horário atual

  const done = await myAppointmentsFlow.handle(
    makeCtx(repos, { patient: PATIENT, state: state('reschedule_time', times.next.context) }),
    replyInput('my_appointments:time|9:5'),
  );
  assert.equal(done.next, null);
  assert.deepEqual(repos.calls.reschedule[0], {
    patientId: 7,
    waId: WA_ID,
    appointmentId: 101,
    date: '2026-11-25',
    hour: 9,
    professionalId: 5,
    minNoticeHours: 24,
    now: NOW,
  });
  assert.match(done.replies[0].body, /remarcada/);
  assert.deepEqual(done.events, [{ stepKey: 'my_appointments:rescheduled' }]);
});

test('lost slot re-lists the times with an explanation', async () => {
  const repos = createRepos({
    upcoming: [appointmentAt(48)],
    rescheduleResult: { ok: false, reason: 'slot_unavailable' },
  });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, {
      patient: PATIENT,
      state: state('reschedule_time', { patient: PATIENT, appointmentId: 101, date: '2026-11-26' }),
    }),
    replyInput('my_appointments:time|9:5'),
  );
  assert.equal(result.next.step, 'reschedule_time');
  assert.equal(result.replies[0].text, MY_APPOINTMENTS_TEXTS.slotLost);
  assert.equal(result.replies.at(-1).type, 'list');
});

test('reschedule not_found goes back to the appointment list', async () => {
  const repos = createRepos({
    upcoming: [appointmentAt(48)],
    rescheduleResult: { ok: false, reason: 'not_found' },
  });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, {
      patient: PATIENT,
      state: state('reschedule_time', { patient: PATIENT, appointmentId: 101, date: '2026-11-26' }),
    }),
    replyInput('my_appointments:time|9:5'),
  );
  assert.equal(result.next.step, 'pick');
  assert.equal(result.replies[0].text, MY_APPOINTMENTS_TEXTS.notFound);
});

test('cancel needs confirmation, then succeeds and offers a new booking', async () => {
  const repos = createRepos({ upcoming: [appointmentAt(48)] });
  const ctx = () => makeCtx(repos, {
    patient: PATIENT,
    state: state('confirm_cancel', { patient: PATIENT, appointmentId: 101 }),
  });
  const kept = await myAppointmentsFlow.handle(ctx(), replyInput('my_appointments:confirm|no', 'button_reply'));
  assert.equal(repos.calls.cancel.length, 0);
  assert.equal(kept.next.step, 'pick');

  const done = await myAppointmentsFlow.handle(ctx(), replyInput('my_appointments:confirm|yes', 'button_reply'));
  assert.equal(repos.calls.cancel.length, 1);
  assert.equal(repos.calls.cancel[0].minNoticeHours, 24);
  assert.equal(done.next.step, 'after_cancel');
  assert.deepEqual(done.replies[0].buttons.map((b) => b.id), ['my_appointments:after|book', 'menu:main|show']);

  const again = await myAppointmentsFlow.handle(
    makeCtx(repos, { patient: PATIENT, state: state('after_cancel', { patient: PATIENT }) }),
    replyInput('my_appointments:after|book', 'button_reply'),
  );
  assert.equal(again.next.flow, 'booking');
  assert.equal(again.next.step, 'choose_service');
  assert.deepEqual(again.next.context.patient, PATIENT);
});

test('free text on a choice step repeats the options as misunderstood', async () => {
  const repos = createRepos({ upcoming: [appointmentAt(48)] });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { patient: PATIENT, state: actionState() }),
    textInput('hmm'),
  );
  assert.equal(result.misunderstood, true);
  assert.equal(result.next.step, 'action');
  assert.equal(result.replies.at(-1).type, 'buttons');
});

// ---------------------------------------------------------------------------
// Botões do lembrete (T19): sem estado, paciente pelo wa_id.
// ---------------------------------------------------------------------------

function reminderRepos({ upcoming = [appointmentAt(24)], byWaId = PATIENT, confirmResult } = {}) {
  const repos = createRepos({ upcoming });
  repos.calls.waLookups = [];
  repos.calls.confirm = [];
  repos.patients.findPatientByWaId = async (waId) => {
    repos.calls.waLookups.push(waId);
    return byWaId;
  };
  repos.reminders = {
    async confirmAttendance(args) {
      repos.calls.confirm.push(args);
      return confirmResult ?? { ok: true, appointmentId: args.appointmentId };
    },
  };
  return repos;
}

const REMINDER_CONFIG = Object.freeze({ ...CONFIG, reminderHoursBefore: [24, 4] });

test('reminder Confirmo without state identifies by wa_id and sets the confirmation', async () => {
  const repos = reminderRepos();
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { config: REMINDER_CONFIG }),
    replyInput('my_appointments:reminder|confirm', 'button_reply'),
  );
  assert.deepEqual(repos.calls.waLookups, [WA_ID]);
  assert.equal(repos.calls.cpfLookups.length, 0);
  assert.deepEqual(repos.calls.confirm, [{ patientId: 7, appointmentId: 101, now: NOW }]);
  assert.equal(result.next, null);
  assert.deepEqual(result.events, [{ stepKey: 'my_appointments:reminder_confirmed' }]);
  assert.match(result.replies[0].body, /Obrigado, Ana! Sua presença em Fisioterapia/);
});

test('reminder Confirmo with an explicit appointment id picks that appointment', async () => {
  const repos = reminderRepos({ upcoming: [appointmentAt(24), appointmentAt(30, { id: 202 })] });
  await myAppointmentsFlow.handle(
    makeCtx(repos, { config: REMINDER_CONFIG }),
    replyInput('my_appointments:reminder|confirm:202', 'button_reply'),
  );
  assert.equal(repos.calls.confirm[0].appointmentId, 202);
});

test('reminder Confirmo ignores appointments beyond the reminder window', async () => {
  const repos = reminderRepos({ upcoming: [appointmentAt(24 * 5)] });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { config: REMINDER_CONFIG }),
    replyInput('my_appointments:reminder|confirm', 'button_reply'),
  );
  assert.equal(repos.calls.confirm.length, 0);
  assert.equal(result.next.step, 'pick');
  assert.match(allText(result), /Não encontrei a consulta desse lembrete/);
});

test('reminder Confirmo that the repository cannot find falls back to the list', async () => {
  const repos = reminderRepos({ confirmResult: { ok: false, reason: 'not_found' } });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { config: REMINDER_CONFIG }),
    replyInput('my_appointments:reminder|confirm', 'button_reply'),
  );
  assert.equal(result.next.step, 'pick');
});

test('reminder Remarcar with 24 h or more enters the reschedule day step', async () => {
  const repos = reminderRepos({ upcoming: [appointmentAt(26)] });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { config: REMINDER_CONFIG }),
    replyInput('my_appointments:reminder|reschedule', 'button_reply'),
  );
  assert.equal(result.next.step, 'reschedule_day');
  assert.deepEqual(result.next.context, { patient: PATIENT, appointmentId: 101 });
});

test('reminder Cancelar with 24 h or more asks for the cancel confirmation', async () => {
  const repos = reminderRepos({ upcoming: [appointmentAt(26)] });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { config: REMINDER_CONFIG }),
    replyInput('my_appointments:reminder|cancel', 'button_reply'),
  );
  assert.equal(result.next.step, 'confirm_cancel');
  assert.equal(repos.calls.cancel.length, 0);
});

test('reminder Remarcar/Cancelar inside 24 h (4 h reminder) hands off as late_change', async () => {
  for (const action of ['reschedule', 'cancel']) {
    const repos = reminderRepos({ upcoming: [appointmentAt(4)] });
    const result = await myAppointmentsFlow.handle(
      makeCtx(repos, { config: REMINDER_CONFIG }),
      replyInput(`my_appointments:reminder|${action}`, 'button_reply'),
    );
    assert.deepEqual(result.handoff, { reason: 'late_change' });
    assert.deepEqual(result.events, [{ stepKey: `my_appointments:reminder_${action}` }]);
  }
});

test('reminder button from an unknown wa_id asks for the CPF', async () => {
  const repos = reminderRepos({ byWaId: null });
  const result = await myAppointmentsFlow.handle(
    makeCtx(repos, { config: REMINDER_CONFIG }),
    replyInput('my_appointments:reminder|confirm', 'button_reply'),
  );
  assert.equal(result.next.step, 'ask_cpf');
  assert.equal(repos.calls.confirm.length, 0);
  assert.match(allText(result), /Não encontrei seu cadastro por este número/);
});

test('reminder button reuses the patient already identified in the conversation', async () => {
  const repos = reminderRepos();
  await myAppointmentsFlow.handle(
    makeCtx(repos, { config: REMINDER_CONFIG, patient: PATIENT }),
    replyInput('my_appointments:reminder|confirm', 'button_reply'),
  );
  assert.equal(repos.calls.waLookups.length, 0);
  assert.equal(repos.calls.confirm.length, 1);
});
