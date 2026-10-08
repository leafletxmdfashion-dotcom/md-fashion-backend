import { pool, type Queryable } from "../../db/pool";
import type { UserStatus } from "../sessions/session.types";
import { LOGIN_FAILURE_WINDOW_MINUTES, LOGIN_LOCK_THRESHOLD, lockMinutesFor } from "./auth.constants";

export interface LoginCandidate {
  id: string;
  passwordHash: string | null;
  status: UserStatus;
  lockedUntil: Date | null;
}

export interface Credentials {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  status: UserStatus;
}

export const authRepository = {
  async findLoginCandidate(email: string): Promise<LoginCandidate | null> {
    const { rows } = await pool.query<{
      id: string;
      password_hash: string | null;
      status: UserStatus;
      locked_until: Date | null;
    }>("SELECT id, password_hash, status, locked_until FROM users WHERE email = $1", [email]);
    const row = rows[0];
    return row
      ? { id: row.id, passwordHash: row.password_hash, status: row.status, lockedUntil: row.locked_until }
      : null;
  },

  /** Atomically counts a failure (decaying after the window) and applies a temporary lock at the threshold. */
  async registerFailedLogin(userId: string): Promise<{ failedCount: number; lockMinutes: number | null }> {
    const { rows } = await pool.query<{ failed_login_count: number }>(
      `UPDATE users SET
         failed_login_count = CASE
           WHEN last_failed_login_at IS NULL OR last_failed_login_at < now() - make_interval(mins => $2) THEN 1
           ELSE failed_login_count + 1 END,
         last_failed_login_at = now()
       WHERE id = $1
       RETURNING failed_login_count`,
      [userId, LOGIN_FAILURE_WINDOW_MINUTES],
    );
    const failedCount = rows[0]?.failed_login_count ?? 0;
    if (failedCount < LOGIN_LOCK_THRESHOLD) return { failedCount, lockMinutes: null };

    const lockMinutes = lockMinutesFor(failedCount);
    await pool.query(
      `UPDATE users SET status = 'LOCKED', locked_until = now() + make_interval(mins => $2), updated_at = now()
       WHERE id = $1 AND status IN ('ACTIVE', 'LOCKED')`,
      [userId, lockMinutes],
    );
    return { failedCount, lockMinutes };
  },

  async registerSuccessfulLogin(db: Queryable, userId: string, rehashedPassword: string | null): Promise<void> {
    await db.query(
      `UPDATE users SET
         failed_login_count = 0, last_failed_login_at = NULL, locked_until = NULL,
         status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE'::user_status ELSE status END,
         password_hash = COALESCE($2, password_hash),
         last_login_at = now()
       WHERE id = $1`,
      [userId, rehashedPassword],
    );
  },

  async findCredentials(db: Queryable, userId: string, lock = false): Promise<Credentials | null> {
    const { rows } = await db.query<{
      id: string;
      email: string;
      name: string;
      password_hash: string | null;
      status: UserStatus;
    }>(`SELECT id, email, name, password_hash, status FROM users WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [userId]);
    const row = rows[0];
    if (!row?.password_hash) return null;
    return { id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash, status: row.status };
  },

  async updatePassword(db: Queryable, userId: string, passwordHash: string): Promise<void> {
    await db.query(
      `UPDATE users SET
         password_hash = $2, password_changed_at = now(), updated_at = now(),
         failed_login_count = 0, last_failed_login_at = NULL, locked_until = NULL,
         status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE'::user_status ELSE status END
       WHERE id = $1`,
      [userId, passwordHash],
    );
  },

  async updateName(db: Queryable, userId: string, name: string): Promise<void> {
    await db.query("UPDATE users SET name = $2, updated_at = now() WHERE id = $1", [userId, name]);
  },

  // ---- password reset tokens ----

  async findResettableUser(email: string): Promise<{ id: string; name: string } | null> {
    const { rows } = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM users WHERE email = $1 AND status IN ('ACTIVE', 'LOCKED') AND password_hash IS NOT NULL",
      [email],
    );
    return rows[0] ?? null;
  },

  async hasRecentResetToken(userId: string, withinSeconds: number): Promise<boolean> {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND created_at > now() - make_interval(secs => $2) LIMIT 1",
      [userId, withinSeconds],
    );
    return rowCount === 1;
  },

  async createResetToken(
    db: Queryable,
    input: { userId: string; tokenHash: Buffer; expiresAt: Date; ip: string | null },
  ): Promise<void> {
    await db.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip) VALUES ($1, $2, $3, $4)",
      [input.userId, input.tokenHash, input.expiresAt, input.ip],
    );
  },

  async invalidateResetTokens(db: Queryable, userId: string): Promise<void> {
    await db.query("UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
  },

  /** Single-use: the conditional UPDATE lets exactly one concurrent caller win. */
  async consumeResetToken(db: Queryable, tokenHash: Buffer): Promise<string | null> {
    const { rows } = await db.query<{ user_id: string }>(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [tokenHash],
    );
    return rows[0]?.user_id ?? null;
  },
};
