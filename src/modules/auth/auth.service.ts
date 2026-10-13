import { prisma, transaction } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { recordAudit } from "../audit/audit.service";
import { sessionService, type IssuedSession } from "../sessions/session.service";
import type { AuthContext, ClientMeta, SessionSummary } from "../sessions/session.types";
import { toCurrentUserDto, type CurrentUserDto } from "../users/user.types";
import { authRepository } from "./auth.repository";
import {
  assertPasswordPolicy,
  hashPassword,
  passwordNeedsRehash,
  verifyDummyPassword,
  verifyPassword,
} from "./password";

export interface AuthenticatedResult {
  user: CurrentUserDto;
  session: IssuedSession;
}

async function loadCurrentUser(session: IssuedSession): Promise<CurrentUserDto> {
  const auth = await sessionService.authenticate(session.token);
  if (!auth) throw new Error("Freshly issued session failed to authenticate");
  return toCurrentUserDto(auth);
}

export const authService = {
  /**
   * Every failure path performs one Argon2 verification and ends in the same
   * generic 401, so responses do not reveal whether the account exists, is
   * disabled/locked, or merely had a wrong password.
   */
  async login(
    input: { email: string; password: string },
    meta: ClientMeta,
    presentedToken: string | undefined,
  ): Promise<AuthenticatedResult> {
    const candidate = await authRepository.findLoginCandidate(input.email);

    const fail = async (reason: string, userId: string | null): Promise<never> => {
      await recordAudit(prisma, { type: "LOGIN_FAILURE", targetUserId: userId, meta, metadata: { reason } });
      throw errors.invalidCredentials();
    };

    if (!candidate || !candidate.passwordHash) {
      await verifyDummyPassword(input.password);
      return fail(candidate ? "account_not_activated" : "unknown_account", candidate?.id ?? null);
    }
    if (candidate.status === "DISABLED" || candidate.status === "INVITED") {
      await verifyDummyPassword(input.password);
      return fail("account_disabled", candidate.id);
    }
    if (candidate.status === "LOCKED" && candidate.lockedUntil && candidate.lockedUntil > new Date()) {
      await verifyDummyPassword(input.password);
      return fail("account_locked", candidate.id);
    }

    if (!(await verifyPassword(candidate.passwordHash, input.password))) {
      const { lockMinutes } = await authRepository.registerFailedLogin(candidate.id);
      return fail(lockMinutes ? `invalid_password_locked_${lockMinutes}m` : "invalid_password", candidate.id);
    }

    const rehashed = passwordNeedsRehash(candidate.passwordHash) ? await hashPassword(input.password) : null;

    // New session is always freshly generated; any cookie presented before login is retired.
    const session = await transaction(async (tx) => {
      await sessionService.revokePresentedToken(tx, presentedToken, "login_rotation");
      await authRepository.registerSuccessfulLogin(tx, candidate.id, rehashed);
      const issued = await sessionService.create(tx, candidate.id, meta);
      await recordAudit(tx, {
        type: "LOGIN_SUCCESS",
        actorUserId: candidate.id,
        targetUserId: candidate.id,
        sessionId: issued.sessionId,
        meta,
      });
      return issued;
    });

    return { user: await loadCurrentUser(session), session };
  },

  async logout(auth: AuthContext | undefined, meta: ClientMeta): Promise<void> {
    if (!auth) return;
    await transaction(async (tx) => {
      await sessionService.revoke(tx, auth.sessionId, "logout");
      await recordAudit(tx, {
        type: "LOGOUT",
        actorUserId: auth.user.id,
        targetUserId: auth.user.id,
        sessionId: auth.sessionId,
        meta,
      });
    });
  },

  /** Revokes every session including the current one; the browser must sign in again. */
  async logoutAll(auth: AuthContext, meta: ClientMeta): Promise<number> {
    return transaction(async (tx) => {
      const revoked = await sessionService.revokeAllForUser(tx, auth.user.id, "logout_all");
      await recordAudit(tx, {
        type: "LOGOUT_ALL",
        actorUserId: auth.user.id,
        targetUserId: auth.user.id,
        sessionId: auth.sessionId,
        meta,
        metadata: { revokedSessions: revoked },
      });
      return revoked;
    });
  },

  /**
   * Policy: all of the user's sessions (other devices and the current one) are
   * revoked, and the current browser receives a brand-new session, so a stolen
   * cookie stops working the moment the owner changes the password.
   */
  async changePassword(
    auth: AuthContext,
    input: { currentPassword: string; newPassword: string },
    meta: ClientMeta,
  ): Promise<AuthenticatedResult> {
    const credentials = await authRepository.findCredentials(prisma, auth.user.id);
    if (!credentials || !(await verifyPassword(credentials.passwordHash, input.currentPassword))) {
      throw new AppError(400, ErrorCode.AUTH_CURRENT_PASSWORD_INCORRECT, "Current password is incorrect.", {
        currentPassword: ["Current password is incorrect."],
      });
    }
    if (await verifyPassword(credentials.passwordHash, input.newPassword)) {
      throw new AppError(400, ErrorCode.PASSWORD_REUSED, "New password must differ from the current password.", {
        newPassword: ["New password must differ from the current password."],
      });
    }
    assertPasswordPolicy(input.newPassword, { email: credentials.email, name: credentials.name });
    const passwordHash = await hashPassword(input.newPassword);

    const session = await transaction(async (tx) => {
      await authRepository.updatePassword(tx, auth.user.id, passwordHash);
      await authRepository.invalidateResetTokens(tx, auth.user.id);
      const revoked = await sessionService.revokeAllForUser(tx, auth.user.id, "password_changed");
      const issued = await sessionService.create(tx, auth.user.id, meta);
      await recordAudit(tx, {
        type: "PASSWORD_CHANGED",
        actorUserId: auth.user.id,
        targetUserId: auth.user.id,
        sessionId: issued.sessionId,
        meta,
        metadata: { revokedSessions: revoked },
      });
      return issued;
    });

    return { user: await loadCurrentUser(session), session };
  },

  async updateProfile(auth: AuthContext, input: { name: string }, meta: ClientMeta): Promise<CurrentUserDto> {
    await transaction(async (tx) => {
      await authRepository.updateName(tx, auth.user.id, input.name);
      await recordAudit(tx, {
        type: "USER_UPDATED",
        actorUserId: auth.user.id,
        targetUserId: auth.user.id,
        meta,
        metadata: { fields: ["name"] },
      });
    });
    return toCurrentUserDto({ ...auth, user: { ...auth.user, name: input.name } });
  },

  listSessions(auth: AuthContext): Promise<(SessionSummary & { current: boolean })[]> {
    return sessionService
      .listActive(auth.user.id)
      .then((sessions) => sessions.map((session) => ({ ...session, current: session.id === auth.sessionId })));
  },

  /** Scoped by owner: a session id belonging to someone else is indistinguishable from a missing one. */
  async revokeOwnSession(auth: AuthContext, sessionId: string, meta: ClientMeta): Promise<{ current: boolean }> {
    await transaction(async (tx) => {
      const revoked = await sessionService.revokeOwned(tx, sessionId, auth.user.id, "revoked_by_user");
      if (!revoked) throw errors.notFound("Session");
      await recordAudit(tx, {
        type: "SESSION_REVOKED",
        actorUserId: auth.user.id,
        targetUserId: auth.user.id,
        sessionId,
        meta,
      });
    });
    return { current: sessionId === auth.sessionId };
  },
};
