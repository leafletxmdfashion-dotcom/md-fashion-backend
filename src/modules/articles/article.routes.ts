import { Router, type RequestHandler } from "express";

import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import { articleService } from "./article.service";

/**
 * Items / designs. They are created and their cutting defaults saved from the cutting
 * form, so the only route is the picker list it suggests from.
 */
export function articleRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  router.get("/options", requirePermission("production.view"), (async (_req, res) => {
    res.json({ success: true, data: { articles: await articleService.options() } });
  }) satisfies RequestHandler);

  return router;
}
