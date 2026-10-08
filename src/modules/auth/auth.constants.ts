export const RESET_TOKEN_TTL_MS = 30 * 60_000;
// Repeated reset requests inside this window do not send another email.
export const RESET_REQUEST_COOLDOWN_SECONDS = 60;

export const INVITATION_TTL_MS = 72 * 3_600_000;

// Temporary, progressive account lockout. After LOCK_THRESHOLD failures within
// FAILURE_WINDOW_MINUTES the account locks for 1, 2, 4, 8, then 15 minutes max.
// Locks expire on their own, so an attacker can delay but never permanently block a user.
export const LOGIN_LOCK_THRESHOLD = 5;
export const LOGIN_FAILURE_WINDOW_MINUTES = 15;
export const LOGIN_MAX_LOCK_MINUTES = 15;

export function lockMinutesFor(failedCount: number): number {
  return Math.min(2 ** Math.max(0, failedCount - LOGIN_LOCK_THRESHOLD), LOGIN_MAX_LOCK_MINUTES);
}

export const FORGOT_PASSWORD_MESSAGE =
  "If an account exists for this email, password reset instructions have been sent.";
