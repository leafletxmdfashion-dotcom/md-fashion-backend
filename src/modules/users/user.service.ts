import { prisma, transaction, type Db } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { recordAudit } from "../audit/audit.service";
import { permissionRepository } from "../permissions/permission.repository";
import { canAssignRole, canManageUser, isOwner } from "../permissions/permission.service";
import { sessionService } from "../sessions/session.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { userRepository } from "./user.repository";
import type { ManagedUserDto, ManagedUserRecord } from "./user.types";

/** Locks the target row and enforces the hierarchy; self-management goes through /auth instead. */
async function lockManageableTarget(tx: Db, actor: AuthContext, userId: string): Promise<ManagedUserRecord> {
  if (userId === actor.user.id) {
    throw errors.conflict("Use your account settings to change your own account.");
  }
  const target = await userRepository.findForUpdate(tx, userId);
  if (!target) throw errors.notFound("User");
  if (!canManageUser(actor.user, target.role)) throw errors.forbidden();
  return target;
}

async function assertNotLastOwner(tx: Db, target: ManagedUserRecord): Promise<void> {
  if (isOwner(target.role) && (await userRepository.countOtherActiveOwners(tx, target.id)) === 0) {
    throw new AppError(409, ErrorCode.LAST_OWNER, "The last active owner cannot be removed or disabled.");
  }
}

export const userService = {
  list(): Promise<ManagedUserDto[]> {
    return userRepository.list();
  },

  async get(userId: string): Promise<ManagedUserRecord> {
    const user = await userRepository.findById(userId);
    if (!user) throw errors.notFound("User");
    return user;
  },

  async updateProfile(actor: AuthContext, userId: string, input: { name: string }, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      await lockManageableTarget(tx, actor, userId);
      await userRepository.updateName(tx, userId, input.name);
      sessionService.forgetCached();
      await recordAudit(tx, {
        type: "USER_UPDATED",
        actorUserId: actor.user.id,
        targetUserId: userId,
        sessionId: actor.sessionId,
        meta,
        metadata: { fields: ["name"] },
      });
    });
  },

  async changeRole(actor: AuthContext, userId: string, roleKey: string, meta: ClientMeta): Promise<void> {
    const role = await permissionRepository.findRoleByKey(prisma, roleKey);
    if (!role) throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Unknown role.", { roleKey: ["Unknown role."] });
    if (!canAssignRole(actor.user, role)) throw errors.forbidden();

    await transaction(async (tx) => {
      const target = await lockManageableTarget(tx, actor, userId);
      if (target.role.key === role.key) return;
      if (!isOwner(role)) await assertNotLastOwner(tx, target);

      await userRepository.updateRole(tx, userId, role.id);
      sessionService.forgetCached();
      await recordAudit(tx, {
        type: "ROLE_CHANGED",
        actorUserId: actor.user.id,
        targetUserId: userId,
        sessionId: actor.sessionId,
        meta,
        metadata: { from: target.role.key, to: role.key },
      });
    });
  },

  async disable(actor: AuthContext, userId: string, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      const target = await lockManageableTarget(tx, actor, userId);
      if (target.status === "DISABLED") return;
      if (target.status === "INVITED") throw errors.conflict("Revoke the invitation instead of disabling.");
      await assertNotLastOwner(tx, target);

      await userRepository.setStatus(tx, userId, "DISABLED");
      const revoked = await sessionService.revokeAllForUser(tx, userId, "user_disabled");
      await recordAudit(tx, {
        type: "USER_DISABLED",
        actorUserId: actor.user.id,
        targetUserId: userId,
        sessionId: actor.sessionId,
        meta,
        metadata: { revokedSessions: revoked },
      });
    });
  },

  /** Reactivates a disabled account or lifts a temporary lock early. */
  async enable(actor: AuthContext, userId: string, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      const target = await lockManageableTarget(tx, actor, userId);
      if (target.status !== "DISABLED" && target.status !== "LOCKED") {
        throw errors.conflict("Only disabled or locked accounts can be enabled.");
      }
      await userRepository.setStatus(tx, userId, "ACTIVE");
      await recordAudit(tx, {
        type: "USER_ENABLED",
        actorUserId: actor.user.id,
        targetUserId: userId,
        sessionId: actor.sessionId,
        meta,
        metadata: { previousStatus: target.status },
      });
    });
  },

  async revokeSessions(actor: AuthContext, userId: string, meta: ClientMeta): Promise<number> {
    return transaction(async (tx) => {
      await lockManageableTarget(tx, actor, userId);
      const revoked = await sessionService.revokeAllForUser(tx, userId, "revoked_by_admin");
      await recordAudit(tx, {
        type: "SESSION_REVOKED",
        actorUserId: actor.user.id,
        targetUserId: userId,
        sessionId: actor.sessionId,
        meta,
        metadata: { revokedSessions: revoked },
      });
      return revoked;
    });
  },
};
