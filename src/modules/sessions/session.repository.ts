import { pool, type Queryable } from "../../db/pool";
import type { Permission } from "../permissions/permission.types";
import type { ClientMeta, SessionRevokeReason, SessionSummary, UserStatus } from "./session.types";

export interface SessionLookupRow {
  session_id: string;
  last_seen_at: Date;
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
    db: Queryable,
    input: { userId: string; tokenHash: Buffer; expiresAt: Date; meta: ClientMeta },
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.userId, input.tokenHash, input.expiresAt, input.meta.ip, input.meta.userAgent],
    );
    return rows[0]!.id;
  },

  // One query resolves session + user + role + permissions. Expiry, revocation and
  // account status are all enforced in SQL against the database clock.
  async findValidByTokenHash(tokenHash: Buffer, idleTimeoutMs: number): Promise<SessionLookupRow | null> {
    const { rows } = await pool.query<SessionLookupRow>(
      `SELECT s.id AS session_id, s.last_seen_at,
              u.id AS user_id, u.email, u.name, u.status,
              r.key AS role_key, r.name AS role_name, r.rank AS role_rank,
              COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.last_seen_at > now() - ($2::bigint * interval '1 millisecond')
         AND u.status IN ('ACTIVE', 'LOCKED')
       GROUP BY s.id, u.id, r.id`,
      [tokenHash, idleTimeoutMs],
    );
    return rows[0] ?? null;
  },

  async touch(sessionId: string): Promise<void> {
    await pool.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
  },

  async revokeById(db: Queryable, sessionId: string, reason: SessionRevokeReason): Promise<boolean> {
    const { rowCount } = await db.query(
      "UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL",
      [sessionId, reason],
    );
    return rowCount === 1;
  },

  async revokeOwnedById(
    db: Queryable,
    sessionId: string,
    userId: string,
    reason: SessionRevokeReason,
  ): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, userId, reason],
    );
    return rowCount === 1;
  },

  async revokeByTokenHash(db: Queryable, tokenHash: Buffer, reason: SessionRevokeReason): Promise<void> {
    await db.query(
      "UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE token_hash = $1 AND revoked_at IS NULL",
      [tokenHash, reason],
    );
  },

  async revokeAllForUser(db: Queryable, userId: string, reason: SessionRevokeReason): Promise<number> {
    const { rowCount } = await db.query(
      "UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL",
      [userId, reason],
    );
    return rowCount ?? 0;
  },

  async listActiveForUser(userId: string, idleTimeoutMs: number): Promise<SessionSummary[]> {
    const { rows } = await pool.query<SessionSummary>(
      `SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", expires_at AS "expiresAt",
              host(ip_address) AS "ipAddress", user_agent AS "userAgent"
       FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
         AND last_seen_at > now() - ($2::bigint * interval '1 millisecond')
       ORDER BY last_seen_at DESC`,
      [userId, idleTimeoutMs],
    );
    return rows;
  },
};
