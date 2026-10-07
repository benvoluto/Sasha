// Local development without Clerk keys: SASHA_DEV_AUTH_BYPASS=1 lets every
// request through as a fixed developer user. It is ignored in production
// builds, so a stray env var on a deployment cannot open the app.

export const DEV_USER = { userId: "dev-user", email: "dev@localhost" } as const;

export function devAuthBypass(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.SASHA_DEV_AUTH_BYPASS === "1";
}
