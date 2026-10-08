import { Router, type RequestHandler } from "express";

import { errors } from "../../lib/errors";
import { clientMeta } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission, requireRole } from "./permission.middleware";
import { roleKeyParamsSchema, updateRolePermissionsSchema } from "./permission.schema";
import { OWNER_ROLE } from "./permission.types";
import { roleService } from "./role.service";

const list: RequestHandler = async (req, res) => {
  if (!req.auth) throw errors.unauthenticated();
  res.json({ success: true, data: { roles: await roleService.list(req.auth) } });
};

const updatePermissions: RequestHandler = async (req, res) => {
  if (!req.auth) throw errors.unauthenticated();
  const { roleKey } = roleKeyParamsSchema.parse(req.params);
  const { permissions } = updateRolePermissionsSchema.parse(req.body);
  const role = await roleService.updatePermissions(req.auth, roleKey, permissions, clientMeta(req));
  res.json({ success: true, data: { role } });
};

export function roleRoutes(): Router {
  const router = Router();
  router.use(requireAuth);
  router.get("/", requirePermission("users.view"), list);
  // Changing what a role can do is an owner-level decision.
  router.put("/:roleKey/permissions", requireRole(OWNER_ROLE), requirePermission("settings.manage"), updatePermissions);
  return router;
}
