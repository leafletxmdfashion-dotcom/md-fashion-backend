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

/** A new login: invited by link (the person sets the password) or given a password by the admin. */
export interface NewLoginInput {
  name: string;
  email: string | null;
  phone: string | null;
  roleKey: string;
  mode: "INVITE" | "PASSWORD";
  /** Required for PASSWORD; the person must change it at the first sign-in. */
  password?: string | undefined;
}

/** Checked and hashed outside the transaction (Argon2 is slow); `createInTx` writes it. */
export interface PreparedLogin {
  input: NewLoginInput;
  role: { id: string; key: string };
  passwordHash: string | null;
}

export interface CreatedLogin {
  userId: string;
  mode: NewLoginInput["mode"];
  /** Only for INVITE. */
  invitation: IssuedInvitation | null;
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

async function deliver(email: string | null, name: string, url: string): Promise<void> {
  // Phone-only logins get the link from the admin (shown once in the response).
  if (!email) return;

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

/** Password policy for a password an admin chooses for someone; errors name the `password` field. */
export function assertChosenPassword(
  password: string,
  context: { email: string | null; phone: string | null; name: string },
): void {
  try {
    assertPasswordPolicy(password, context);
  } catch (error) {
    if (error instanceof AppError && error.details?.newPassword) {
      throw new AppError(error.status, error.code, error.message, { password: error.details.newPassword });
    }
    throw error;
  }
}

const taken = (field: "email" | "phone") =>
  new AppError(409, ErrorCode.CONFLICT, `A login with this ${field} already exists.`, {
    [field]: [`A login with this ${field} already exists.`],
  });

export const invitationService = {
  /** Role and hierarchy checks plus password policy and hashing, before any transaction. */
  async prepare(actor: AuthContext, input: NewLoginInput): Promise<PreparedLogin> {
    if (!input.email && !input.phone) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Enter an email or a phone number.", {
        email: ["Enter an email or a phone number."],
      });
    }

    const role = await permissionRepository.findRoleByKey(prisma, input.roleKey);
    if (!role) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Unknown role.", { roleKey: ["Unknown role."] });
    }
    if (!canAssignRole(actor.user, role)) throw errors.forbidden();

    let passwordHash: string | null = null;

    if (input.mode === "PASSWORD") {
      if (!input.password) {
        throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Enter a password.", { password: ["Enter a password."] });
      }
      assertChosenPassword(input.password, input);
      passwordHash = await hashPassword(input.password);
    }

    return { input, role: { id: role.id, key: role.key }, passwordHash };
  },

  /** Writes the user (and invitation) inside the caller's transaction. Mail goes out after commit via `notify`. */
  async createInTx(tx: Db, actor: AuthContext, prepared: PreparedLogin, meta: ClientMeta): Promise<CreatedLogin> {
    const { input, role, passwordHash } = prepared;

    if (input.email && (await userRepository.loginExists(tx, { email: input.email }))) throw taken("email");
    if (input.phone && (await userRepository.loginExists(tx, { phone: input.phone }))) throw taken("phone");

    const userId = await userRepository.createLogin(tx, {
      email: input.email,
      phone: input.phone,
      name: input.name,
      roleId: role.id,
      createdBy: actor.user.id,
      passwordHash,
    });

    if (input.mode === "PASSWORD") {
      await recordAudit(tx, {
        type: "USER_CREATED",
        actorUserId: actor.user.id,
        targetUserId: userId,
        sessionId: actor.sessionId,
        meta,
        metadata: { role: role.key, mode: "PASSWORD", mustChangePassword: true },
      });
      return { userId, mode: "PASSWORD", invitation: null };
    }

    const issued = await issueInvitation(tx, userId, actor.user.id);
    await recordAudit(tx, {
      type: "INVITATION_CREATED",
      actorUserId: actor.user.id,
      targetUserId: userId,
      sessionId: actor.sessionId,
      meta,
      metadata: { invitationId: issued.invitationId, role: role.key },
    });
    return {
      userId,
      mode: "INVITE",
      invitation: {
        userId,
        invitationId: issued.invitationId,
        expiresAt: issued.expiresAt,
        inviteUrl: inviteUrl(issued.token),
      },
    };
  },

  /** After commit: emails the invitation link when the login has an email. */
  async notify(created: CreatedLogin, input: NewLoginInput): Promise<void> {
    if (created.invitation) await deliver(input.email, input.name, created.invitation.inviteUrl);
  },

  async create(actor: AuthContext, input: NewLoginInput, meta: ClientMeta): Promise<CreatedLogin> {
    const prepared = await invitationService.prepare(actor, input);

    try {
      const created = await transaction((tx) => invitationService.createInTx(tx, actor, prepared, meta));
      await invitationService.notify(created, input);
      return created;
    } catch (error) {
      // A concurrent create for the same email or phone loses on the unique constraint.
      if (isUniqueViolation(error)) throw errors.conflict("A login with this email or phone already exists.");
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
      assertPasswordPolicy(input.newPassword, { email: user.email, phone: user.phone, name: input.name });

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
