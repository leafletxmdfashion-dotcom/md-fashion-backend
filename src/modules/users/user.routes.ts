import { Router } from "express";

import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import { userController } from "./user.controller";

// Route-level permission gates; object-level rules (hierarchy, last owner,
// self-management) are enforced in the services.
export function userRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  const view = requirePermission("users.view");
  const manage = requirePermission("users.manage");

  router.get("/", view, userController.list);
  router.post("/invitations", manage, userController.invite);

  router.get("/:userId", view, userController.get);
  router.patch("/:userId", manage, userController.update);
  router.put("/:userId/role", manage, userController.changeRole);
  router.post("/:userId/disable", manage, userController.disable);
  router.post("/:userId/enable", manage, userController.enable);
  router.post("/:userId/sessions/revoke", manage, userController.revokeSessions);
  router.post("/:userId/invitation/resend", manage, userController.resendInvitation);
  router.post("/:userId/invitation/revoke", manage, userController.revokeInvitation);

  return router;
}
