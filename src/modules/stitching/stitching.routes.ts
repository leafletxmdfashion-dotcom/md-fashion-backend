import { Router, type Request, type RequestHandler } from "express";

import { actorOf, can, clientMeta } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import {
  idParamsSchema,
  issueListQuerySchema,
  issueSchema,
  lotSearchSchema,
  receiptSchema,
  REJECT_REASONS,
  rejectListQuerySchema,
  reverseSchema,
  reworkListQuerySchema,
  reworkResolveSchema,
  reworkUpdateSchema,
  type IssueListQuery,
  type RejectListQuery,
  type ReworkListQuery,
} from "./stitching.schema";
import { stitchingService } from "./stitching.service";

const idOf = (req: Request) => idParamsSchema.parse(req.params).id;

// Rates and earnings are only returned to users who may see money.
const showMoney = (req: Request) => can(req, "costing.view");

export function stitchingRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const view = requirePermission("stitching.view");

  router.get("/reject-reasons", view, (_req, res) => {
    res.json({ success: true, data: { reasons: REJECT_REASONS } });
  });

  router.get("/lots", requirePermission("stitching.issue"), (async (req, res) => {
    const { search } = lotSearchSchema.parse(req.query);

    res.json({ success: true, data: { lots: await stitchingService.availableLots(search) } });
  }) satisfies RequestHandler);

  router.get("/lots/:id/balance", view, (async (req, res) => {
    res.json({ success: true, data: await stitchingService.lotBalance(idOf(req)) });
  }) satisfies RequestHandler);

  router.get("/issues", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = issueListQuerySchema.parse(req.query) as IssueListQuery;

    res.json({ success: true, data: await stitchingService.listIssues(query, showMoney(req)) });
  }) satisfies RequestHandler);

  router.get("/issues/:id", view, (async (req, res) => {
    res.json({ success: true, data: { issue: await stitchingService.getIssue(idOf(req), showMoney(req)) } });
  }) satisfies RequestHandler);

  router.post("/issues", requirePermission("stitching.issue"), (async (req, res) => {
    const issues = await stitchingService.issue(actorOf(req), issueSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { issues } });
  }) satisfies RequestHandler);

  router.post("/issues/:id/reverse", requirePermission("stitching.reverse"), (async (req, res) => {
    const { reason } = reverseSchema.parse(req.body);
    const issue = await stitchingService.reverseIssue(actorOf(req), idOf(req), reason, clientMeta(req));

    res.json({ success: true, data: { issue } });
  }) satisfies RequestHandler);

  router.post("/issues/:id/receipts", requirePermission("stitching.receive"), (async (req, res) => {
    const issue = await stitchingService.receive(
      actorOf(req),
      idOf(req),
      receiptSchema.parse(req.body),
      clientMeta(req),
    );

    res.status(201).json({ success: true, data: { issue } });
  }) satisfies RequestHandler);

  router.post("/receipts/:id/reverse", requirePermission("stitching.reverse"), (async (req, res) => {
    const { reason } = reverseSchema.parse(req.body);
    const issue = await stitchingService.reverseReceipt(actorOf(req), idOf(req), reason, clientMeta(req));

    res.json({ success: true, data: { issue } });
  }) satisfies RequestHandler);

  router.get("/rework", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = reworkListQuerySchema.parse(req.query) as ReworkListQuery;

    res.json({ success: true, data: await stitchingService.listRework(query) });
  }) satisfies RequestHandler);

  router.put("/rework/:id", requirePermission("stitching.rework"), (async (req, res) => {
    await stitchingService.updateRework(actorOf(req), idOf(req), reworkUpdateSchema.parse(req.body), clientMeta(req));

    res.json({ success: true, data: null });
  }) satisfies RequestHandler);

  router.post("/rework/:id/resolve", requirePermission("stitching.rework"), (async (req, res) => {
    await stitchingService.resolveRework(actorOf(req), idOf(req), reworkResolveSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: null });
  }) satisfies RequestHandler);

  router.get("/rejects", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = rejectListQuerySchema.parse(req.query) as RejectListQuery;

    res.json({ success: true, data: await stitchingService.listRejects(query) });
  }) satisfies RequestHandler);

  return router;
}
