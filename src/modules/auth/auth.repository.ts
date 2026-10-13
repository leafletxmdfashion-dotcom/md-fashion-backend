import { prisma, Prisma, type Db } from "../../db/prisma";
import type { TokenHash } from "../../lib/crypto";
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

// Login counters, locks and single-use tokens are conditional updates evaluated
// against the database clock, so they stay raw SQL: one statement decides the
// outcome even when requests race.

export const authRepository = {
  findLoginCandidate(email: string): Promise<LoginCandidate | null> {
    return prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, status: true, lockedUntil: true },
    });
  },

  /** Atomically counts a failure (decaying after the window) and applies a temporary lock at the threshold. */
  async registerFailedLogin(userId: string): Promise<{ failedCount: number; lockMinutes: number | null }> {
    const [row] = await prisma.$queryRaw<{ failed_login_count: number }[]>`
      UPDATE users SET
        failed_login_count = CASE
          WHEN last_failed_login_at IS NULL
            OR last_failed_login_at < now() - make_interval(mins => ${LOGIN_FAILURE_WINDOW_MINUTES}::int) THEN 1
          ELSE failed_login_count + 1 END,
        last_failed_login_at = now()
      WHERE id = ${userId}::uuid
      RETURNING failed_login_count`;
    const failedCount = row?.failed_login_count ?? 0;
    if (failedCount < LOGIN_LOCK_THRESHOLD) return { failedCount, lockMinutes: null };

    const lockMinutes = lockMinutesFor(failedCount);
    await prisma.$executeRaw`
      UPDATE users SET status = 'LOCKED', locked_until = now() + make_interval(mins => ${lockMinutes}::int),
                       updated_at = now()
      WHERE id = ${userId}::uuid AND status IN ('ACTIVE', 'LOCKED')`;
    return { failedCount, lockMinutes };
  },

  async registerSuccessfulLogin(db: Db, userId: string, rehashedPassword: string | null): Promise<void> {
    await db.$executeRaw`
      UPDATE users SET
        failed_login_count = 0, last_failed_login_at = NULL, locked_until = NULL,
        status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE'::user_status ELSE status END,
        password_hash = COALESCE(${rehashedPassword}, password_hash),
        last_login_at = now()
      WHERE id = ${userId}::uuid`;
  },

  async findCredentials(db: Db, userId: string, lock = false): Promise<Credentials | null> {
    const [row] = await db.$queryRaw<
      { id: string; email: string; name: string; password_hash: string | null; status: UserStatus }[]
    >`SELECT id, email, name, password_hash, status::text FROM users
      WHERE id = ${userId}::uuid ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`;
    if (!row?.password_hash) return null;
    return { id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash, status: row.status };
  },

  async updatePassword(db: Db, userId: string, passwordHash: string): Promise<void> {
    await db.$executeRaw`
      UPDATE users SET
        password_hash = ${passwordHash}, password_changed_at = now(), updated_at = now(),
        failed_login_count = 0, last_failed_login_at = NULL, locked_until = NULL,
        status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE'::user_status ELSE status END
      WHERE id = ${userId}::uuid`;
  },

  async updateName(db: Db, userId: string, name: string): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { name } });
  },

  // ---- password reset tokens ----

  findResettableUser(email: string): Promise<{ id: string; name: string } | null> {
    return prisma.user.findFirst({
      where: { email, status: { in: ["ACTIVE", "LOCKED"] }, passwordHash: { not: null } },
      select: { id: true, name: true },
    });
  },

  async hasRecentResetToken(userId: string, withinSeconds: number): Promise<boolean> {
    const [row] = await prisma.$queryRaw<{ recent: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM password_reset_tokens
        WHERE user_id = ${userId}::uuid AND created_at > now() - make_interval(secs => ${withinSeconds}::float8)
      ) AS recent`;
    return row?.recent === true;
  },

  async createResetToken(
    db: Db,
    input: { userId: string; tokenHash: TokenHash; expiresAt: Date; ip: string | null },
  ): Promise<void> {
    await db.passwordResetToken.create({
      data: { userId: input.userId, tokenHash: input.tokenHash, expiresAt: input.expiresAt, requestedIp: input.ip },
    });
  },

  async invalidateResetTokens(db: Db, userId: string): Promise<void> {
    await db.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  },

  /** Single-use: the conditional UPDATE lets exactly one concurrent caller win. */
  async consumeResetToken(db: Db, tokenHash: TokenHash): Promise<string | null> {
    const [row] = await db.$queryRaw<{ user_id: string }[]>`
      UPDATE password_reset_tokens SET used_at = now()
      WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`;
    return row?.user_id ?? null;
  },
};
