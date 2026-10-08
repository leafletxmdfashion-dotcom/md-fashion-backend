import { Router } from "express";

import type { RateLimiters } from "../../lib/rate-limit";
import { authController } from "./auth.controller";
import { requireAuth } from "./auth.middleware";

// Invitation endpoints take the token in the JSON body rather than the URL path
// (deviation from GET /invitations/:token) so tokens never land in access logs.
export function authRoutes(limiters: RateLimiters): Router {
  const router = Router();

  router.get("/csrf", authController.csrf);
  router.post("/login", limiters.loginByIp, limiters.loginByAccount, authController.login);
  router.post("/logout", authController.logout);
  router.post("/logout-all", requireAuth, authController.logoutAll);

  router.get("/me", requireAuth, authController.me);
  router.patch("/me", requireAuth, authController.updateMe);
  router.post("/change-password", requireAuth, limiters.sensitive, authController.changePassword);

  router.get("/sessions", requireAuth, authController.listSessions);
  router.delete("/sessions/:sessionId", requireAuth, authController.revokeSession);

  router.post("/forgot-password", limiters.forgotByIp, limiters.forgotByAccount, authController.forgotPassword);
  router.post("/reset-password", limiters.tokenByIp, authController.resetPassword);

  router.post("/invitations/inspect", limiters.tokenByIp, authController.inspectInvitation);
  router.post("/invitations/accept", limiters.tokenByIp, authController.acceptInvitation);

  return router;
}
