import { Router, type Request, type RequestHandler } from "express";

import { z } from "zod";

import { allRows, docNumber, sendCsv } from "../../lib/csv-export";
import { karigarCode } from "../../lib/labels";
import { actorOf, can, clientMeta } from "../../lib/request";
import { queryRows, rowQueryFields, type RowQuery, type RowSpecs } from "../../lib/row-query";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import {
  entryListQuerySchema,
  idParamsSchema,
  lineListQuerySchema,
  packSchema,
  reverseSchema,
  staffQuerySchema,
  type EntryListQuery,
  type LineListQuery,
} from "./packing.schema";
import { packingService } from "./packing.service";

const idOf = (req: Request) => idParamsSchema.parse(req.params).id;

// Rates and pay are only returned to users who may see money.
const showMoney = (req: Request) => can(req, "costing.view");

type QueueLot = Awaited<ReturnType<typeof packingService.queue>>["lots"][number];
type Packer = Awaited<ReturnType<typeof packingService.staff>>["staff"][number];

const waitingSizes = (lot: QueueLot) => lot.sizes.filter((size) => size.waiting > 0);

// Column keys match the frontend table's, so the same URL params drive the list and its export.
const QUEUE_SPECS: RowSpecs<QueueLot> = {
  lot: { type: "text", value: (row) => row.lot.lotNumber },
  item: { type: "text", value: (row) => `${row.lot.articleName} ${row.lot.articleCode}` },
  sizes: {
    type: "text",
    sortable: false,
    value: (row) =>
      waitingSizes(row)
        .map((size) => ` ${size.size} `)
        .join(""),
  },
  good: { type: "number", value: (row) => row.good },
  packed: { type: "number", value: (row) => row.packed },
  waiting: { type: "number", value: (row) => row.waiting },
};
const queueQuerySchema = z.object(rowQueryFields(QUEUE_SPECS));
const queueHaystack = (row: QueueLot) =>
  [row.lot.lotNumber, row.lot.articleName, row.lot.articleCode, ...waitingSizes(row).map((size) => size.size)].join(
    " ",
  );

function packerSpecs(money: boolean): RowSpecs<Packer> {
  return {
    packer: { type: "text", value: (row) => `${row.name} ${karigarCode(row.number)}` },
    items: { type: "text", value: (row) => row.items },
    entries: { type: "number", value: (row) => row.entries },
    lots: { type: "number", value: (row) => row.lots },
    pieces: { type: "number", value: (row) => row.pieces },
    // Pay can be filtered and sorted on only by people who may see it.
    ...(money ? { earned: { type: "number" as const, value: (row: Packer) => Number(row.earned ?? 0) } } : {}),
    lastDate: { type: "date", value: (row) => row.lastDate },
  };
}
const packerHaystack = (row: Packer) => `${row.name} ${karigarCode(row.number)} ${row.items}`;

async function queueRows(req: Request) {
  // SAFETY: column params are validated by the schema; their keys are dynamic.
  const query = queueQuerySchema.parse(req.query) as RowQuery;
  const { lots } = await packingService.queue(undefined);
  return queryRows(lots, QUEUE_SPECS, query, queueHaystack);
}

async function packerRows(req: Request) {
  const money = showMoney(req);
  const specs = packerSpecs(money);
  // SAFETY: column params are validated by the schema; their keys are dynamic.
  const query = z.object({ ...staffQuerySchema.shape, ...rowQueryFields(specs) }).parse(req.query) as RowQuery & {
    dateFrom?: string;
    dateTo?: string;
  };
  const { staff } = await packingService.staff({ dateFrom: query.dateFrom, dateTo: query.dateTo }, money);
  return { ...queryRows(staff, specs, query, packerHaystack), money };
}

