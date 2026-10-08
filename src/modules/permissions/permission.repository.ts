import { pool, type Queryable } from "../../db/pool";
import { isPermission, type RoleWithPermissions } from "./permission.types";

interface RoleRow {
  id: string;
  key: string;
  name: string;
  rank: number;
  permissions: string[];
}

export interface StoredRole extends RoleWithPermissions {
  id: string;
}

const ROLE_SELECT = `
  SELECT r.id, r.key, r.name, r.rank,
         COALESCE(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
  FROM roles r
  LEFT JOIN role_permissions rp ON rp.role_id = r.id`;

function toRole(row: RoleRow): StoredRole {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    rank: row.rank,
    permissions: row.permissions.filter(isPermission),
  };
}

export const permissionRepository = {
  async listRoles(): Promise<StoredRole[]> {
    const { rows } = await pool.query<RoleRow>(`${ROLE_SELECT} GROUP BY r.id ORDER BY r.rank DESC`);
    return rows.map(toRole);
  },

  async findRoleByKey(db: Queryable, key: string): Promise<StoredRole | null> {
    const { rows } = await db.query<RoleRow>(`${ROLE_SELECT} WHERE r.key = $1 GROUP BY r.id`, [key]);
    return rows[0] ? toRole(rows[0]) : null;
  },

  /** Serializes concurrent edits of one role's permission set (call inside a transaction). */
  async lockRoleByKey(db: Queryable, key: string): Promise<void> {
    await db.query("SELECT id FROM roles WHERE key = $1 FOR UPDATE", [key]);
  },

  async replaceRolePermissions(db: Queryable, roleId: string, permissions: readonly string[]): Promise<void> {
    await db.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
    await db.query("INSERT INTO role_permissions (role_id, permission) SELECT $1, unnest($2::text[])", [
      roleId,
      permissions,
    ]);
  },
};
