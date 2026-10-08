import type { Queryable } from "../../db/pool";
import type { ClientMeta } from "../sessions/session.types";

export type AuditEventType =
  | "OWNER_BOOTSTRAPPED"
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILURE"
  | "LOGOUT"
  | "LOGOUT_ALL"
  | "PASSWORD_CHANGED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET_COMPLETED"
  | "INVITATION_CREATED"
  | "INVITATION_RESENT"
  | "INVITATION_ACCEPTED"
  | "INVITATION_REVOKED"
  | "USER_UPDATED"
  | "USER_DISABLED"
  | "USER_ENABLED"
  | "ROLE_CHANGED"
  | "PERMISSION_CHANGED"
  | "SESSION_REVOKED";

export interface AuditEvent {
  type: AuditEventType;
  actorUserId?: string | null;
  targetUserId?: string | null;
  sessionId?: string | null;
  meta?: ClientMeta;
  // Identifiers and reasons only. Never passwords, hashes, tokens or CSRF values.
  metadata?: Record<string, string | number | boolean | null | string[]>;
}

// Accepts a transaction client so the audit row commits or rolls back with the change it records.
export async function recordAudit(db: Queryable, event: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (event_type, actor_user_id, target_user_id, session_id, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.type,
      event.actorUserId ?? null,
      event.targetUserId ?? null,
      event.sessionId ?? null,
      event.meta?.ip ?? null,
      event.meta?.userAgent ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}
