import type { AuthenticatedUser } from "../sessions/session.types";
import { OWNER_ROLE, type Permission, type RoleRef } from "./permission.types";

// All authorization decisions go through these functions; controllers and
// services never compare role/permission strings themselves.

export function hasPermission(user: AuthenticatedUser, permission: Permission): boolean {
  return user.permissions.has(permission);
}

export function isOwner(role: Pick<RoleRef, "key">): boolean {
  return role.key === OWNER_ROLE;
}

/** Actor may act on another account only if it outranks that account (owners may manage owners). */
export function canManageUser(actor: AuthenticatedUser, target: RoleRef): boolean {
  if (!hasPermission(actor, "users.manage")) return false;
  return isOwner(actor.role) || target.rank < actor.role.rank;
}

/**
 * Prevents privilege escalation: a non-owner can only hand out roles ranked below
 * its own whose permissions it already holds.
 */
export function canAssignRole(
  actor: AuthenticatedUser,
  role: RoleRef & { permissions: readonly Permission[] },
): boolean {
  if (!hasPermission(actor, "users.manage")) return false;
  if (isOwner(actor.role)) return true;
  return role.rank < actor.role.rank && role.permissions.every((permission) => actor.permissions.has(permission));
}

/**
 * Roles are editable by holders of roles.manage when ranked below them (owners may
 * edit any role but their own). The Owner role always holds everything.
 */
export function canEditRole(actor: AuthenticatedUser, role: RoleRef): boolean {
  if (isOwner(role) || !hasPermission(actor, "roles.manage")) return false;

  return isOwner(actor.role) || role.rank < actor.role.rank;
}
