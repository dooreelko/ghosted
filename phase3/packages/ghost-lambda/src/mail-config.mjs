/**
 * Ghost's SMTP transport config shape (config.set('mail', ...)). Same Proton
 * submission host/port phase1 (moth jpjiy) already uses.
 */
export function buildMailConfig({ user, pass }) {
  return {
    // Ghost falls back to a generated noreply@<domain> address for the
    // member-facing "from"/support address whenever this is unset
    // (settings-helpers.js's getDefaultEmail()). Proton's submission
    // server rejects sending with a From address other than the
    // authenticated mailbox (EENVELOPE), so this must match `user`.
    from: user,
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
