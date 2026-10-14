import { Router, type Request, type RequestHandler } from "express";

import { actorOf, can, clientMeta } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import {
  batchListQuerySchema,
  createLotSchema,
  cuttingDraftSchema,
  idParamsSchema,
  lotListQuerySchema,
  previewSchema,
  reverseSchema,
  updateLotSchema,
  type BatchListQuery,
  type LotListQuery,
} from "./cutting.schema";
import { cuttingService, lotService } from "./cutting.service";

const idOf = (req: Request) => idParamsSchema.parse(req.params).id;

// Fabric cost, labour cost and earnings are only returned to users with costing.view.
const showCost = (req: Request) => can(req, "costing.view");

export function lotRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const view = requirePermission("production.view");
  const manage = requirePermission("production.manage");

  router.get("/", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = lotListQuerySchema.parse(req.query) as LotListQuery;

    res.json({ success: true, data: await lotService.list(query) });
  }) satisfies RequestHandler);

  router.get("/:id", view, (async (req, res) => {
    res.json({ success: true, data: { lot: await lotService.get(idOf(req), showCost(req)) } });
  }) satisfies RequestHandler);

  router.post("/", manage, (async (req, res) => {
    const data = await lotService.create(actorOf(req), createLotSchema.parse(req.body), clientMeta(req), showCost(req));

    res.status(201).json({ success: true, data });
  }) satisfies RequestHandler);

  router.patch("/:id", manage, (async (req, res) => {
    const lot = await lotService.update(actorOf(req), idOf(req), updateLotSchema.parse(req.body), clientMeta(req), showCost(req));

    res.json({ success: true, data: { lot } });
  }) satisfies RequestHandler);

  router.post("/:id/cutting-batches", manage, (async (req, res) => {
    const batch = await cuttingService.create(
      actorOf(req),
      idOf(req),
      cuttingDraftSchema.parse(req.body),
      clientMeta(req),
      showCost(req),
    );

    res.status(201).json({ success: true, data: { batch } });
  }) satisfies RequestHandler);

  return router;
}

export function cuttingRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const view = requirePermission("production.view");

  router.get("/", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = batchListQuerySchema.parse(req.query) as BatchListQuery;

    res.json({ success: true, data: await cuttingService.list(query) });
  }) satisfies RequestHandler);

  // Server-side recalculation of an unsaved draft, plus the store check for what it would issue.
  router.post("/preview", view, (async (req, res) => {
    res.json({ success: true, data: await cuttingService.preview(previewSchema.parse(req.body)) });
  }) satisfies RequestHandler);

  router.get("/:id", view, (async (req, res) => {
    res.json({ success: true, data: { batch: await cuttingService.get(idOf(req), showCost(req)) } });
  }) satisfies RequestHandler);

  router.put("/:id", requirePermission("production.manage"), (async (req, res) => {
    const batch = await cuttingService.save(
      actorOf(req),
      idOf(req),
      cuttingDraftSchema.parse(req.body),
      clientMeta(req),
      showCost(req),
    );

    res.json({ success: true, data: { batch } });
  }) satisfies RequestHandler);

  router.delete("/:id", requirePermission("production.manage"), (async (req, res) => {
    await cuttingService.remove(actorOf(req), idOf(req), clientMeta(req));

    res.json({ success: true, data: null });
  }) satisfies RequestHandler);

  router.post("/:id/issue", requirePermission("cutting.issue"), (async (req, res) => {
    const batch = await cuttingService.issue(actorOf(req), idOf(req), clientMeta(req), showCost(req));

    res.status(201).json({ success: true, data: { batch } });
  }) satisfies RequestHandler);

  router.post("/:id/finalize", requirePermission("cutting.finalize"), (async (req, res) => {
    const batch = await cuttingService.finalize(actorOf(req), idOf(req), clientMeta(req), showCost(req));

    res.status(201).json({ success: true, data: { batch } });
  }) satisfies RequestHandler);

  router.post("/:id/reverse", requirePermission("cutting.reverse"), (async (req, res) => {
    const { reason } = reverseSchema.parse(req.body);
    const batch = await cuttingService.reverse(actorOf(req), idOf(req), reason, clientMeta(req), showCost(req));

    res.status(201).json({ success: true, data: { batch } });
  }) satisfies RequestHandler);

  return router;
}
