import { env } from "../../config/env";
import { isUniqueViolation, prisma, transaction, type Db } from "../../db/prisma";
import { generateToken, hashToken } from "../../lib/crypto";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { recordAudit } from "../audit/audit.service";
import { INVITATION_TTL_MS } from "../auth/auth.constants";
import { assertPasswordPolicy, hashPassword } from "../auth/password";
import { sendMail } from "../mail/mailer";
import { permissionRepository } from "../permissions/permission.repository";
import { canAssignRole, canManageUser } from "../permissions/permission.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { invitationRepository, userRepository } from "./user.repository";

export interface IssuedInvitation {
  userId: string;
  invitationId: string;
  expiresAt: Date;
  // Returned once to the inviting admin so the link can be shared even without email.
  inviteUrl: string;
}

function inviteUrl(token: string): string {
  // Fragment (#) keeps the token out of server logs, proxies and Referer headers.
  return `${env.clientOrigin}/accept-invitation#token=${token}`;
}

async function issueInvitation(tx: Db, userId: string, invitedBy: string) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const invitationId = await invitationRepository.create(tx, {
    userId,
    tokenHash: hashToken(token),
    invitedBy,
    expiresAt,
  });
  return { token, invitationId, expiresAt };
}

async function deliver(email: string, name: string, url: string): Promise<void> {
  try {
    await sendMail({
      to: email,
      subject: "You have been invited to Garment Manager",
      text: [
        `Hi ${name},`,
        "",
        "You have been invited to join Garment Manager. Set your password to activate your account:",
        url,
        "",
        `This link expires in ${INVITATION_TTL_MS / 3_600_000} hours and works once.`,
      ].join("\n"),
    });
  } catch (error) {
    // The admin still receives the link in the API response, so delivery failure is not fatal.
    logger.error({ err: error }, "invitation email delivery failed");
  }
}

export const invitationService = {
  async create(
    actor: AuthContext,
    input: { email: string; name: string; roleKey: string },
    meta: ClientMeta,
  ): Promise<IssuedInvitation> {
    const role = await permissionRepository.findRoleByKey(prisma, input.roleKey);
    if (!role) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Unknown role.", { roleKey: ["Unknown role."] });
    }
    if (!canAssignRole(actor.user, role)) throw errors.forbidden();

    try {
      const result = await transaction(async (tx) => {
        if (await userRepository.emailExists(tx, input.email)) {
          throw errors.conflict("A user with this email already exists.");
        }
        const userId = await userRepository.createInvited(tx, {
          email: input.email,
          name: input.name,
          roleId: role.id,
          createdBy: actor.user.id,
        });
        const issued = await issueInvitation(tx, userId, actor.user.id);
        await recordAudit(tx, {
          type: "INVITATION_CREATED",
          actorUserId: actor.user.id,
          targetUserId: userId,
          sessionId: actor.sessionId,
          meta,
          metadata: { invitationId: issued.invitationId, role: role.key },
        });
        return { userId, ...issued };
      });

      const url = inviteUrl(result.token);
      await deliver(input.email, input.name, url);
      return { userId: result.userId, invitationId: result.invitationId, expiresAt: result.expiresAt, inviteUrl: url };
    } catch (error) {
      // Concurrent invite for the same email loses on the unique constraint.
      if (isUniqueViolation(error)) {
        throw errors.conflict("A user with this email already exists.");
      }
      throw error;
    }
  },

  /** Replaces any open invitation for a still-invited user with a fresh link. */
  async resend(actor: AuthContext, userId: string, meta: ClientMeta): Promise<IssuedInvitation> {
    const result = await transaction(async (tx) => {
      const target = await userRepository.findForUpdate(tx, userId);
      if (!target) throw errors.notFound("User");
      if (!canManageUser(actor.user, target.role)) throw errors.forbidden();
      if (target.status !== "INVITED") throw errors.conflict("This user has already accepted an invitation.");

      await invitationRepository.revokeOpenForUser(tx, userId);
      const issued = await issueInvitation(tx, userId, actor.user.id);
      await recordAudit(tx, {
        type: "INVITATION_RESENT",
        actorUserId: actor.user.id,
        targetUserId: userId,
        sessionId: actor.sessionId,
        meta,
        metadata: { invitationId: issued.invitationId },
      });
      return { target, ...issued };
    });

    const url = inviteUrl(result.token);
    await deliver(result.target.email, result.target.name, url);
    return { userId, invitationId: result.invitationId, expiresAt: result.expiresAt, inviteUrl: url };
  },

  async revoke(actor: AuthContext, userId: string, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      const target = await userRepository.findForUpdate(tx, userId);
      if (!target) throw errors.notFound("User");
      if (!canManageUser(actor.user, target.role)) throw errors.forbidden();
      const revoked = await invitationRepository.revokeOpenForUser(tx, userId);
      if (revoked === 0) throw errors.notFound("Open invitation");
      await recordAudit(tx, {
        type: "INVITATION_REVOKED",
        actorUserId: actor.user.id,
        targetUserId: userId,
        sessionId: actor.sessionId,
        meta,
      });
    });
  },

  async inspect(token: string) {
    const invitation = await invitationRepository.findValidByTokenHash(hashToken(token));
    if (!invitation) throw errors.tokenInvalid();
    return invitation;
  },

  /** Consume token + set password + activate + audit, atomically. Does not sign the user in. */
  async accept(input: { token: string; name: string; newPassword: string }, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      const invitation = await invitationRepository.consume(tx, hashToken(input.token));
      if (!invitation) throw errors.tokenInvalid();

      const user = await userRepository.findForUpdate(tx, invitation.userId);
      if (!user || user.status !== "INVITED") throw errors.tokenInvalid();
      assertPasswordPolicy(input.newPassword, { email: user.email, name: input.name });

      const activated = await invitationRepository.activateInvitedUser(tx, user.id, {
        name: input.name,
        passwordHash: await hashPassword(input.newPassword),
      });
      if (!activated) throw errors.tokenInvalid();

      await recordAudit(tx, {
        type: "INVITATION_ACCEPTED",
        actorUserId: user.id,
        targetUserId: user.id,
        meta,
        metadata: { invitationId: invitation.id },
      });
    });
  },
};
