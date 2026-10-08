import type { Request } from "express";

import type { ClientMeta } from "../modules/sessions/session.types";

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
