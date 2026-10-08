import type { Request, RequestHandler, Response } from "express";

import { env } from "../../config/env";
import { generateToken, hmac, safeEqual } from "../../lib/crypto";
import { errors } from "../../lib/errors";
import { cookieNames, readCookie, setCsrfCookie } from "./auth.cookies";

// Synchronizer-token CSRF defence, stateless via HMAC:
// - authenticated: token = HMAC(secret, "session:" + sessionId). Bound to the server
//   session, so it changes whenever the session rotates (login, password change).
// - anonymous (login, password reset, invitation acceptance): token =
//   HMAC(secret, "anon:" + nonce), where the nonce lives in an HttpOnly cookie.
//   This blocks login CSRF: an attacker can neither read our nonce cookie nor
//   compute the HMAC without the server secret.
// The token itself is only ever delivered in response bodies/headers that
// cross-origin pages cannot read (CORS restricts reads to CLIENT_URL).

export const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sessionToken(sessionId: string): string {
  return hmac(env.CSRF_SECRET, `session:${sessionId}`);
}

function anonymousToken(nonce: string): string {
  return hmac(env.CSRF_SECRET, `anon:${nonce}`);
}

function readNonce(req: Request): string | undefined {
  const nonce = readCookie(req.cookies, cookieNames().csrf);
  return nonce && NONCE_PATTERN.test(nonce) ? nonce : undefined;
}

/** Token for the caller's current state; creates the anonymous nonce cookie if needed. */
export function issueCsrfToken(req: Request, res: Response): string {
  if (req.auth) return sessionToken(req.auth.sessionId);
  let nonce = readNonce(req);
  if (!nonce) {
    nonce = generateToken();
    setCsrfCookie(res, nonce);
  }
  return anonymousToken(nonce);
}

/** Hands the client a fresh token after its session changed (login, rotation, logout). */
export function sendCsrfHeader(res: Response, token: string): void {
  res.setHeader(CSRF_HEADER, token);
}

export function csrfTokenForSession(sessionId: string): string {
  return sessionToken(sessionId);
}

/** After logout the old session token is useless; start a new anonymous nonce. */
export function rotateAnonymousCsrf(res: Response): string {
  const nonce = generateToken();
  setCsrfCookie(res, nonce);
  return anonymousToken(nonce);
}

function hasTrustedOrigin(req: Request): boolean {
  const origin = req.get("origin");
  if (origin) return origin === env.clientOrigin;
  const referer = req.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === env.clientOrigin;
    } catch {
      return false;
    }
  }
  // Browsers always send Origin on cross-origin POSTs; its absence means a
  // non-browser client, which still has to present a valid token below.
  return true;
}

export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (!hasTrustedOrigin(req)) {
    next(errors.csrf());
    return;
  }

  const provided = req.get(CSRF_HEADER);
  const nonce = readNonce(req);
  const expected = req.auth ? sessionToken(req.auth.sessionId) : nonce ? anonymousToken(nonce) : undefined;

  if (!provided || !expected || !safeEqual(provided, expected)) {
    next(errors.csrf());
    return;
  }
  next();
};
