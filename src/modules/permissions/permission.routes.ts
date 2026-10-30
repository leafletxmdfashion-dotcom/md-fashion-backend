import { Router, type RequestHandler } from "express";

import { actorOf, clientMeta } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "./permission.middleware";
import { createRoleSchema, roleKeyParamsSchema, updateRoleSchema } from "./permission.schema";
import { roleService } from "./role.service";

// Route gates only; which roles a user may edit (rank, own rights) is decided in roleService.
export function roleRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const manage = requirePermission("roles.manage");

  router.get("/", requirePermission("users.view"), (async (req, res) => {
    res.json({ success: true, data: await roleService.list(actorOf(req)) });
  }) satisfies RequestHandler);

  router.post("/", manage, (async (req, res) => {
    const role = await roleService.create(actorOf(req), createRoleSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { role } });
  }) satisfies RequestHandler);

  router.put("/:roleKey", manage, (async (req, res) => {
    const { roleKey } = roleKeyParamsSchema.parse(req.params);
    const role = await roleService.update(actorOf(req), roleKey, updateRoleSchema.parse(req.body), clientMeta(req));

    res.json({ success: true, data: { role } });
  }) satisfies RequestHandler);

  router.delete("/:roleKey", manage, (async (req, res) => {
    const { roleKey } = roleKeyParamsSchema.parse(req.params);

    await roleService.remove(actorOf(req), roleKey, clientMeta(req));
    res.json({ success: true, data: null });
  }) satisfies RequestHandler);

  return router;
}