export function packingRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  const view = requirePermission("packing.view");
  const manage = requirePermission("packing.manage");

  router.get("/queue", view, (async (req, res) => {
    const { matching, page, total } = await queueRows(req);
    const sum = (key: "good" | "packed" | "waiting") => matching.reduce((acc, row) => acc + row[key], 0);

    res.json({
      success: true,
      data: { lots: page, total, totals: { good: sum("good"), packed: sum("packed"), waiting: sum("waiting") } },
    });
  }) satisfies RequestHandler);

  router.get("/queue/export", view, (async (req, res) => {
    const { matching } = await queueRows(req);

    sendCsv(
      req,
      res,
      "packing-queue",
      [
        { header: "Lot", value: (row) => row.lot.lotNumber },
        { header: "Item / design", value: (row) => row.lot.articleName },
        { header: "Item code", value: (row) => row.lot.articleCode },
        {
          header: "Waiting by size",
          value: (row) =>
            waitingSizes(row)
              .map((size) => `${size.size} ${size.waiting}`)
              .join(", "),
        },
        { header: "Good", value: (row) => row.good },
        { header: "Packed", value: (row) => row.packed },
        { header: "To pack", value: (row) => row.waiting },
      ],
      matching,
      (row) => row.lot.id,
    );
  }) satisfies RequestHandler);

  router.get("/summary", view, (async (req, res) => {
    res.json({ success: true, data: await packingService.summary(showMoney(req)) });
  }) satisfies RequestHandler);

  router.get("/entries", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = entryListQuerySchema.parse(req.query) as EntryListQuery;

    res.json({ success: true, data: await packingService.listEntries(query, showMoney(req)) });
  }) satisfies RequestHandler);

  router.get("/entries/export", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = entryListQuerySchema.parse(req.query) as EntryListQuery;
    const money = showMoney(req);
    const { entries } = await packingService.listEntries(allRows(query), money);
    type Entry = (typeof entries)[number];

    sendCsv(
      req,
      res,
      "packing-entries",
      [
        { header: "No.", value: (e: Entry) => docNumber("PK", e.number) },
        { header: "Date", value: (e: Entry) => e.date },
        { header: "Lot", value: (e: Entry) => e.lot.lotNumber },
        { header: "Item / design", value: (e: Entry) => e.lot.articleName },
        { header: "Packed by", value: (e: Entry) => e.packer.name },
        { header: "Sizes", value: (e: Entry) => e.sizes },
        { header: "Pieces", value: (e: Entry) => e.pieces },
        ...(money
          ? [
              { header: "Rate per piece", value: (e: Entry) => e.rate },
              { header: "Pay", value: (e: Entry) => e.earning },
            ]
          : []),
        { header: "Status", value: (e: Entry) => (e.status === "REVERSED" ? "Reversed" : "Packed") },
      ],
      entries,
      (e) => e.id,
    );
  }) satisfies RequestHandler);

  router.get("/entries/:id", view, (async (req, res) => {
    res.json({ success: true, data: { entry: await packingService.getEntry(idOf(req), showMoney(req)) } });
  }) satisfies RequestHandler);

  router.get("/lines", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = lineListQuerySchema.parse(req.query) as LineListQuery;

    res.json({ success: true, data: await packingService.listLines(query) });
  }) satisfies RequestHandler);

  router.get("/lines/export", view, (async (req, res) => {
    // SAFETY: column params are validated by the schema; their keys are dynamic.
    const query = lineListQuerySchema.parse(req.query) as LineListQuery;
    const { lines } = await packingService.listLines(allRows(query));

    sendCsv(
      req,
      res,
      "packing-by-size",
      [
        { header: "Date", value: (l) => l.date },
        { header: "Entry", value: (l) => docNumber("PK", l.entry.number) },
        { header: "Packed by", value: (l) => l.packer.name },
        { header: "Lot", value: (l) => l.lot.lotNumber },
        { header: "Item / design", value: (l) => l.articleName },
        { header: "Size", value: (l) => l.sizeLabel },
        { header: "Pieces", value: (l) => l.quantity },
      ],
      lines,
      (l) => l.id,
    );
  }) satisfies RequestHandler);

  router.get("/staff", view, (async (req, res) => {
    const { matching, page, total, money } = await packerRows(req);

    res.json({
      success: true,
      data: {
        staff: page,
        total,
        totals: {
          pieces: matching.reduce((acc, row) => acc + row.pieces, 0),
          earned: money ? matching.reduce((acc, row) => acc + Number(row.earned ?? 0), 0).toFixed(2) : null,
        },
      },
    });
  }) satisfies RequestHandler);

  router.get("/staff/export", view, (async (req, res) => {
    const { matching, money } = await packerRows(req);

    sendCsv(
      req,
      res,
      "packing-by-packer",
      [
        { header: "Code", value: (row: Packer) => karigarCode(row.number) },
        { header: "Packer", value: (row: Packer) => row.name },
        { header: "Items packed", value: (row: Packer) => row.items },
        { header: "Entries", value: (row: Packer) => row.entries },
        { header: "Lots", value: (row: Packer) => row.lots },
        { header: "Pieces", value: (row: Packer) => row.pieces },
        ...(money ? [{ header: "Pay earned", value: (row: Packer) => row.earned }] : []),
        { header: "First date", value: (row: Packer) => row.firstDate },
        { header: "Last date", value: (row: Packer) => row.lastDate },
      ],
      matching,
      (row) => row.id,
    );
  }) satisfies RequestHandler);

  router.post("/entries", manage, (async (req, res) => {
    const entry = await packingService.pack(actorOf(req), packSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { entry } });
  }) satisfies RequestHandler);

  router.post("/entries/:id/reverse", manage, (async (req, res) => {
    const { reason } = reverseSchema.parse(req.body);
    const entry = await packingService.reverse(actorOf(req), idOf(req), reason, clientMeta(req));

    res.json({ success: true, data: { entry } });
  }) satisfies RequestHandler);

  return router;
}
