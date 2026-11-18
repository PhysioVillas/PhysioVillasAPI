import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPOINTMENT_COMMAND_TRUST_UNAVAILABLE,
  AppointmentCommandTrustUnavailableError,
  createAppointmentCommandBoundary,
} from '../src/services/appointmentCommandBoundary.js';

test('appointment command boundary is explicitly unavailable without a verified provider command contract', () => {
  const boundary = createAppointmentCommandBoundary();

  assert.deepEqual(boundary.availability(), { available: false, reason: APPOINTMENT_COMMAND_TRUST_UNAVAILABLE });
  assert.throws(
    () => boundary.requireTrustedWebhookPrincipal({}),
    AppointmentCommandTrustUnavailableError,
  );
});

test('appointment command boundary only creates an unforgeable principal after authenticated, configured webhook verification', () => {
  const boundary = createAppointmentCommandBoundary({
    clinicWhatsappSender: '5571900000000',
    confirmationUtcOffset: '-03:00',
  });
  const principal = boundary.createVerifiedWebhookPrincipal({ webhookAuthenticated: true });

  assert.equal(boundary.availability().available, true);
  assert.equal(boundary.requireTrustedWebhookPrincipal(principal), principal);
  assert.equal(boundary.createVerifiedWebhookPrincipal({ webhookAuthenticated: false }), null);
});
