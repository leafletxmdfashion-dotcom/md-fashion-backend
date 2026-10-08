import { withTransaction } from "../../db/pool";
import { errors } from "../../lib/errors";
import { recordAudit } from "../audit/audit.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { permissionRepository } from "./permission.repository";
import { canAssignRole, canEditRolePermissions } from "./permission.service";
import type { Permission, RoleWithPermissions } from "./permission.types";

export const roleService = {
  /** Every role, flagged with whether the caller may assign it (drives the role picker). */
  async list(actor: AuthContext): Promise<(RoleWithPermissions & { assignable: boolean })[]> {
    const roles = await permissionRepository.listRoles();
    return roles.map(({ id: _id, ...role }) => ({ ...role, assignable: canAssignRole(actor.user, role) }));
  },

  async updatePermissions(
    actor: AuthContext,
    roleKey: string,
    permissions: Permission[],
    meta: ClientMeta,
  ): Promise<RoleWithPermissions> {
    return withTransaction(async (tx) => {
      await permissionRepository.lockRoleByKey(tx, roleKey);
      const role = await permissionRepository.findRoleByKey(tx, roleKey);
      if (!role) throw errors.notFound("Role");
      if (!canEditRolePermissions(actor.user, role, permissions)) throw errors.forbidden();

      await permissionRepository.replaceRolePermissions(tx, role.id, permissions);

      const before = new Set(role.permissions);
      const after = new Set(permissions);
      await recordAudit(tx, {
        type: "PERMISSION_CHANGED",
        actorUserId: actor.user.id,
        sessionId: actor.sessionId,
        meta,
        metadata: {
          role: role.key,
          added: permissions.filter((permission) => !before.has(permission)),
          removed: role.permissions.filter((permission) => !after.has(permission)),
        },
      });
      return { key: role.key, name: role.name, rank: role.rank, permissions: [...after].sort() };
    });
  },
};
