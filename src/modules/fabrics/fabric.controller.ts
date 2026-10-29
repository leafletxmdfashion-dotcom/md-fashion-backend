import type { Request, RequestHandler, Response } from "express";

import { factoryToday } from "../../lib/business-date";
import { errors } from "../../lib/errors";
import { can, clientMeta } from "../../lib/request";
import { toCsv } from "../../lib/list-query";
import {
  adjustmentSchema,
  createInwardSchema,
  fabricListQuerySchema,
  idParamsSchema,
  inwardListQuerySchema,
  movementListQuerySchema,
  reverseInwardSchema,
  updateFabricSchema,
  type FabricListQuery,
  type InwardListQuery,
  type MovementListQuery,
} from "./fabric.schema";
import type { FabricDto, InwardDto } from "./fabric.repository";
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
  const stamp = factoryToday();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${stamp}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  // BOM so spreadsheet apps read the file as UTF-8.
  res.send(`\uFEFF${toCsv(header, rows)}`);
}

// Fabric cost (rates, amounts, stock value) is only returned to users with costing.view.
const showCost = (req: Request) => can(req, "costing.view");

const hideFabricCost = (fabric: FabricDto): FabricDto => ({ ...fabric, avgRate: null, stockValue: null });
const hideInwardCost = (inward: InwardDto): InwardDto => ({ ...inward, rate: null, amount: null });

/** Drops filters and sorts on money columns, which would otherwise reveal values by elimination. */
function withoutMoney<Q extends Record<string, unknown>>(req: Request, query: Q, keys: string[]): Q {
  if (showCost(req)) return query;
  const hidden = new Set(keys.flatMap((key) => [`${key}Min`, `${key}Max`]));
  const kept = Object.entries(query).filter(
    ([name, value]) => !hidden.has(name) && !(name === "sort" && keys.includes(String(value))),
  );
  return Object.fromEntries(kept) as Q;
}

// Column params are validated by the schema; their keys are dynamic, hence the casts.
const fabricQuery = (req: Request) =>
  withoutMoney(req, fabricListQuerySchema.parse(req.query) as FabricListQuery, ["avgRate", "stockValue"]);
const inwardQuery = (req: Request) =>
  withoutMoney(req, inwardListQuerySchema.parse(req.query) as InwardListQuery, ["rate", "amount"]);
const movementQuery = (req: Request) => movementListQuerySchema.parse(req.query) as MovementListQuery;

export const fabricController = {
  list: (async (req, res) => {
    const data = await fabricService.list(fabricQuery(req));
    if (showCost(req)) return void res.json({ success: true, data });
    res.json({
      success: true,
      data: { ...data, fabrics: data.fabrics.map(hideFabricCost), summary: { ...data.summary, stockValue: null } },
    });
  }) satisfies RequestHandler,

  options: (async (_req, res) => {
    res.json({ success: true, data: { fabrics: await fabricService.options() } });
  }) satisfies RequestHandler,

  get: (async (req, res) => {
    const fabric = await fabricService.get(idOf(req));
    res.json({ success: true, data: { fabric: showCost(req) ? fabric : hideFabricCost(fabric) } });
  }) satisfies RequestHandler,

  update: (async (req, res) => {
    const input = updateFabricSchema.parse(req.body);
    const fabric = await fabricService.update(actorOf(req), idOf(req), input, clientMeta(req));
    res.json({ success: true, data: { fabric: showCost(req) ? fabric : hideFabricCost(fabric) } });
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
        m.inward ? `FI-${String(m.inward.number).padStart(4, "0")}` : null,
        m.reason,
        m.createdBy,
      ]),
    );
  }) satisfies RequestHandler,

  inwards: (async (req, res) => {
    const data = await inwardService.list(inwardQuery(req));
    if (showCost(req)) return void res.json({ success: true, data });
    res.json({ success: true, data: { ...data, inwards: data.inwards.map(hideInwardCost), totalAmount: null } });
  }) satisfies RequestHandler,

  exportInwards: (async (req, res) => {
    const { inwards } = await inwardService.list({ ...inwardQuery(req), page: 1, pageSize: EXPORT_LIMIT });
    const cost = showCost(req);
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
        ...(cost ? ["Rate", "Amount"] : []),
        "Supplier",
        "Invoice",
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
        ...(cost ? [i.rate, i.amount] : []),
        i.supplier,
        i.invoiceRef,
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
    res.status(201).json({ success: true, data: { inward: showCost(req) ? inward : hideInwardCost(inward) } });
  }) satisfies RequestHandler,

  reverseInward: (async (req, res) => {
    const { reason } = reverseInwardSchema.parse(req.body);
    const inward = await inwardService.reverse(actorOf(req), idOf(req), reason, clientMeta(req));
    res.json({ success: true, data: { inward: showCost(req) ? inward : hideInwardCost(inward) } });
  }) satisfies RequestHandler,
};
