// The permission catalog. Adding a permission here makes it grantable; role
// assignments live in the role_permissions table.
export const PERMISSIONS = [
  "dashboard.view",
  "products.view",
  "products.create",
  "products.update",
  "products.delete",
  "garments.view",
  "garments.create",
  "garments.update",
  "garments.delete",
  "inventory.view",
  "inventory.adjust",
  "fabric.view",
  "fabric.manage",
  "fabric.inward",
  "fabric.adjust",
  "leftovers.view",
  "leftovers.manage",
  "orders.view",
  "orders.create",
  "orders.update",
  "orders.cancel",
  "customers.view",
  "customers.manage",
  "reports.view",
  "users.view",
  "users.manage",
  "settings.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Roles are rows in the roles table (seeded: OWNER, ADMIN, MANAGER, STAFF, VIEWER).
// Only OWNER has special meaning in code: top of the hierarchy, must never reach zero.
export const OWNER_ROLE = "OWNER";

export interface RoleRef {
  key: string;
  name: string;
  rank: number;
}

export interface RoleWithPermissions extends RoleRef {
  permissions: Permission[];
}

const permissionSet: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return permissionSet.has(value);
}
