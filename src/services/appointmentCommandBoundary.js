const APPOINTMENT_COMMAND_TRUST_UNAVAILABLE =
  'Appointment commands are unavailable until the webhook is authenticated and the shared clinic sender and confirmation offset are configured.';

class AppointmentCommandTrustUnavailableError extends Error {
  constructor() {
    super(APPOINTMENT_COMMAND_TRUST_UNAVAILABLE);
    this.name = 'AppointmentCommandTrustUnavailableError';
  }
}

function createAppointmentCommandBoundary({
  clinicWhatsappSender,
  confirmationUtcOffset,
} = {}) {
  const trustedPrincipals = new WeakSet();

  function isConfigured() {
    const offset = typeof confirmationUtcOffset === 'string'
      ? /^[-+](\d{2}):(\d{2})$/.exec(confirmationUtcOffset)
      : null;
    const offsetHours = offset === null ? Number.NaN : Number(offset[1]);
    const offsetMinutes = offset === null ? Number.NaN : Number(offset[2]);
    return typeof clinicWhatsappSender === 'string' && clinicWhatsappSender !== '' &&
      offset !== null && offsetHours <= 14 && offsetMinutes <= 59 &&
      (offsetHours < 14 || offsetMinutes === 0);
  }

  function availability() {
    return {
      available: isConfigured(),
      reason: isConfigured() ? null : APPOINTMENT_COMMAND_TRUST_UNAVAILABLE,
    };
  }

  // This receives only the router's authentication result, never caller input.
  // It does not parse message bodies or manufacture a human staff identity.
  function createVerifiedWebhookPrincipal({ webhookAuthenticated } = {}) {
    if (!isConfigured() || webhookAuthenticated !== true) {
      return null;
    }

    const principal = Object.freeze({
      kind: 'verified_infobip_webhook',
      clinicWhatsappSender,
      confirmationUtcOffset,
    });
    trustedPrincipals.add(principal);
    return principal;
  }

  function requireTrustedWebhookPrincipal(principal) {
    if (!trustedPrincipals.has(principal)) {
      throw new AppointmentCommandTrustUnavailableError();
    }

    return principal;
  }

  return {
    availability,
    createVerifiedWebhookPrincipal,
    requireTrustedWebhookPrincipal,
  };
}

export {
  APPOINTMENT_COMMAND_TRUST_UNAVAILABLE,
  AppointmentCommandTrustUnavailableError,
  createAppointmentCommandBoundary,
};
