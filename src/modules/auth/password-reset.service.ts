import { env } from "../../config/env";
import { withTransaction } from "../../db/pool";
import { generateToken, hashToken } from "../../lib/crypto";
import { errors } from "../../lib/errors";
import { recordAudit } from "../audit/audit.service";
import { sendMail } from "../mail/mailer";
import { sessionService } from "../sessions/session.service";
import type { ClientMeta } from "../sessions/session.types";
import { RESET_REQUEST_COOLDOWN_SECONDS, RESET_TOKEN_TTL_MS } from "./auth.constants";
import { authRepository } from "./auth.repository";
import { assertPasswordPolicy, hashPassword } from "./password";

export const passwordResetService = {
  /**
   * Runs after the HTTP response has been sent (see controller), so neither the
   * status code, body nor timing depends on whether the account exists.
   * Requesting a reset never changes account state.
   */
  async requestReset(email: string, meta: ClientMeta): Promise<void> {
    const user = await authRepository.findResettableUser(email);
    if (!user) return;
    if (await authRepository.hasRecentResetToken(user.id, RESET_REQUEST_COOLDOWN_SECONDS)) return;

    const token = generateToken();
    await withTransaction(async (tx) => {
      // Only the newest link works.
      await authRepository.invalidateResetTokens(tx, user.id);
      await authRepository.createResetToken(tx, {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        ip: meta.ip,
      });
      await recordAudit(tx, { type: "PASSWORD_RESET_REQUESTED", targetUserId: user.id, meta });
    });

    // Fragment (#) keeps the token out of server logs, proxies and Referer headers.
    const link = `${env.clientOrigin}/reset-password#token=${token}`;
    await sendMail({
      to: email,
      subject: "Reset your Garment Manager password",
      text: [
        `Hi ${user.name},`,
        "",
        "Someone requested a password reset for your Garment Manager account.",
        `Use this link within ${RESET_TOKEN_TTL_MS / 60_000} minutes to choose a new password:`,
        link,
        "",
        "If you did not request this, you can ignore this email. Your password has not changed.",
      ].join("\n"),
    });
  },

  /**
   * Token consumption, password change, token invalidation, session revocation
   * and the audit record commit together or not at all.
   */
  async resetPassword(input: { token: string; newPassword: string }, meta: ClientMeta): Promise<void> {
    await withTransaction(async (tx) => {
      const userId = await authRepository.consumeResetToken(tx, hashToken(input.token));
      if (!userId) throw errors.tokenInvalid();

      const credentials = await authRepository.findCredentials(tx, userId, true);
      if (!credentials || (credentials.status !== "ACTIVE" && credentials.status !== "LOCKED")) {
        throw errors.tokenInvalid();
      }
      // A policy failure rolls back, leaving the token usable for a better password.
      assertPasswordPolicy(input.newPassword, { email: credentials.email, name: credentials.name });

      await authRepository.updatePassword(tx, userId, await hashPassword(input.newPassword));
      await authRepository.invalidateResetTokens(tx, userId);
      const revoked = await sessionService.revokeAllForUser(tx, userId, "password_reset");
      await recordAudit(tx, {
        type: "PASSWORD_RESET_COMPLETED",
        actorUserId: userId,
        targetUserId: userId,
        meta,
        metadata: { revokedSessions: revoked },
      });
    });
  },
};
