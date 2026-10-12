import type { Request, RequestHandler, Response } from "express";

import { errors } from "../../lib/errors";
import { clientMeta } from "../../lib/request";
import { toCsv } from "../../lib/list-query";
import {
  adjustmentSchema,
  bulkStatusSchema,
  createFabricSchema,
  createInwardSchema,
  fabricListQuerySchema,
  idParamsSchema,
  importFabricsSchema,
  inwardListQuerySchema,
  movementListQuerySchema,
  reverseInwardSchema,
  updateFabricSchema,
  type FabricListQuery,
  type InwardListQuery,
  type MovementListQuery,
} from "./fabric.schema";
import { fabricService, inwardService } from "./fabric.service";

function actorOf(req: Request) {
  if (!req.auth) throw errors.unauthenticated();
  return req.auth;
}

function idOf(req: Request): string {
  return idParamsSchema.parse(req.params).id;
}

// ponytail: exports are capped and built in memory; stream with a cursor if they ever need to be larger.
const EXPORT_LIMIT = 10_000;

function sendCsv(res: Response, name: string, header: string[], rows: (string | number | null)[][]) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${stamp}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  // BOM so spreadsheet apps read the file as UTF-8.
  res.send(`\uFEFF${toCsv(header, rows)}`);
}

// Column params are validated by the schema; their keys are dynamic, hence the casts.
const fabricQuery = (req: Request) => fabricListQuerySchema.parse(req.query) as FabricListQuery;
const inwardQuery = (req: Request) => inwardListQuerySchema.parse(req.query) as InwardListQuery;
const movementQuery = (req: Request) => movementListQuerySchema.parse(req.query) as MovementListQuery;

export const fabricController = {
  list: (async (req, res) => {
    res.json({ success: true, data: await fabricService.list(fabricQuery(req)) });
  }) satisfies RequestHandler,

  exportCsv: (async (req, res) => {
    const { fabrics } = await fabricService.list({ ...fabricQuery(req), page: 1, pageSize: EXPORT_LIMIT });
    sendCsv(
      res,
      "fabrics",
      [
        "Code",
        "Name",
        "Category",
        "Unit",
        "In stock",
        "Reorder at",
        "Avg rate",
        "Stock value",
        "Status",
        "Description",
      ],
      fabrics.map((f) => [
        f.code,
        f.name,
        f.category,
        f.unit,
        f.balance,
        f.lowStockThreshold,
        f.avgRate === null ? null : Math.round(f.avgRate * 100) / 100,
        f.stockValue,
        f.isActive ? "Active" : "Inactive",
        f.description,
      ]),
    );
  }) satisfies RequestHandler,

  bulkStatus: (async (req, res) => {
    const { ids, isActive } = bulkStatusSchema.parse(req.body);
    const updated = await fabricService.setActive(actorOf(req), ids, isActive, clientMeta(req));
    res.json({ success: true, data: { updated } });
  }) satisfies RequestHandler,

  importFabrics: (async (req, res) => {
    const { rows } = importFabricsSchema.parse(req.body);
    const created = await fabricService.importFabrics(actorOf(req), rows, clientMeta(req));
    res.status(201).json({ success: true, data: { created } });
  }) satisfies RequestHandler,

  categories: (async (_req, res) => {
    res.json({ success: true, data: { categories: await fabricService.categories() } });
  }) satisfies RequestHandler,

  options: (async (_req, res) => {
    res.json({ success: true, data: { fabrics: await fabricService.options() } });
  }) satisfies RequestHandler,

  get: (async (req, res) => {
    res.json({ success: true, data: { fabric: await fabricService.get(idOf(req)) } });
  }) satisfies RequestHandler,

  create: (async (req, res) => {
    const fabric = await fabricService.create(actorOf(req), createFabricSchema.parse(req.body), clientMeta(req));
    res.status(201).json({ success: true, data: { fabric } });
  }) satisfies RequestHandler,

  update: (async (req, res) => {
    const fabric = await fabricService.update(
      actorOf(req),
      idOf(req),
      updateFabricSchema.parse(req.body),
      clientMeta(req),
    );
    res.json({ success: true, data: { fabric } });
  }) satisfies RequestHandler,

  adjust: (async (req, res) => {
    await fabricService.adjust(actorOf(req), idOf(req), adjustmentSchema.parse(req.body), clientMeta(req));
    res.status(201).json({ success: true, data: null });
  }) satisfies RequestHandler,

  movements: (async (req, res) => {
    const query = movementQuery(req);
    const range = { from: query.dateFrom as string | undefined, to: query.dateTo as string | undefined };
    const [page, summary] = await Promise.all([
      fabricService.listMovements(query),
      query.fabricId ? fabricService.ledgerSummary(query.fabricId, range) : null,
    ]);
    res.json({ success: true, data: { ...page, summary } });
  }) satisfies RequestHandler,

  exportMovements: (async (req, res) => {
    const { movements } = await fabricService.listMovements({ ...movementQuery(req), page: 1, pageSize: EXPORT_LIMIT });
    sendCsv(
      res,
      "fabric-ledger",
      [
        "Date",
        "Movement",
        "Fabric code",
        "Fabric",
        "Unit",
        "In",
        "Out",
        "Balance",
        "Colour",
        "Roll",
        "Reference",
        "Reason",
        "By",
      ],
      movements.map((m) => [
        m.date,
        m.type,
        m.fabric.code,
        m.fabric.name,
        m.fabric.unit,
        m.qtyIn || null,
        m.qtyOut || null,
        m.balance,
        m.color,
        m.rollRef,
        m.inward ? `FI-${String(m.inward.number).padStart(4, "0")}` : null,
        m.reason,
        m.createdBy,
      ]),
    );
  }) satisfies RequestHandler,

  inwards: (async (req, res) => {
    res.json({ success: true, data: await inwardService.list(inwardQuery(req)) });
  }) satisfies RequestHandler,

  exportInwards: (async (req, res) => {
    const { inwards } = await inwardService.list({ ...inwardQuery(req), page: 1, pageSize: EXPORT_LIMIT });
    sendCsv(
      res,
      "fabric-purchases",
      [
        "No.",
        "Date",
        "Fabric code",
        "Fabric",
        "Unit",
        "Quantity",
        "Rate",
        "Amount",
        "Supplier",
        "Invoice",
        "Colour",
        "Roll",
        "Status",
        "Notes",
      ],
      inwards.map((i) => [
        `FI-${String(i.number).padStart(4, "0")}`,
        i.inwardDate,
        i.fabric.code,
        i.fabric.name,
        i.fabric.unit,
        i.quantity,
        i.rate,
        i.amount,
        i.supplier,
        i.invoiceRef,
        i.color,
        i.rollRef,
        i.reversal ? "Reversed" : "Posted",
        i.notes,
      ]),
    );
  }) satisfies RequestHandler,

  suppliers: (async (_req, res) => {
    res.json({ success: true, data: { suppliers: await inwardService.suppliers() } });
  }) satisfies RequestHandler,

  createInward: (async (req, res) => {
    const inward = await inwardService.create(actorOf(req), createInwardSchema.parse(req.body), clientMeta(req));
    res.status(201).json({ success: true, data: { inward } });
  }) satisfies RequestHandler,

  reverseInward: (async (req, res) => {
    const { reason } = reverseInwardSchema.parse(req.body);
    const inward = await inwardService.reverse(actorOf(req), idOf(req), reason, clientMeta(req));
    res.json({ success: true, data: { inward } });
  }) satisfies RequestHandler,
};
