import type { Request, RequestHandler } from "express";

import { errors } from "../../lib/errors";
import { clientMeta } from "../../lib/request";
import { invitationService } from "./invitation.service";
import { changeRoleSchema, createInvitationSchema, updateUserSchema, userIdParamsSchema } from "./user.schema";
import { userService } from "./user.service";

function actorOf(req: Request) {
  if (!req.auth) throw errors.unauthenticated();
  return req.auth;
}

function userIdOf(req: Request): string {
  return userIdParamsSchema.parse(req.params).userId;
}

export const userController = {
  list: (async (_req, res) => {
    res.json({ success: true, data: { users: await userService.list() } });
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
    const invitation = await invitationService.create(actorOf(req), input, clientMeta(req));
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ success: true, data: { invitation } });
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
