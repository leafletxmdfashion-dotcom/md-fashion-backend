import type { RequestHandler } from "express";

import { errors } from "../../lib/errors";
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
