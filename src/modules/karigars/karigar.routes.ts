import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { actorOf, can, clientMeta } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import { karigarListQuerySchema, karigarOptionsQuerySchema, karigarSchema, type KarigarListQuery } from "./karigar.schema";
import { karigarService } from "./karigar.service";

const idOf = (req: Request) => z.object({ id: z.uuid() }).parse(req.params).id;

const showPay = (req: Request) => can(req, "costing.view") || can(req, "karigar.manage");

export function karigarRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const manage = requirePermission("karigar.manage");

  router.get("/", requirePermission("karigar.view"), (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = karigarListQuerySchema.parse(req.query) as KarigarListQuery;

    res.json({ success: true, data: await karigarService.list(query, showPay(req)) });
  }) satisfies RequestHandler);

  // Pickers on production forms (e.g. the cutting master), so production users can choose workers.
  router.get("/options", requirePermission("production.view"), (async (req, res) => {
    const { category } = karigarOptionsQuerySchema.parse(req.query);

    res.json({ success: true, data: { karigars: await karigarService.options(category) } });
  }) satisfies RequestHandler);

  router.get("/:id", requirePermission("karigar.view"), (async (req, res) => {
    res.json({ success: true, data: { karigar: await karigarService.get(idOf(req), showPay(req)) } });
  }) satisfies RequestHandler);

  router.post("/", manage, (async (req, res) => {
    const karigar = await karigarService.create(actorOf(req), karigarSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { karigar } });
  }) satisfies RequestHandler);

  router.put("/:id", manage, (async (req, res) => {
    const karigar = await karigarService.update(actorOf(req), idOf(req), karigarSchema.parse(req.body), clientMeta(req));

    res.json({ success: true, data: { karigar } });
  }) satisfies RequestHandler);

  return router;
}
