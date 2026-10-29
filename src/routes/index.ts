import { Router } from "express";

import type { RateLimiters } from "../lib/rate-limit";
import { loadSession } from "../modules/auth/auth.middleware";
import { authRoutes } from "../modules/auth/auth.routes";
import { csrfProtection } from "../modules/auth/csrf";
import { articleRoutes } from "../modules/articles/article.routes";
import { cuttingRoutes, lotRoutes } from "../modules/cutting/cutting.routes";
import { fabricRoutes } from "../modules/fabrics/fabric.routes";
import { jogadiRoutes } from "../modules/jogadi/jogadi";
import { karigarRoutes } from "../modules/karigars/karigar.routes";
import { roleRoutes } from "../modules/permissions/permission.routes";
import { stitchingRoutes } from "../modules/stitching/stitching.routes";
import { userRoutes } from "../modules/users/user.routes";

export function apiRouter(limiters: RateLimiters): Router {
  const router = Router();

  // Order matters: throttle before touching the DB, resolve the session, then
  // CSRF (its expected token depends on whether a session exists).
  router.use(limiters.api);
  router.use(loadSession);
  router.use(csrfProtection);

  router.get("/", (_req, res) => {
    res.json({ success: true, data: { name: "Garment Management API" } });
  });

  router.use("/auth", authRoutes(limiters));
  router.use("/users", userRoutes());
  router.use("/roles", roleRoutes());
  router.use("/fabrics", fabricRoutes());
  router.use("/karigars", karigarRoutes());
  router.use("/articles", articleRoutes());
  router.use("/production-lots", lotRoutes());
  router.use("/cutting-batches", cuttingRoutes());
  router.use("/jogadi", jogadiRoutes());
  router.use("/stitching", stitchingRoutes());

  return router;
}
