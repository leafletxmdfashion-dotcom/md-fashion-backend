import { pool, type Queryable } from "../../db/pool";
import type { UserStatus } from "../sessions/session.types";
import type { ManagedUserDto, ManagedUserRecord } from "./user.types";

interface ManagedUserRow {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  role_key: string;
  role_name: string;
  role_rank: number;
}

const MANAGED_USER_SELECT = `
  SELECT u.id, u.email, u.name, u.status, r.key AS role_key, r.name AS role_name, r.rank AS role_rank
  FROM users u JOIN roles r ON r.id = u.role_id`;

function toRecord(row: ManagedUserRow): ManagedUserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    role: { key: row.role_key, name: row.role_name, rank: row.role_rank },
  };
}

export const userRepository = {
  async list(): Promise<ManagedUserDto[]> {
    const { rows } = await pool.query<
      ManagedUserRow & {
        locked_until: Date | null;
        last_login_at: Date | null;
        created_at: Date;
        active_session_count: number;
        invitation_id: string | null;
        invitation_expires_at: Date | null;
        invitation_expired: boolean | null;
      }
    >(
      `SELECT u.id, u.email, u.name, u.status, u.locked_until, u.last_login_at, u.created_at,
              r.key AS role_key, r.name AS role_name, r.rank AS role_rank,
              (SELECT count(*)::int FROM sessions s
                 WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_session_count,
              i.id AS invitation_id, i.expires_at AS invitation_expires_at, i.expires_at <= now() AS invitation_expired
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN invitations i ON i.user_id = u.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       ORDER BY u.created_at ASC`,
    );
    return rows.map((row) => ({
      ...toRecord(row),
      lockedUntil: row.locked_until,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      activeSessionCount: row.active_session_count,
      invitation:
        row.invitation_id && row.invitation_expires_at
          ? { id: row.invitation_id, expiresAt: row.invitation_expires_at, expired: row.invitation_expired === true }
          : null,
    }));
  },

  /** Call inside a transaction: the row lock serializes concurrent admin changes to one user. */
  async findForUpdate(db: Queryable, userId: string): Promise<ManagedUserRecord | null> {
    const { rows } = await db.query<ManagedUserRow>(`${MANAGED_USER_SELECT} WHERE u.id = $1 FOR UPDATE OF u`, [userId]);
    return rows[0] ? toRecord(rows[0]) : null;
  },

  async findById(userId: string): Promise<ManagedUserRecord | null> {
    const { rows } = await pool.query<ManagedUserRow>(`${MANAGED_USER_SELECT} WHERE u.id = $1`, [userId]);
    return rows[0] ? toRecord(rows[0]) : null;
  },

  async emailExists(db: Queryable, email: string): Promise<boolean> {
    const { rowCount } = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
    return rowCount === 1;
  },

  async createInvited(
    db: Queryable,
    input: { email: string; name: string; roleId: string; createdBy: string },
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (email, name, role_id, status, created_by) VALUES ($1, $2, $3, 'INVITED', $4) RETURNING id`,
      [input.email, input.name, input.roleId, input.createdBy],
    );
    return rows[0]!.id;
  },

  async updateName(db: Queryable, userId: string, name: string): Promise<void> {
    await db.query("UPDATE users SET name = $2, updated_at = now() WHERE id = $1", [userId, name]);
  },

  async updateRole(db: Queryable, userId: string, roleId: string): Promise<void> {
    await db.query("UPDATE users SET role_id = $2, updated_at = now() WHERE id = $1", [userId, roleId]);
  },

  async setStatus(db: Queryable, userId: string, status: UserStatus): Promise<void> {
    await db.query(
      `UPDATE users SET status = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [userId, status],
    );
  },

  /**
   * Counts usable owners other than `excludingUserId`, locking those rows so two
   * admins cannot concurrently demote/disable the last two owners.
   */
  async countOtherActiveOwners(db: Queryable, excludingUserId: string): Promise<number> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.key = 'OWNER' AND u.status IN ('ACTIVE', 'LOCKED') AND u.id <> $1
       FOR UPDATE OF u`,
      [excludingUserId],
    );
    return rows.length;
  },
};

export const invitationRepository = {
  async create(
    db: Queryable,
    input: { userId: string; tokenHash: Buffer; invitedBy: string; expiresAt: Date },
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO invitations (user_id, token_hash, invited_by, expires_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.userId, input.tokenHash, input.invitedBy, input.expiresAt],
    );
    return rows[0]!.id;
  },

  async revokeOpenForUser(db: Queryable, userId: string): Promise<number> {
    const { rowCount } = await db.query(
      "UPDATE invitations SET revoked_at = now() WHERE user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL",
      [userId],
    );
    return rowCount ?? 0;
  },

  async findValidByTokenHash(
    tokenHash: Buffer,
  ): Promise<{ email: string; name: string; roleName: string; expiresAt: Date } | null> {
    const { rows } = await pool.query<{ email: string; name: string; role_name: string; expires_at: Date }>(
      `SELECT u.email, u.name, r.name AS role_name, i.expires_at
       FROM invitations i
       JOIN users u ON u.id = i.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
         AND i.expires_at > now() AND u.status = 'INVITED'`,
      [tokenHash],
    );
    const row = rows[0];
    return row ? { email: row.email, name: row.name, roleName: row.role_name, expiresAt: row.expires_at } : null;
  },

  /**
   * Single-use consumption. The conditional UPDATE takes a row lock; a concurrent
   * request re-evaluates the predicate after the first commits and matches nothing.
   */
  async consume(db: Queryable, tokenHash: Buffer): Promise<{ id: string; userId: string } | null> {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `UPDATE invitations SET accepted_at = now()
       WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       RETURNING id, user_id`,
      [tokenHash],
    );
    return rows[0] ? { id: rows[0].id, userId: rows[0].user_id } : null;
  },

  async activateInvitedUser(
    db: Queryable,
    userId: string,
    input: { name: string; passwordHash: string },
  ): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE users SET status = 'ACTIVE', name = $2, password_hash = $3, password_changed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'INVITED'`,
      [userId, input.name, input.passwordHash],
    );
    return rowCount === 1;
  },
};
