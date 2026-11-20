import type { AuditEventType } from "./audit.service";

// What each audit event means to a person reading the log: a label, the area of the system
// and how much attention it deserves. `satisfies` makes the compiler refuse a new event
// type until it is described here.

export const AUDIT_CATEGORIES = [
  "Sign-in & security",
  "Users & access",
  "Fabric",
  "Cutting & lots",
  "Stitching",
  "Packing",
  "Godown",
  "Teams & karigars",
  "Payments",
  "Costing",
  "Approvals & settings",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** info: routine work · notice: a correction or setting change · warning: undoing or failing · critical: access to the system */
export const AUDIT_SEVERITIES = ["info", "notice", "warning", "critical"] as const;

export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

interface EventInfo {
  label: string;
  category: AuditCategory;
  severity: AuditSeverity;
  /** A failed attempt rather than a change. */
  failure?: true;
}

const e = (label: string, category: AuditCategory, severity: AuditSeverity = "info", failure?: true): EventInfo =>
  failure ? { label, category, severity, failure } : { label, category, severity };

export const AUDIT_EVENTS = {
  OWNER_BOOTSTRAPPED: e("Owner account created", "Users & access", "critical"),
  LOGIN_SUCCESS: e("Signed in", "Sign-in & security"),
  LOGIN_FAILURE: e("Sign-in failed", "Sign-in & security", "warning", true),
  LOGOUT: e("Signed out", "Sign-in & security"),
  LOGOUT_ALL: e("Signed out everywhere", "Sign-in & security", "notice"),
  PASSWORD_CHANGED: e("Password changed", "Sign-in & security", "notice"),
  PASSWORD_RESET_REQUESTED: e("Password reset requested", "Sign-in & security", "notice"),
  PASSWORD_RESET_COMPLETED: e("Password reset", "Sign-in & security", "notice"),
  INVITATION_CREATED: e("Invitation sent", "Users & access", "notice"),
  USER_CREATED: e("Login created", "Users & access", "notice"),
  PASSWORD_SET_BY_ADMIN: e("Password set by an admin", "Users & access", "critical"),
  INVITATION_RESENT: e("Invitation resent", "Users & access"),
  INVITATION_ACCEPTED: e("Invitation accepted", "Users & access"),
  INVITATION_REVOKED: e("Invitation revoked", "Users & access", "notice"),
  USER_UPDATED: e("User details changed", "Users & access", "notice"),
  USER_DISABLED: e("User disabled", "Users & access", "critical"),
  USER_ENABLED: e("User enabled", "Users & access", "critical"),
  ROLE_CHANGED: e("Role changed", "Users & access", "critical"),
  PERMISSION_CHANGED: e("Role permissions changed", "Users & access", "critical"),
  PERMISSION_OVERRIDE_CHANGED: e("Personal access changed", "Users & access", "critical"),
  ROLE_CREATED: e("Role created", "Users & access", "critical"),
  ROLE_DELETED: e("Role deleted", "Users & access", "critical"),
  SESSION_REVOKED: e("Session ended", "Sign-in & security", "notice"),
  FABRIC_CREATED: e("Fabric created", "Fabric"),
  FABRIC_UPDATED: e("Fabric edited", "Fabric", "notice"),
  FABRIC_INWARD_POSTED: e("Fabric purchase recorded", "Fabric"),
  FABRIC_INWARD_REVERSED: e("Fabric purchase reversed", "Fabric", "warning"),
  FABRIC_BILL_ADDED: e("Bill added to a fabric purchase", "Fabric", "notice"),
  FABRIC_STOCK_ADJUSTED: e("Fabric stock corrected", "Fabric", "warning"),
  KARIGAR_CREATED: e("Person added", "Teams & karigars"),
  KARIGAR_UPDATED: e("Person edited", "Teams & karigars", "notice"),
  KARIGAR_LOGIN_LINKED: e("Login linked to a person", "Users & access", "critical"),
  ARTICLE_CREATED: e("Item created", "Cutting & lots"),
  ARTICLE_UPDATED: e("Item edited", "Cutting & lots", "notice"),
  ARTICLE_DELETED: e("Item deleted", "Cutting & lots", "warning"),
  ARTICLES_MERGED: e("Items merged", "Cutting & lots", "warning"),
  SIZE_TEMPLATE_SAVED: e("Size template saved", "Cutting & lots"),
  SIZE_TEMPLATE_DELETED: e("Size template deleted", "Cutting & lots", "notice"),
  LOT_CREATED: e("Lot created", "Cutting & lots"),
  LOT_UPDATED: e("Lot edited", "Cutting & lots", "notice"),
  CUTTING_DRAFT_SAVED: e("Cutting draft saved", "Cutting & lots"),
  CUTTING_DRAFT_DELETED: e("Cutting draft deleted", "Cutting & lots", "notice"),
  CUTTING_FABRIC_ISSUED: e("Fabric issued for cutting", "Cutting & lots"),
  CUTTING_FINALIZED: e("Cutting finalized", "Cutting & lots"),
  CUTTING_REVERSED: e("Cutting reversed", "Cutting & lots", "warning"),
  JOGADI_CREATED: e("Team created", "Teams & karigars"),
  JOGADI_UPDATED: e("Team edited", "Teams & karigars", "notice"),
  TEAM_CREATED: e("Team created", "Teams & karigars"),
  TEAM_UPDATED: e("Team edited", "Teams & karigars", "notice"),
  STITCHING_ISSUED: e("Issued to a Jogadi", "Stitching"),
  STITCHING_ISSUE_REVERSED: e("Stitching issue reversed", "Stitching", "warning"),
  STITCHING_RECEIVED: e("Stitched pieces received", "Stitching"),
  STITCHING_RECEIPT_REVERSED: e("Stitching receipt reversed", "Stitching", "warning"),
  REWORK_UPDATED: e("Rework updated", "Stitching"),
  REWORK_RESOLVED: e("Rework resolved", "Stitching"),
  PACKING_POSTED: e("Pieces packed", "Packing"),
  PACKING_REVERSED: e("Packing reversed", "Packing", "warning"),
  DISPATCH_POSTED: e("Goods dispatched", "Godown"),
  DISPATCH_REVERSED: e("Dispatch reversed", "Godown", "warning"),
  GODOWN_ADJUSTED: e("Godown count corrected", "Godown", "warning"),
  LEDGER_ENTRY_POSTED: e("Payment or entry recorded", "Payments", "notice"),
  MONEY_KIND_SAVED: e("Kind of money entry added or changed", "Payments", "info"),
  SETTINGS_SAVED: e("Settings changed", "Approvals & settings", "notice"),
  LOT_COST_ADDED: e("Cost added to a lot", "Costing", "notice"),
  LOT_COST_REMOVED: e("Cost removed from a lot", "Costing", "warning"),
  APPROVAL_REQUESTED: e("Correction sent for approval", "Approvals & settings", "notice"),
  APPROVAL_APPROVED: e("Correction approved", "Approvals & settings", "warning"),
  APPROVAL_REJECTED: e("Correction rejected", "Approvals & settings", "notice"),
  APPROVAL_CANCELLED: e("Correction request cancelled", "Approvals & settings"),
  STITCHING_RATE_SET: e("Stitching rate set or changed", "Stitching", "notice"),
  PACKING_RATE_SET: e("Packing rate set or changed", "Packing", "notice"),
  LEDGER_ENTRY_REVERSED: e("Payment or entry reversed", "Payments", "warning"),
} satisfies Record<AuditEventType, EventInfo>;

export const AUDIT_TYPES = Object.keys(AUDIT_EVENTS) as AuditEventType[];

export function eventInfo(type: string): EventInfo {
  return (AUDIT_EVENTS as Record<string, EventInfo>)[type] ?? e(type, "Users & access", "notice");
}

/** Metadata keys naming the record an event is about, most specific first. */
export const ENTITY_KEYS = [
  "entryId",
  "dispatchId",
  "inwardId",
  "batchId",
  "issueId",
  "receiptId",
  "reworkId",
  "teamId",
  "lotId",
  "articleId",
  "fabricId",
  "karigarId",
  "invitationId",
] as const;
