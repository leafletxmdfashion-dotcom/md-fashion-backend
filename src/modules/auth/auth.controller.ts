import type { Request, RequestHandler, Response } from "express";

import { logger } from "../../lib/logger";
import { clientMeta } from "../../lib/request";
import { errors } from "../../lib/errors";
import { invitationService } from "../users/invitation.service";
import { toCurrentUserDto } from "../users/user.types";
import { FORGOT_PASSWORD_MESSAGE } from "./auth.constants";
import { clearSessionCookie, cookieNames, readCookie, setSessionCookie } from "./auth.cookies";
import {
  acceptInvitationSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  invitationTokenSchema,
  loginSchema,
  resetPasswordSchema,
  sessionIdParamsSchema,
  updateProfileSchema,
} from "./auth.schema";
import { authService, type AuthenticatedResult } from "./auth.service";
import { csrfTokenForSession, issueCsrfToken, rotateAnonymousCsrf, sendCsrfHeader } from "./csrf";
import { passwordResetService } from "./password-reset.service";

function requireAuthContext(req: Request) {
  if (!req.auth) throw errors.unauthenticated();
  return req.auth;
}

function startSession(res: Response, result: AuthenticatedResult): void {
  setSessionCookie(res, result.session.token);
  sendCsrfHeader(res, csrfTokenForSession(result.session.sessionId));
}

function endSession(res: Response): void {
  clearSessionCookie(res);
  sendCsrfHeader(res, rotateAnonymousCsrf(res));
}

export const authController = {
  csrf: ((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data: { csrfToken: issueCsrfToken(req, res) } });
  }) satisfies RequestHandler,

  login: (async (req, res) => {
    const input = loginSchema.parse(req.body);
    const presented = readCookie(req.cookies, cookieNames().session);
    const result = await authService.login(input, clientMeta(req), presented);
    startSession(res, result);
    res.json({ success: true, data: { user: result.user } });
  }) satisfies RequestHandler,

  logout: (async (req, res) => {
    await authService.logout(req.auth, clientMeta(req));
    endSession(res);
    res.json({ success: true, data: null });
  }) satisfies RequestHandler,

  logoutAll: (async (req, res) => {
    const revoked = await authService.logoutAll(requireAuthContext(req), clientMeta(req));
    endSession(res);
    res.json({ success: true, data: { revokedSessions: revoked } });
  }) satisfies RequestHandler,

  me: ((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data: { user: toCurrentUserDto(requireAuthContext(req).user) } });
  }) satisfies RequestHandler,

  updateMe: (async (req, res) => {
    const input = updateProfileSchema.parse(req.body);
    const user = await authService.updateProfile(requireAuthContext(req), input, clientMeta(req));
    res.json({ success: true, data: { user } });
  }) satisfies RequestHandler,

  changePassword: (async (req, res) => {
    const input = changePasswordSchema.parse(req.body);
    const result = await authService.changePassword(requireAuthContext(req), input, clientMeta(req));
    startSession(res, result);
    res.json({ success: true, data: { user: result.user } });
  }) satisfies RequestHandler,

  listSessions: (async (req, res) => {
    const sessions = await authService.listSessions(requireAuthContext(req));
    res.json({ success: true, data: { sessions } });
  }) satisfies RequestHandler,

  revokeSession: (async (req, res) => {
    const { sessionId } = sessionIdParamsSchema.parse(req.params);
    const { current } = await authService.revokeOwnSession(requireAuthContext(req), sessionId, clientMeta(req));
    if (current) endSession(res);
    res.json({ success: true, data: { current } });
  }) satisfies RequestHandler,

  forgotPassword: ((req, res) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    const meta = clientMeta(req);
    // Respond first: identical status, body and latency whether or not the account exists.
    res.status(202).json({ success: true, data: { message: FORGOT_PASSWORD_MESSAGE } });
    passwordResetService.requestReset(email, meta).catch((error: unknown) => {
      logger.error({ err: error }, "password reset request processing failed");
    });
  }) satisfies RequestHandler,

  resetPassword: (async (req, res) => {
    const input = resetPasswordSchema.parse(req.body);
    await passwordResetService.resetPassword(input, clientMeta(req));
    res.json({ success: true, data: null });
  }) satisfies RequestHandler,

  inspectInvitation: (async (req, res) => {
    const { token } = invitationTokenSchema.parse(req.body);
    const invitation = await invitationService.inspect(token);
    res.json({ success: true, data: { invitation } });
  }) satisfies RequestHandler,

  acceptInvitation: (async (req, res) => {
    const input = acceptInvitationSchema.parse(req.body);
    await invitationService.accept(input, clientMeta(req));
    res.json({ success: true, data: null });
  }) satisfies RequestHandler,
};
