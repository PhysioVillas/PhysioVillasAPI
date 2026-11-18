import assert from 'node:assert/strict';
import test from 'node:test';
import { appointmentServices, listAppointmentSlots } from '../src/config/appointmentSchedule.js';

test('weekly service catalog has the declared providers, durations, capacity, and windows', () => {
  assert.deepEqual(appointmentServices.fisioterapia.professionals, ['moises', 'antonio']);
  assert.equal(appointmentServices.fisioterapia.capacityPerSlot, 6);
  assert.deepEqual(appointmentServices.rpg.professionals, ['luarca']);
  assert.deepEqual(appointmentServices.pilates.professionals, ['luarca']);
  assert.deepEqual(appointmentServices.uro.professionals, ['camila']);
  assert.equal(appointmentServices.pilates.durationMinutes, 60);
  assert.equal(appointmentServices.rpg.durationMinutes, 30);
  assert.equal(appointmentServices.uro.durationMinutes, 30);
});

test('Pilates offers hourly starts with the lunch interval excluded', () => {
  const slots = listAppointmentSlots({ date: '2026-11-16', serviceCode: 'pilates', professionalCode: 'luarca' });
  assert.deepEqual(slots.map(({ startsAtLocal, endsAtLocal }) => `${startsAtLocal}-${endsAtLocal}`), [
    '07:00-08:00', '08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00',
    '14:00-15:00', '15:00-16:00', '16:00-17:00',
  ]);
});

test('RPG, URO, and physiotherapy offer half-hour starts through the declared closing times', () => {
  for (const serviceCode of ['rpg', 'uro', 'fisioterapia']) {
    const slots = listAppointmentSlots({ date: '2026-11-16', serviceCode });
    assert.equal(slots.length, 18);
    assert.equal(slots[0].startsAtLocal, '07:30');
    assert.equal(slots[8].endsAtLocal, '12:00');
    assert.equal(slots[9].startsAtLocal, '14:00');
    assert.equal(slots.at(-1).endsAtLocal, '18:30');
  }
});

test('slots are not offered on weekends, invalid dates, or for an ineligible professional', () => {
  assert.deepEqual(listAppointmentSlots({ date: '2026-11-14', serviceCode: 'uro' }), []);
  assert.deepEqual(listAppointmentSlots({ date: '2026-02-30', serviceCode: 'uro' }), []);
  assert.deepEqual(listAppointmentSlots({ date: '2026-11-16', serviceCode: 'uro', professionalCode: 'luarca' }), []);
});
