import { Router, type RequestHandler } from "express";

import type { RateLimiters } from "../../lib/rate-limit";
import { sendCsv } from "../../lib/csv-export";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import { USER_STATUS_LABEL, userController, userStatus } from "./user.controller";

// Route-level permission gates; object-level rules (hierarchy, last owner,
// self-management) are enforced in the services.
export function userRoutes(limiters: RateLimiters): Router {
  const router = Router();
  router.use(requireAuth);

  const view = requirePermission("users.view");
  const manage = requirePermission("users.manage");

  router.get("/", view, userController.list);
  router.get("/export", view, (async (req, res) => {
    const { matching } = await userController.rows(req);

    sendCsv(
      req,
      res,
      "logins",
      [
        { header: "Name", value: (u) => u.name },
        { header: "Email", value: (u) => u.email },
        { header: "Phone", value: (u) => u.phone },
        { header: "Role", value: (u) => u.role.name },
        { header: "Status", value: (u) => USER_STATUS_LABEL[userStatus(u)] },
        { header: "Temporary password", value: (u) => u.mustChangePassword },
        { header: "Staff / karigar", value: (u) => u.linkedTo?.name },
        { header: "Last sign-in", value: (u) => u.lastLoginAt },
        { header: "Active sessions", value: (u) => u.activeSessionCount },
        { header: "Added", value: (u) => u.createdAt },
      ],
      matching,
      (u) => u.id,
    );
  }) satisfies RequestHandler);
  router.post("/invitations", manage, userController.invite);

  router.get("/:userId", view, userController.get);
  router.patch("/:userId", manage, userController.update);
  router.put("/:userId/role", manage, userController.changeRole);
  router.post("/:userId/disable", manage, userController.disable);
  router.post("/:userId/enable", manage, userController.enable);
  router.post("/:userId/sessions/revoke", manage, userController.revokeSessions);
  router.post("/:userId/password", limiters.sensitive, manage, userController.setPassword);
  router.post("/:userId/invitation/resend", manage, userController.resendInvitation);
  router.post("/:userId/invitation/revoke", manage, userController.revokeInvitation);

  return router;
}
