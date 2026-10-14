import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { actorOf, clientMeta } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import { articleListQuerySchema, articleSchema, sizeTemplateSchema, type ArticleListQuery } from "./article.schema";
import { articleService, sizeTemplateService } from "./article.service";

const idOf = (req: Request) => z.object({ id: z.uuid() }).parse(req.params).id;

/** Items / designs. */
export function articleRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const view = requirePermission("production.view");
  const manage = requirePermission("production.manage");

  router.get("/", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = articleListQuerySchema.parse(req.query) as ArticleListQuery;

    res.json({ success: true, data: await articleService.list(query) });
  }) satisfies RequestHandler);

  router.get("/options", view, (async (_req, res) => {
    res.json({ success: true, data: { articles: await articleService.options() } });
  }) satisfies RequestHandler);

  router.get("/:id", view, (async (req, res) => {
    res.json({ success: true, data: { article: await articleService.get(idOf(req)) } });
  }) satisfies RequestHandler);

  router.post("/", manage, (async (req, res) => {
    const article = await articleService.create(actorOf(req), articleSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { article } });
  }) satisfies RequestHandler);

  router.put("/:id", manage, (async (req, res) => {
    const article = await articleService.update(actorOf(req), idOf(req), articleSchema.parse(req.body), clientMeta(req));

    res.json({ success: true, data: { article } });
  }) satisfies RequestHandler);

  return router;
}

export function sizeTemplateRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const manage = requirePermission("production.manage");

  router.get("/", requirePermission("production.view"), (async (_req, res) => {
    res.json({ success: true, data: { templates: await sizeTemplateService.list() } });
  }) satisfies RequestHandler);

  router.post("/", manage, (async (req, res) => {
    const template = await sizeTemplateService.save(actorOf(req), null, sizeTemplateSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { template } });
  }) satisfies RequestHandler);

  router.put("/:id", manage, (async (req, res) => {
    const template = await sizeTemplateService.save(
      actorOf(req),
      idOf(req),
      sizeTemplateSchema.parse(req.body),
      clientMeta(req),
    );

    res.json({ success: true, data: { template } });
  }) satisfies RequestHandler);

  router.delete("/:id", manage, (async (req, res) => {
    await sizeTemplateService.remove(actorOf(req), idOf(req), clientMeta(req));

    res.json({ success: true, data: null });
  }) satisfies RequestHandler);

  return router;
}
