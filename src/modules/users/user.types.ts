import type { Permission, RoleRef } from "../permissions/permission.types";
import type { AuthenticatedUser, UserStatus } from "../sessions/session.types";

/** The only user shape that leaves the API for the signed-in user. */
export interface CurrentUserDto {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  role: Pick<RoleRef, "key" | "name">;
  permissions: Permission[];
}

export interface ManagedUserDto {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  role: RoleRef;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  activeSessionCount: number;
  invitation: { id: string; expiresAt: Date; expired: boolean } | null;
}

export interface ManagedUserRecord {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  role: RoleRef;
}

export function toCurrentUserDto(user: AuthenticatedUser): CurrentUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    role: { key: user.role.key, name: user.role.name },
    permissions: [...user.permissions].sort(),
  };
}
