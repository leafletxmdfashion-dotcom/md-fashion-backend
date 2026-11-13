import type { Permission, RoleRef } from "../permissions/permission.types";
import { env } from "../../config/env";
import type { AuthContext, UserStatus } from "../sessions/session.types";

/** The only user shape that leaves the API for the signed-in user. */
export interface CurrentUserDto {
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  status: UserStatus;
  role: Pick<RoleRef, "key" | "name">;
  permissions: Permission[];
  /** The password was set by an admin; the client must send the user to change it first. */
  mustChangePassword: boolean;
  /** The staff / karigar record this login belongs to (their own ledger), if any. */
  karigarId: string | null;
  /** Lets the client sign out exactly when the server will stop accepting the session. */
  session: { expiresAt: Date; idleTimeoutMinutes: number };
}

export interface ManagedUserDto {
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  status: UserStatus;
  role: RoleRef;
  lockedUntil: Date | null;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  activeSessionCount: number;
  /** The staff / karigar record this login belongs to, if any. */
  linkedTo: { id: string; name: string } | null;
  invitation: { id: string; expiresAt: Date; expired: boolean } | null;
}

export interface ManagedUserRecord {
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  status: UserStatus;
  role: RoleRef;
}

export function toCurrentUserDto({ user, expiresAt }: AuthContext): CurrentUserDto {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    status: user.status,
    role: { key: user.role.key, name: user.role.name },
    permissions: [...user.permissions].sort(),
    mustChangePassword: user.mustChangePassword,
    karigarId: user.karigarId,
    session: { expiresAt, idleTimeoutMinutes: env.SESSION_IDLE_TIMEOUT_MINUTES },
  };
}
