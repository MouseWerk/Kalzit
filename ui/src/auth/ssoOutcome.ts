/**
 * How a sign-in through a provider ended when the server sends the browser back to the sign-in
 * page (`/anmelden?sso=<outcome>`, docs/api/sso.md, "Callback").
 */
export const SSO_OUTCOMES = [
  "unavailable",
  "failed",
  "cancelled",
  "expired",
  "disabled",
  "unmapped",
  "no_account",
  "email_taken",
] as const;

export type SsoOutcome = (typeof SSO_OUTCOMES)[number];
