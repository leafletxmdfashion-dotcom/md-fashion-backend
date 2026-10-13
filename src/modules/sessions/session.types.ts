import type { Permission, RoleRef } from "../permissions/permission.types";

export type UserStatus = "ACTIVE" | "INVITED" | "DISABLED" | "LOCKED";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  role: RoleRef;
  permissions: ReadonlySet<Permission>;
}

export interface AuthContext {
  sessionId: string;
  /** Absolute expiry; the session also ends after SESSION_IDLE_TIMEOUT_MINUTES without requests. */
  expiresAt: Date;
  user: AuthenticatedUser;
}

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

export type SessionRevokeReason =
  | "logout"
  | "logout_all"
  | "login_rotation"
  | "password_changed"
  | "password_reset"
  | "user_disabled"
  | "revoked_by_user"
  | "revoked_by_admin";
