import type { Request } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";

import { env } from "../config/env";
import { errors } from "./errors";
import { normalizeEmail } from "./request";

// chisle: in-memory stores are per process. Running several API instances needs a
// shared store (Redis/Postgres) for these limits; the DB-backed account lockout
// in auth.repository already applies across instances.

const MINUTE = 60_000;

function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? "unknown");
}

// Keyed by the submitted (normalized) email. Unknown emails are limited exactly like
// real ones, so a 429 never reveals whether an account exists.
function accountKey(req: Request): string {
  const body: unknown = req.body;
  const email = typeof body === "object" && body !== null && "email" in body ? body.email : undefined;
  return typeof email === "string" && email.length <= 254 ? `email:${normalizeEmail(email)}` : `ip:${ipKey(req)}`;
}

function limiter(
  options: Pick<Options, "windowMs" | "limit"> & Partial<Pick<Options, "keyGenerator" | "skipSuccessfulRequests">>,
) {
  return rateLimit({
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: ipKey,
    handler: (_req, _res, next) => next(errors.rateLimited()),
    ...options,
  });
}

export function createRateLimiters() {
  return {
    api: limiter({ windowMs: MINUTE, limit: env.API_RATE_LIMIT_PER_MINUTE }),
    // Failed attempts only: credential stuffing from one address, and guessing against one account.
    loginByIp: limiter({ windowMs: 15 * MINUTE, limit: 20, skipSuccessfulRequests: true }),
    loginByAccount: limiter({
      windowMs: 15 * MINUTE,
      limit: 10,
      skipSuccessfulRequests: true,
      keyGenerator: accountKey,
    }),
    forgotByIp: limiter({ windowMs: 15 * MINUTE, limit: 10 }),
    forgotByAccount: limiter({ windowMs: 60 * MINUTE, limit: 3, keyGenerator: accountKey }),
    // Reset-password and invitation endpoints: token guessing.
    tokenByIp: limiter({ windowMs: 15 * MINUTE, limit: 20 }),
    // Authenticated re-verification (change password).
    sensitive: limiter({ windowMs: 15 * MINUTE, limit: 10, keyGenerator: (req) => req.auth?.user.id ?? ipKey(req) }),
  };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;
