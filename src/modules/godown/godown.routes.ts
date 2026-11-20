import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { allRows, day, docNumber, EXPORT_MAX, sendCsv } from "../../lib/csv-export";
import { actorOf, clientMeta } from "../../lib/request";
import { queryRows, rowQueryFields, type RowQuery, type RowSpecs } from "../../lib/row-query";
import { heldForApproval } from "../approvals/approvals";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import {
  adjustSchema,
  dispatchListQuerySchema,
  dispatchSchema,
  idParamsSchema,
  lotListQuerySchema,
  movementListQuerySchema,
  reverseSchema,
  type DispatchListQuery,
  type FinishedLotQuery,
  type MovementListQuery,
} from "./godown.schema";
import { godownService } from "./godown.service";

const idOf = (req: Request) => idParamsSchema.parse(req.params).id;

type StockItem = Awaited<ReturnType<typeof godownService.stock>>["items"][number];

const MOVEMENT_LABEL: Record<string, string> = {
  PACKED_IN: "Packed in",
  PACKING_REVERSAL: "Packing reversed",
  DISPATCH: "Dispatched",
  DISPATCH_REVERSAL: "Dispatch reversed",
  ADJUST_IN: "Count: added",
  ADJUST_OUT: "Count: removed",
};

const STAGE_LABEL: Record<string, string> = { production: "In production", packing: "To pack", done: "Finished" };

const inStockSizes = (item: StockItem) => item.sizes.filter((size) => size.balance > 0);

// Column keys match the frontend table's, so the same URL params drive the list and its export.
const STOCK_SPECS: RowSpecs<StockItem> = {
  item: { type: "text", value: (row) => `${row.article.name} ${row.article.code}` },
  sizes: {
    type: "text",
    sortable: false,
    value: (row) =>
      inStockSizes(row)
        .map((size) => ` ${size.size} `)
        .join(""),
  },
  lots: { type: "number", value: (row) => row.lots },
  inProduction: { type: "number", value: (row) => row.inProduction },
  toPack: { type: "number", value: (row) => row.toPack },
  packed: { type: "number", value: (row) => row.packed },
  in: { type: "number", value: (row) => row.in },
  out: { type: "number", value: (row) => row.out },
  dispatched: { type: "number", value: (row) => row.dispatched },
  balance: { type: "number", value: (row) => row.balance },
  lastMovement: { type: "date", value: (row) => day(row.lastMovementAt) },
};
const stockQuerySchema = z.object({
  articleId: z.uuid().optional(),
  // "true": only items with pieces in the godown; left out: every item with lots or stock.
  inStock: z.enum(["true", "false"]).optional(),
  ...rowQueryFields(STOCK_SPECS),
});
const stockHaystack = (row: StockItem) =>
  [row.article.name, row.article.code, ...inStockSizes(row).map((size) => size.size)].join(" ");

async function stockRows(req: Request) {
  // SAFETY: column params are validated by the schema; their keys are dynamic.
  const query = stockQuerySchema.parse(req.query) as RowQuery & { articleId?: string; inStock?: "true" | "false" };
  const data = await godownService.stock({
    articleId: query.articleId,
    inStock: query.inStock,
    page: 1,
    pageSize: EXPORT_MAX + 1,
  });
  return { ...queryRows(data.items, STOCK_SPECS, query, stockHaystack), summary: data.summary };
}

