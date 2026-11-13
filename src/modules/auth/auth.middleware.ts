import type { RequestHandler } from "express";

import { AppError, ErrorCode, errors } from "../../lib/errors";
import { sessionService } from "../sessions/session.service";
import { clearSessionCookie, cookieNames, readCookie } from "./auth.cookies";

/** Resolves the session cookie into req.auth. Never rejects; requireAuth decides. */
export const loadSession: RequestHandler = async (req, res, next) => {
  const token = readCookie(req.cookies, cookieNames().session);
  if (!token) {
    next();
    return;
  }

  const auth = await sessionService.authenticate(token);
  if (auth) {
    req.auth = auth;
  } else {
    // Expired, revoked or forged: drop it so the client stops presenting it.
    clearSessionCookie(res);
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.auth ? undefined : errors.unauthenticated());
};

// While an admin-set password is pending change, only these calls work (paths relative to /api/v1).
const PASSWORD_CHANGE_ALLOWED = new Set([
  "GET /auth/csrf",
  "GET /auth/me",
  "POST /auth/change-password",
  "POST /auth/logout",
  "POST /auth/logout-all",
]);

/** Enforced on the server: a user with a pending admin-set password can do nothing else until it is changed. */
export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  if (!req.auth?.user.mustChangePassword || PASSWORD_CHANGE_ALLOWED.has(`${req.method} ${req.path}`)) {
    next();
    return;
  }
  next(new AppError(403, ErrorCode.PASSWORD_CHANGE_REQUIRED, "Change your password to continue."));
};
