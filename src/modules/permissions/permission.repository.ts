import { prisma, type Db } from "../../db/prisma";
import { isPermission, type RoleWithPermissions } from "./permission.types";

export interface StoredRole extends RoleWithPermissions {
  id: string;
}

const ROLE_SELECT = {
  id: true,
  key: true,
  name: true,
  rank: true,
  permissions: { select: { permission: true }, orderBy: { permission: "asc" } },
} as const;

function toRole(role: {
  id: string;
  key: string;
  name: string;
  rank: number;
  permissions: { permission: string }[];
}): StoredRole {
  return { ...role, permissions: role.permissions.map((row) => row.permission).filter(isPermission) };
}

export const permissionRepository = {
  async listRoles(): Promise<StoredRole[]> {
    const roles = await prisma.role.findMany({ select: ROLE_SELECT, orderBy: { rank: "desc" } });
    return roles.map(toRole);
  },

  async findRoleByKey(db: Db, key: string): Promise<StoredRole | null> {
    const role = await db.role.findUnique({ where: { key }, select: ROLE_SELECT });
    return role ? toRole(role) : null;
  },

  /** Serializes concurrent edits of one role's permission set (call inside a transaction). */
  async lockRoleByKey(db: Db, key: string): Promise<void> {
    await db.$queryRaw`SELECT id FROM roles WHERE key = ${key} FOR UPDATE`;
  },

  async replaceRolePermissions(db: Db, roleId: string, permissions: readonly string[]): Promise<void> {
    await db.rolePermission.deleteMany({ where: { roleId } });
    await db.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permission })) });
  },
};
