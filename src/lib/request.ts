import type { Request } from "express";

import { hasPermission } from "../modules/permissions/permission.service";
import type { Permission } from "../modules/permissions/permission.types";
import type { AuthContext, ClientMeta } from "../modules/sessions/session.types";
import { errors } from "./errors";

// IP and user agent are audit/risk signals only, never authentication factors.
// req.ip honours the explicit TRUST_PROXY setting.
export function clientMeta(req: Request): ClientMeta {
  return {
    ip: req.ip ?? null,
    userAgent: req.get("user-agent")?.slice(0, 512) ?? null,
  };
}

// Single normalization rule for every email lookup and write.
export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

/** The signed-in actor; routes run requireAuth first, so this only fails closed. */
export function actorOf(req: Request): AuthContext {
  if (!req.auth) throw errors.unauthenticated();

  return req.auth;
}

/** Whether the signed-in user holds a permission (for shaping responses, not for gating routes). */
export function can(req: Request, permission: Permission): boolean {
  return req.auth ? hasPermission(req.auth.user, permission) : false;
}
