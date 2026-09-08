/**
 * Ghost's SMTP transport config shape (config.set('mail', ...)). Same Proton
 * submission host/port phase1 (moth jpjiy) already uses.
 */
export function buildMailConfig({ user, pass }) {
  return {
    transport: 'SMTP',
    options: {
      service: 'ProtonMail',
      host: 'smtp.protonmail.ch',
      port: 587,
      secure: false,
      auth: { user, pass },
    },
  };
}
