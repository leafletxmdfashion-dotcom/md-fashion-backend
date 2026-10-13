import { prisma, type Db } from "../../db/prisma";
import type { TokenHash } from "../../lib/crypto";
import type { Permission } from "../permissions/permission.types";
import type { ClientMeta, SessionRevokeReason, SessionSummary, UserStatus } from "./session.types";

export interface SessionLookupRow {
  session_id: string;
  last_seen_at: Date;
  expires_at: Date;
  user_id: string;
  email: string;
  name: string;
  status: UserStatus;
  role_key: string;
  role_name: string;
  role_rank: number;
  permissions: Permission[];
}

export const sessionRepository = {
  async create(
    db: Db,
    input: { userId: string; tokenHash: TokenHash; expiresAt: Date; meta: ClientMeta },
  ): Promise<string> {
    const session = await db.session.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ipAddress: input.meta.ip,
        userAgent: input.meta.userAgent,
      },
      select: { id: true },
    });
    return session.id;
  },

  // One query resolves session + user + role + permissions. Expiry, revocation and
  // account status are all enforced in SQL against the database clock.
  async findValidByTokenHash(tokenHash: TokenHash, idleTimeoutMs: number): Promise<SessionLookupRow | null> {
    const [row] = await prisma.$queryRaw<SessionLookupRow[]>`
      SELECT s.id AS session_id, s.last_seen_at, s.expires_at,
             u.id AS user_id, u.email, u.name, u.status::text AS status,
             r.key AS role_key, r.name AS role_name, r.rank AS role_rank,
             COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE s.token_hash = ${tokenHash}
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - (${idleTimeoutMs}::bigint * interval '1 millisecond')
        AND u.status IN ('ACTIVE', 'LOCKED')
      GROUP BY s.id, u.id, r.id`;
    return row ?? null;
  },

  async touch(sessionId: string): Promise<void> {
    await prisma.$executeRaw`UPDATE sessions SET last_seen_at = now() WHERE id = ${sessionId}::uuid AND revoked_at IS NULL`;
  },

  async revokeById(db: Db, sessionId: string, reason: SessionRevokeReason): Promise<boolean> {
    const { count } = await db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count === 1;
  },

  async revokeOwnedById(db: Db, sessionId: string, userId: string, reason: SessionRevokeReason): Promise<boolean> {
    const { count } = await db.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count === 1;
  },

  async revokeByTokenHash(db: Db, tokenHash: TokenHash, reason: SessionRevokeReason): Promise<void> {
    await db.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  },

  async revokeAllForUser(db: Db, userId: string, reason: SessionRevokeReason): Promise<number> {
    const { count } = await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  },

  listActiveForUser(userId: string, idleTimeoutMs: number): Promise<SessionSummary[]> {
    return prisma.$queryRaw<SessionSummary[]>`
      SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", expires_at AS "expiresAt",
             host(ip_address) AS "ipAddress", user_agent AS "userAgent"
      FROM sessions
      WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()
        AND last_seen_at > now() - (${idleTimeoutMs}::bigint * interval '1 millisecond')
      ORDER BY last_seen_at DESC`;
  },
};
