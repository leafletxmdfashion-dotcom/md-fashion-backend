import { prisma, type Db } from "../../db/prisma";
import type { TokenHash } from "../../lib/crypto";
import type { UserStatus } from "../sessions/session.types";
import type { ManagedUserDto, ManagedUserRecord } from "./user.types";

const MANAGED_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  status: true,
  role: { select: { key: true, name: true, rank: true } },
} as const;

/** Locked rows come from raw SQL (Prisma has no FOR UPDATE), shaped like MANAGED_USER_SELECT. */
interface LockedUserRow {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  role_key: string;
  role_name: string;
  role_rank: number;
}

const openInvitation = { acceptedAt: null, revokedAt: null } as const;

export const userRepository = {
  async list(): Promise<ManagedUserDto[]> {
    const now = new Date();
    const users = await prisma.user.findMany({
      select: {
        ...MANAGED_USER_SELECT,
        lockedUntil: true,
        lastLoginAt: true,
        createdAt: true,
        _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: now } } } } },
        invitations: { where: openInvitation, select: { id: true, expiresAt: true }, take: 1 },
      },
      orderBy: { createdAt: "asc" },
    });
    return users.map(({ _count, invitations, ...user }) => {
      const invitation = invitations[0];
      return {
        ...user,
        activeSessionCount: _count.sessions,
        invitation: invitation ? { ...invitation, expired: invitation.expiresAt <= now } : null,
      };
    });
  },

  /** Call inside a transaction: the row lock serializes concurrent admin changes to one user. */
  async findForUpdate(db: Db, userId: string): Promise<ManagedUserRecord | null> {
    const [row] = await db.$queryRaw<LockedUserRow[]>`
      SELECT u.id, u.email, u.name, u.status::text AS status,
             r.key AS role_key, r.name AS role_name, r.rank AS role_rank
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ${userId}::uuid
      FOR UPDATE OF u`;
    return row
      ? {
          id: row.id,
          email: row.email,
          name: row.name,
          status: row.status,
          role: { key: row.role_key, name: row.role_name, rank: row.role_rank },
        }
      : null;
  },

  findById(userId: string): Promise<ManagedUserRecord | null> {
    return prisma.user.findUnique({ where: { id: userId }, select: MANAGED_USER_SELECT });
  },

  async emailExists(db: Db, email: string): Promise<boolean> {
    return (await db.user.findUnique({ where: { email }, select: { id: true } })) !== null;
  },

  async createInvited(
    db: Db,
    input: { email: string; name: string; roleId: string; createdBy: string },
  ): Promise<string> {
    const user = await db.user.create({
      data: { email: input.email, name: input.name, roleId: input.roleId, status: "INVITED", createdById: input.createdBy },
      select: { id: true },
    });
    return user.id;
  },

  async updateName(db: Db, userId: string, name: string): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { name } });
  },

  async updateRole(db: Db, userId: string, roleId: string): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { roleId } });
  },

  async setStatus(db: Db, userId: string, status: UserStatus): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { status, failedLoginCount: 0, lockedUntil: null } });
  },

  /**
   * Counts usable owners other than `excludingUserId`, locking those rows so two
   * admins cannot concurrently demote/disable the last two owners.
   */
  async countOtherActiveOwners(db: Db, excludingUserId: string): Promise<number> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.key = 'OWNER' AND u.status IN ('ACTIVE', 'LOCKED') AND u.id <> ${excludingUserId}::uuid
      FOR UPDATE OF u`;
    return rows.length;
  },
};

export const invitationRepository = {
  async create(
    db: Db,
    input: { userId: string; tokenHash: TokenHash; invitedBy: string; expiresAt: Date },
  ): Promise<string> {
    const invitation = await db.invitation.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        invitedById: input.invitedBy,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });
    return invitation.id;
  },

  async revokeOpenForUser(db: Db, userId: string): Promise<number> {
    const { count } = await db.invitation.updateMany({
      where: { userId, ...openInvitation },
      data: { revokedAt: new Date() },
    });
    return count;
  },

  async findValidByTokenHash(
    tokenHash: TokenHash,
  ): Promise<{ email: string; name: string; roleName: string; expiresAt: Date } | null> {
    const invitation = await prisma.invitation.findFirst({
      where: { tokenHash, ...openInvitation, expiresAt: { gt: new Date() }, user: { status: "INVITED" } },
      select: { expiresAt: true, user: { select: { email: true, name: true, role: { select: { name: true } } } } },
    });
    return invitation
      ? {
          email: invitation.user.email,
          name: invitation.user.name,
          roleName: invitation.user.role.name,
          expiresAt: invitation.expiresAt,
        }
      : null;
  },

  /**
   * Single-use consumption. The conditional UPDATE takes a row lock; a concurrent
   * request re-evaluates the predicate after the first commits and matches nothing.
   */
  async consume(db: Db, tokenHash: TokenHash): Promise<{ id: string; userId: string } | null> {
    const [row] = await db.$queryRaw<{ id: string; user_id: string }[]>`
      UPDATE invitations SET accepted_at = now()
      WHERE token_hash = ${tokenHash} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, user_id`;
    return row ? { id: row.id, userId: row.user_id } : null;
  },

  async activateInvitedUser(
    db: Db,
    userId: string,
    input: { name: string; passwordHash: string },
  ): Promise<boolean> {
    const { count } = await db.user.updateMany({
      where: { id: userId, status: "INVITED" },
      data: { status: "ACTIVE", name: input.name, passwordHash: input.passwordHash, passwordChangedAt: new Date() },
    });
    return count === 1;
  },
};