export function godownRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const view = requirePermission("godown.view");
  const manage = requirePermission("godown.manage");

  router.get("/stock", view, (async (req, res) => {
    const { matching, page, total, summary } = await stockRows(req);
    const sum = (key: "inProduction" | "toPack" | "packed" | "dispatched" | "balance") =>
      matching.reduce((acc, row) => acc + row[key], 0);

    res.json({
      success: true,
      data: {
        items: page,
        total,
        summary,
        totals: {
          inProduction: sum("inProduction"),
          toPack: sum("toPack"),
          packed: sum("packed"),
          dispatched: sum("dispatched"),
          balance: sum("balance"),
        },
      },
    });
  }) satisfies RequestHandler);

  router.get("/stock/export", view, (async (req, res) => {
    const { matching } = await stockRows(req);

    sendCsv(
      req,
      res,
      "godown-stock",
      [
        { header: "Item code", value: (row) => row.article.code },
        { header: "Item / design", value: (row) => row.article.name },
        {
          header: "In stock by size",
          value: (row) =>
            inStockSizes(row)
              .map((size) => `${size.size} ${size.balance}`)
              .join(", "),
        },
        { header: "Lots", value: (row) => row.lots },
        { header: "Cut", value: (row) => row.cut },
        { header: "In production", value: (row) => row.inProduction },
        { header: "Good", value: (row) => row.good },
        { header: "Rejected", value: (row) => row.reject },
        { header: "To pack", value: (row) => row.toPack },
        { header: "Packed", value: (row) => row.packed },
        { header: "In", value: (row) => row.in },
        { header: "Out", value: (row) => row.out },
        { header: "Dispatched", value: (row) => row.dispatched },
        { header: "In stock", value: (row) => row.balance },
        { header: "Last movement", value: (row) => day(row.lastMovementAt) },
      ],
      matching,
      (row) => row.article.id,
    );
  }) satisfies RequestHandler);

  router.get("/movements", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = movementListQuerySchema.parse(req.query) as MovementListQuery;

    res.json({ success: true, data: await godownService.movements(query) });
  }) satisfies RequestHandler);

  router.get("/movements/export", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = movementListQuerySchema.parse(req.query) as MovementListQuery;
    const { movements } = await godownService.movements(allRows(query));

    sendCsv(
      req,
      res,
      "godown-movements",
      [
        { header: "Date", value: (m) => m.date },
        { header: "Movement", value: (m) => MOVEMENT_LABEL[m.type] ?? m.type },
        { header: "Item code", value: (m) => m.article.code },
        { header: "Item / design", value: (m) => m.article.name },
        { header: "Size", value: (m) => m.sizeLabel },
        { header: "In", value: (m) => (m.direction === "IN" ? m.quantity : null) },
        { header: "Out", value: (m) => (m.direction === "OUT" ? m.quantity : null) },
        { header: "Lot", value: (m) => m.lotNumber },
        { header: "Reference", value: (m) => m.reference },
        { header: "Reason", value: (m) => m.reason },
        { header: "By", value: (m) => m.createdBy },
      ],
      movements,
      (m) => m.id,
    );
  }) satisfies RequestHandler);

  router.get("/dispatches", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = dispatchListQuerySchema.parse(req.query) as DispatchListQuery;

    res.json({ success: true, data: await godownService.listDispatches(query) });
  }) satisfies RequestHandler);

  router.get("/dispatches/export", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = dispatchListQuerySchema.parse(req.query) as DispatchListQuery;
    const { dispatches } = await godownService.listDispatches(allRows(query));

    sendCsv(
      req,
      res,
      "dispatches",
      [
        { header: "No.", value: (d) => docNumber("DS", d.number) },
        { header: "Date", value: (d) => d.date },
        { header: "Party", value: (d) => d.party },
        { header: "Challan", value: (d) => d.challan },
        { header: "Items", value: (d) => d.items },
        { header: "Pieces", value: (d) => d.pieces },
        { header: "Status", value: (d) => (d.status === "REVERSED" ? "Reversed" : "Dispatched") },
        { header: "By", value: (d) => d.createdBy },
      ],
      dispatches,
      (d) => d.id,
    );
  }) satisfies RequestHandler);

  router.get("/dispatches/:id", view, (async (req, res) => {
    res.json({ success: true, data: { dispatch: await godownService.getDispatch(idOf(req)) } });
  }) satisfies RequestHandler);

  router.get("/parties", view, (async (_req, res) => {
    res.json({ success: true, data: { parties: await godownService.parties() } });
  }) satisfies RequestHandler);

  router.get("/finished-goods", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = lotListQuerySchema.parse(req.query) as FinishedLotQuery;

    res.json({ success: true, data: await godownService.finishedLots(query) });
  }) satisfies RequestHandler);

  router.get("/finished-goods/export", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = lotListQuerySchema.parse(req.query) as FinishedLotQuery;
    const { lots } = await godownService.finishedLots(allRows(query));

    sendCsv(
      req,
      res,
      "finished-goods",
      [
        { header: "Date", value: (l) => day(l.productionDate) },
        { header: "Lot", value: (l) => l.lotNumber },
        { header: "Item / design", value: (l) => l.articleName },
        { header: "Cut", value: (l) => l.cut },
        { header: "Not issued", value: (l) => l.unissued },
        { header: "With teams", value: (l) => l.wip },
        { header: "Good", value: (l) => l.good },
        { header: "Rework", value: (l) => l.rework },
        { header: "Rejected", value: (l) => l.reject },
        { header: "Packed", value: (l) => l.packed },
        { header: "To pack", value: (l) => l.toPack },
        { header: "Last packed", value: (l) => day(l.lastPacked) },
        { header: "Stage", value: (l) => STAGE_LABEL[l.stage] ?? l.stage },
      ],
      lots,
      (l) => l.id,
    );
  }) satisfies RequestHandler);

  router.post("/dispatches", manage, (async (req, res) => {
    const dispatch = await godownService.dispatch(actorOf(req), dispatchSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { dispatch } });
  }) satisfies RequestHandler);

  router.post("/dispatches/:id/reverse", manage, (async (req, res) => {
    const { reason } = reverseSchema.parse(req.body);

    if (await heldForApproval(req, res, { type: "DISPATCH_REVERSAL", targetId: idOf(req), payload: { reason } }))
      return;

    const dispatch = await godownService.reverseDispatch(actorOf(req), idOf(req), reason, clientMeta(req));

    res.json({ success: true, data: { dispatch } });
  }) satisfies RequestHandler);

  router.post("/adjustments", manage, (async (req, res) => {
    const input = adjustSchema.parse(req.body);
    const { articleId, ...rest } = input;

    if (await heldForApproval(req, res, { type: "GODOWN_ADJUSTMENT", targetId: articleId, payload: rest })) return;

    const adjustment = await godownService.adjust(actorOf(req), input, clientMeta(req));

    res.status(201).json({ success: true, data: { adjustment } });
  }) satisfies RequestHandler);

  return router;
}
