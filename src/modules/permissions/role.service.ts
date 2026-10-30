import { randomInt } from "node:crypto";

import { isUniqueViolation, prisma, transaction } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { recordAudit } from "../audit/audit.service";
import { sessionService } from "../sessions/session.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { permissionRepository, type StoredRole } from "./permission.repository";
import { canAssignRole, canEditRole, isOwner } from "./permission.service";
import {
  BUILT_IN_ROLES,
  CUSTOM_ROLE_RANK,
  PERMISSION_GROUPS,
  PERMISSIONS,
  type Permission,
  type RoleWithPermissions,
} from "./permission.types";

export interface RoleDto extends RoleWithPermissions {
  builtIn: boolean;
  userCount: number;
  /** The caller may give this role to a user. */
  assignable: boolean;
  /** The caller may change this role's name (custom roles) or permissions. */
  editable: boolean;
}

const duplicateName = () =>
  new AppError(409, ErrorCode.CONFLICT, "Another role already has this name.", {
    name: ["Another role already has this name."],
  });

/** Owners hold every permission whatever their stored rows say. */
const effective = (role: StoredRole): Permission[] => (isOwner(role) ? [...PERMISSIONS] : role.permissions);

/** "Fabric Clerk" → FABRIC_CLERK. Keys allow letters and underscores only. */
function keyFrom(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);

  return base.length >= 2 ? base : "ROLE";
}

const randomLetters = () => Array.from({ length: 4 }, () => String.fromCharCode(65 + randomInt(26))).join("");

function toDto(actor: AuthContext, role: StoredRole, userCount: number): RoleDto {
  const permissions = effective(role);

  return {
    key: role.key,
    name: role.name,
    rank: role.rank,
    permissions,
    builtIn: BUILT_IN_ROLES.includes(role.key),
    userCount,
    assignable: canAssignRole(actor.user, { ...role, permissions }),
    editable: canEditRole(actor.user, role),
  };
}

/** Only rights the actor holds may be granted or taken away: no escalation through roles. */
function assertWithinOwnRights(actor: AuthContext, changed: readonly Permission[]): void {
  const missing = changed.filter((permission) => !actor.user.permissions.has(permission));

  if (missing.length > 0) {
    throw new AppError(403, ErrorCode.AUTH_FORBIDDEN, "You can only grant or remove permissions you hold yourself.", {
      permissions: [`Not yours to grant: ${missing.join(", ")}.`],
    });
  }
}

export const roleService = {
  /** Every role with its holders count and what the caller may do with it, plus the catalog. */
  async list(actor: AuthContext) {
    const [roles, counts] = await Promise.all([
      permissionRepository.listRoles(),
      prisma.user.groupBy({ by: ["roleId"], _count: true }),
    ]);

    const countOf = new Map(counts.map((row) => [row.roleId, row._count]));

    return {
      roles: roles.map((role) => toDto(actor, role, countOf.get(role.id) ?? 0)),
      catalog: PERMISSION_GROUPS,
    };
  },

  async create(actor: AuthContext, input: { name: string; permissions: Permission[] }, meta: ClientMeta) {
    assertWithinOwnRights(actor, input.permissions);

    try {
      const role = await transaction(async (tx) => {
        let key = keyFrom(input.name);

        // ponytail: a clash with an existing key gets a random suffix; the name stays the readable identity.
        while (await tx.role.findUnique({ where: { key }, select: { id: true } })) {
          key = `${keyFrom(input.name)}_${randomLetters()}`;
        }

        await tx.role.create({
          data: {
            key,
            name: input.name,
            rank: CUSTOM_ROLE_RANK,
            permissions: { createMany: { data: input.permissions.map((permission) => ({ permission })) } },
          },
          select: { id: true },
        });

        await recordAudit(tx, {
          type: "ROLE_CREATED",
          actorUserId: actor.user.id,
          sessionId: actor.sessionId,
          meta,
          metadata: { role: key, name: input.name, permissions: input.permissions },
        });

        return (await permissionRepository.findRoleByKey(tx, key))!;
      });

      return toDto(actor, role, 0);
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateName() : error;
    }
  },

  /** Renames a custom role and/or replaces a role's permissions. */
  async update(
    actor: AuthContext,
    roleKey: string,
    input: { name?: string | undefined; permissions: Permission[] },
    meta: ClientMeta,
  ): Promise<RoleDto> {
    try {
      const role = await transaction(async (tx) => {
        await permissionRepository.lockRoleByKey(tx, roleKey);

        const current = await permissionRepository.findRoleByKey(tx, roleKey);

        if (!current) throw errors.notFound("Role");

        if (!canEditRole(actor.user, current)) throw errors.forbidden();

        const before = new Set(current.permissions);
        const after = new Set(input.permissions);
        const added = input.permissions.filter((permission) => !before.has(permission));
        const removed = current.permissions.filter((permission) => !after.has(permission));

        assertWithinOwnRights(actor, [...added, ...removed]);

        const rename = input.name !== undefined && input.name !== current.name;

        if (rename && BUILT_IN_ROLES.includes(current.key)) {
          throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Built-in roles keep their name.", {
            name: ["Built-in roles keep their name."],
          });
        }

        if (rename) await tx.role.update({ where: { id: current.id }, data: { name: input.name! } });

        if (added.length > 0 || removed.length > 0) {
          await permissionRepository.replaceRolePermissions(tx, current.id, input.permissions);
        }

        if (rename || added.length > 0 || removed.length > 0) {
          await recordAudit(tx, {
            type: "PERMISSION_CHANGED",
            actorUserId: actor.user.id,
            sessionId: actor.sessionId,
            meta,
            metadata: { role: current.key, added, removed, name: rename ? input.name! : null },
          });
        }

        return (await permissionRepository.findRoleByKey(tx, roleKey))!;
      });

      // Signed-in holders of the role get the new rights on their next request.
      sessionService.forgetCached();

      const count = await prisma.user.count({ where: { roleId: role.id } });

      return toDto(actor, role, count);
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateName() : error;
    }
  },

  /** Deletes a custom role nobody holds (pending invitations count as holders). */
  async remove(actor: AuthContext, roleKey: string, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      await permissionRepository.lockRoleByKey(tx, roleKey);

      const role = await permissionRepository.findRoleByKey(tx, roleKey);

      if (!role) throw errors.notFound("Role");

      if (BUILT_IN_ROLES.includes(role.key)) throw errors.conflict("Built-in roles cannot be deleted.");

      if (!canEditRole(actor.user, role)) throw errors.forbidden();

      const holders = await tx.user.count({ where: { roleId: role.id } });

      if (holders > 0) {
        throw errors.conflict(
          `${holders} user${holders === 1 ? " has" : "s have"} this role. Give them another role first.`,
        );
      }

      await tx.role.delete({ where: { id: role.id } });
      await recordAudit(tx, {
        type: "ROLE_DELETED",
        actorUserId: actor.user.id,
        sessionId: actor.sessionId,
        meta,
        metadata: { role: role.key, name: role.name },
      });
    });
  },
};
