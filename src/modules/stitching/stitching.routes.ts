import { Router, type Request, type RequestHandler } from "express";

import { label, REWORK_STATUS_LABEL } from "../../lib/labels";
import { allRows, day, docNumber, sendCsv } from "../../lib/csv-export";
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

  router.get("/issues/export", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = issueListQuerySchema.parse(req.query) as IssueListQuery;
    const money = showMoney(req);
    const { issues } = await stitchingService.listIssues(allRows(query), money);
    type Issue = (typeof issues)[number];

    sendCsv(
      req,
      res,
      "stitching-issues",
      [
        { header: "No.", value: (i: Issue) => docNumber("SI", i.number) },
        { header: "Date", value: (i: Issue) => i.date },
        { header: "Lot", value: (i: Issue) => i.lot.lotNumber },
        { header: "Item / design", value: (i: Issue) => i.lot.articleName },
        { header: "Jogadi", value: (i: Issue) => i.team.name },
        { header: "Work", value: (i: Issue) => i.operation },
        ...(money ? [{ header: "Rate per piece", value: (i: Issue) => i.rate }] : []),
        { header: "Issued", value: (i: Issue) => i.issued },
        { header: "Received", value: (i: Issue) => i.received },
        { header: "With team", value: (i: Issue) => i.wip },
        {
          header: "Status",
          value: (i: Issue) => (i.status === "REVERSED" ? "Reversed" : i.wip > 0 ? "With team" : "Done"),
        },
      ],
      issues,
      (i) => i.id,
    );
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

  router.get("/rework/export", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = reworkListQuerySchema.parse(req.query) as ReworkListQuery;
    const { items } = await stitchingService.listRework(allRows(query));

    sendCsv(
      req,
      res,
      "rework",
      [
        { header: "No.", value: (r) => docNumber("RW", r.number) },
        { header: "Created", value: (r) => day(r.createdAt) },
        { header: "Lot", value: (r) => r.lot.lotNumber },
        { header: "Item / design", value: (r) => r.lot.articleName },
        { header: "Colour", value: (r) => r.colour || "All colours" },
        { header: "Size", value: (r) => r.sizeLabel },
        { header: "Jogadi", value: (r) => r.issue.teamName },
        { header: "Issue", value: (r) => docNumber("SI", r.issue.number) },
        { header: "Receipt", value: (r) => docNumber("SR", r.receiptNumber) },
        { header: "Pieces", value: (r) => r.quantity },
        { header: "Recovered", value: (r) => r.recovered },
        { header: "Failed", value: (r) => r.failed },
        { header: "Pending", value: (r) => r.pending },
        { header: "Assigned to", value: (r) => r.assignedTo?.name },
        { header: "Status", value: (r) => label(REWORK_STATUS_LABEL, r.status) },
      ],
      items,
      (r) => r.id,
    );
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

  router.get("/rejects/export", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = rejectListQuerySchema.parse(req.query) as RejectListQuery;
    const { rejects } = await stitchingService.listRejects(allRows(query));

    sendCsv(
      req,
      res,
      "rejects",
      [
        { header: "Date", value: (r) => day(r.date) },
        { header: "From", value: (r) => (r.source === "RECEIPT" ? "Receipt" : "Rework") },
        { header: "Reference", value: (r) => r.reference },
        { header: "Lot", value: (r) => r.lot.lotNumber },
        { header: "Item / design", value: (r) => r.lot.articleName },
        { header: "Jogadi", value: (r) => r.teamName },
        { header: "Colour", value: (r) => r.colour || "All colours" },
        { header: "Size", value: (r) => r.sizeLabel },
        { header: "Pieces", value: (r) => r.quantity },
        { header: "Reason", value: (r) => r.reason },
      ],
      rejects,
      (r) => r.id,
    );
  }) satisfies RequestHandler);

  return router;
}
