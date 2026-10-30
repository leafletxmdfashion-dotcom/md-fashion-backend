import type { Db } from "../../db/prisma";
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
  | "ROLE_CREATED"
  | "ROLE_DELETED"
  | "SESSION_REVOKED"
  | "FABRIC_CREATED"
  | "FABRIC_UPDATED"
  | "FABRIC_INWARD_POSTED"
  | "FABRIC_INWARD_REVERSED"
  | "FABRIC_STOCK_ADJUSTED"
  | "KARIGAR_CREATED"
  | "KARIGAR_UPDATED"
  | "ARTICLE_CREATED"
  | "ARTICLE_UPDATED"
  | "SIZE_TEMPLATE_SAVED"
  | "SIZE_TEMPLATE_DELETED"
  | "LOT_CREATED"
  | "LOT_UPDATED"
  | "CUTTING_DRAFT_SAVED"
  | "CUTTING_DRAFT_DELETED"
  | "CUTTING_FABRIC_ISSUED"
  | "CUTTING_FINALIZED"
  | "CUTTING_REVERSED"
  | "JOGADI_CREATED"
  | "JOGADI_UPDATED"
  | "STITCHING_ISSUED"
  | "STITCHING_ISSUE_REVERSED"
  | "STITCHING_RECEIVED"
  | "STITCHING_RECEIPT_REVERSED"
  | "REWORK_UPDATED"
  | "REWORK_RESOLVED";

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
export async function recordAudit(db: Db, event: AuditEvent): Promise<void> {
  await db.auditEvent.create({
    data: {
      eventType: event.type,
      actorUserId: event.actorUserId ?? null,
      targetUserId: event.targetUserId ?? null,
      sessionId: event.sessionId ?? null,
      ipAddress: event.meta?.ip ?? null,
      userAgent: event.meta?.userAgent ?? null,
      metadata: event.metadata ?? {},
    },
  });
}
