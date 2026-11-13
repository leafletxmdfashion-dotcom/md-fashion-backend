import type { Request, RequestHandler } from "express";

import { z } from "zod";

import { errors } from "../../lib/errors";
import { clientMeta } from "../../lib/request";
import { queryRows, rowQueryFields, type RowQuery, type RowSpecs } from "../../lib/row-query";
import { invitationService } from "./invitation.service";
import {
  changeRoleSchema,
  createInvitationSchema,
  setPasswordSchema,
  updateUserSchema,
  userIdParamsSchema,
} from "./user.schema";
import { userService } from "./user.service";
import type { ManagedUserDto } from "./user.types";

function actorOf(req: Request) {
  if (!req.auth) throw errors.unauthenticated();
  return req.auth;
}

function userIdOf(req: Request): string {
  return userIdParamsSchema.parse(req.params).userId;
}

/** What the Users table shows: an invitation past its expiry reads "Invite expired". */
export function userStatus(user: ManagedUserDto): "ACTIVE" | "INVITED" | "EXPIRED" | "LOCKED" | "DISABLED" {
  if (user.status === "INVITED") return !user.invitation || user.invitation.expired ? "EXPIRED" : "INVITED";
  return user.status;
}

export const USER_STATUS_LABEL = {
  ACTIVE: "Active",
  INVITED: "Invited",
  EXPIRED: "Invite expired",
  LOCKED: "Locked",
  DISABLED: "Disabled",
} as const;

// Column keys match the frontend table's, so the same URL params drive the list and its export.
const USER_SPECS: RowSpecs<ManagedUserDto> = {
  name: { type: "text", value: (u) => [u.name, u.email, u.phone].filter(Boolean).join(" ") },
  role: { type: "enum", value: (u) => u.role.key, sortValue: (u) => u.role.rank },
  status: {
    type: "enum",
    values: Object.keys(USER_STATUS_LABEL),
    value: (u) => userStatus(u),
    sortValue: (u) => USER_STATUS_LABEL[userStatus(u)],
  },
  linked: {
    type: "enum",
    values: ["linked", "unlinked"],
    sortable: false,
    value: (u) => (u.linkedTo ? "linked" : "unlinked"),
  },
  lastLogin: { type: "date", value: (u) => (u.lastLoginAt ? u.lastLoginAt.toISOString() : null) },
};
const userQuerySchema = z.object(rowQueryFields(USER_SPECS));

export const userController = {
  /** Every user matching the request's search, filters and sort (and the requested page). */
  async rows(req: Request) {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = userQuerySchema.parse(req.query) as RowQuery;
    const users = await userService.list();
    return queryRows(users, USER_SPECS, query, (u) =>
      [u.name, u.email, u.phone, u.linkedTo?.name].filter(Boolean).join(" "),
    );
  },

  list: (async (req, res) => {
    const { page, total } = await userController.rows(req);
    res.json({ success: true, data: { users: page, total } });
  }) satisfies RequestHandler,

  get: (async (req, res) => {
    res.json({ success: true, data: { user: await userService.get(userIdOf(req)) } });
  }) satisfies RequestHandler,

  update: (async (req, res) => {
    const input = updateUserSchema.parse(req.body);
    await userService.updateProfile(actorOf(req), userIdOf(req), input, clientMeta(req));
    res.json({ success: true, data: null });
  }) satisfies RequestHandler,

  changeRole: (async (req, res) => {
    const { roleKey } = changeRoleSchema.parse(req.body);
    await userService.changeRole(actorOf(req), userIdOf(req), roleKey, clientMeta(req));
    res.json({ success: true, data: null });
  }) satisfies RequestHandler,

  disable: (async (req, res) => {
    await userService.disable(actorOf(req), userIdOf(req), clientMeta(req));
    res.json({ success: true, data: null });
  }) satisfies RequestHandler,

  enable: (async (req, res) => {
    await userService.enable(actorOf(req), userIdOf(req), clientMeta(req));
    res.json({ success: true, data: null });
  }) satisfies RequestHandler,

  revokeSessions: (async (req, res) => {
    const revoked = await userService.revokeSessions(actorOf(req), userIdOf(req), clientMeta(req));
    res.json({ success: true, data: { revokedSessions: revoked } });
  }) satisfies RequestHandler,

  invite: (async (req, res) => {
    const input = createInvitationSchema.parse(req.body);
    const login = await invitationService.create(actorOf(req), input, clientMeta(req));
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ success: true, data: { login, invitation: login.invitation } });
  }) satisfies RequestHandler,

  setPassword: (async (req, res) => {
    const { password } = setPasswordSchema.parse(req.body);
    await userService.setPassword(actorOf(req), userIdOf(req), password, clientMeta(req));
    res.json({ success: true, data: { mustChangePassword: true } });
  }) satisfies RequestHandler,

  resendInvitation: (async (req, res) => {
    const invitation = await invitationService.resend(actorOf(req), userIdOf(req), clientMeta(req));
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data: { invitation } });
  }) satisfies RequestHandler,

  revokeInvitation: (async (req, res) => {
    await invitationService.revoke(actorOf(req), userIdOf(req), clientMeta(req));
    res.json({ success: true, data: null });
  }) satisfies RequestHandler,
};
