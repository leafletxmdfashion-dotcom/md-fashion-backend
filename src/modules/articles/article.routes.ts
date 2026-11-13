import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { actorOf, clientMeta } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import { articleService } from "./article.service";

const idOf = (req: Request) => z.object({ id: z.uuid() }).parse(req.params).id;

const mergeSchema = z.strictObject({
  targetId: z.uuid("Choose the item to keep."),
  sourceIds: z.array(z.uuid()).max(50, "Merge at most 50 items at once."),
});

/**
 * Items / designs. They are created and their cutting defaults saved from the cutting
 * form; the picker lists them, and one typed by mistake is deleted or merged here.
 */
export function articleRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  router.get("/options", requirePermission("production.view"), (async (_req, res) => {
    res.json({ success: true, data: { articles: await articleService.options() } });
  }) satisfies RequestHandler);

  router.delete("/:id", requirePermission("production.manage"), (async (req, res) => {
    await articleService.remove(actorOf(req), idOf(req), clientMeta(req));

    res.json({ success: true, data: null });
  }) satisfies RequestHandler);

  router.post("/merge", requirePermission("production.manage"), (async (req, res) => {
    res.json({ success: true, data: await articleService.merge(actorOf(req), mergeSchema.parse(req.body), clientMeta(req)) });
  }) satisfies RequestHandler);

  return router;
}
