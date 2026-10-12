import { Router } from "express";

import type { RateLimiters } from "../lib/rate-limit";
import { loadSession } from "../modules/auth/auth.middleware";
import { authRoutes } from "../modules/auth/auth.routes";
import { csrfProtection } from "../modules/auth/csrf";
import { fabricRoutes } from "../modules/fabrics/fabric.routes";
import { roleRoutes } from "../modules/permissions/permission.routes";
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

  return router;
}
