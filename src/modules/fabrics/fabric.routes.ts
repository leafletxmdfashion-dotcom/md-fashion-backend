import { Router } from "express";

import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import { fabricController } from "./fabric.controller";

export function fabricRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  const view = requirePermission("fabric.view");

  router.get("/", view, fabricController.list);

  router.get("/options", view, fabricController.options);
  router.get("/movements", view, fabricController.movements);
  router.get("/movements/export", view, fabricController.exportMovements);

  router.get("/inwards", view, fabricController.inwards);
  router.get("/inwards/export", view, fabricController.exportInwards);
  router.get("/inwards/suppliers", view, fabricController.suppliers);
  router.post("/inwards", requirePermission("fabric.inward"), fabricController.createInward);
  router.post("/inwards/:id/reverse", requirePermission("fabric.reverse"), fabricController.reverseInward);

  router.get("/:id", view, fabricController.get);
  router.put("/:id", requirePermission("fabric.manage"), fabricController.update);
  router.post("/:id/adjustments", requirePermission("fabric.adjust"), fabricController.adjust);

  return router;
}
