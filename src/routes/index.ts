import { Router } from "express";

import type { RateLimiters } from "../lib/rate-limit";
import { loadSession, requirePasswordChanged } from "../modules/auth/auth.middleware";
import { authRoutes } from "../modules/auth/auth.routes";
import { csrfProtection } from "../modules/auth/csrf";
import { articleRoutes } from "../modules/articles/article.routes";
import { auditRoutes } from "../modules/audit/audit.routes";
import { cuttingRoutes, lotRoutes } from "../modules/cutting/cutting.routes";
import { dashboardRoutes } from "../modules/dashboard/dashboard";
import { fabricRoutes } from "../modules/fabrics/fabric.routes";
import { accessRoutes } from "../modules/permissions/access";
import { teamRoutes } from "../modules/teams/teams";
import { karigarRoutes } from "../modules/karigars/karigar.routes";
import { godownRoutes } from "../modules/godown/godown.routes";
import { packingRoutes } from "../modules/packing/packing.routes";
import { paymentsRoutes } from "../modules/payments/payments.routes";
import { roleRoutes } from "../modules/permissions/permission.routes";
import { settingsRoutes } from "../modules/settings/settings";
import { costingRoutes } from "../modules/costing/costing";
import { approvalRoutes } from "../modules/approvals/approvals";
import { reportRoutes } from "../modules/reports/reports";
import { stitchingRoutes } from "../modules/stitching/stitching.routes";
import { userRoutes } from "../modules/users/user.routes";

export function apiRouter(limiters: RateLimiters): Router {
  const router = Router();

  // Order matters: throttle before touching the DB, resolve the session, then
  // CSRF (its expected token depends on whether a session exists).
  router.use(limiters.api);
  router.use(loadSession);
  router.use(csrfProtection);
  router.use(requirePasswordChanged);

  router.get("/", (_req, res) => {
    res.json({ success: true, data: { name: "Garment Management API" } });
  });

  router.use("/auth", authRoutes(limiters));
  router.use("/users", userRoutes(limiters));
  router.use("/roles", roleRoutes());
  router.use("/access", accessRoutes());
  router.use("/audit-events", auditRoutes());
  router.use("/dashboard", dashboardRoutes());
  router.use("/fabrics", fabricRoutes());
  router.use("/karigars", karigarRoutes());
  router.use("/articles", articleRoutes());
  router.use("/production-lots", lotRoutes());
  router.use("/cutting-batches", cuttingRoutes());
  router.use("/teams", teamRoutes());
  router.use("/stitching", stitchingRoutes());
  router.use("/packing", packingRoutes());
  router.use("/godown", godownRoutes());
  router.use("/payments", paymentsRoutes());
  router.use("/settings", settingsRoutes());
  router.use("/costing", costingRoutes());
  router.use("/approvals", approvalRoutes());
  router.use("/reports", reportRoutes());

  return router;
}
