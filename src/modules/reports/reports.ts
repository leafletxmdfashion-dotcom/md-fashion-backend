import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { prisma, Prisma } from "../../db/prisma";
import { factoryToday } from "../../lib/business-date";
import { sendCsv } from "../../lib/csv-export";
import { errors } from "../../lib/errors";
import { CATEGORY_LABEL, label } from "../../lib/labels";
import { can } from "../../lib/request";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import type { Permission } from "../permissions/permission.types";

// Reports: read-only views computed live from the same posted transactions the screens use. Each
// report names the right that opens it; money columns are left out without See prices & costs, as
// everywhere else. One endpoint returns rows and totals; the export sends the same rows as CSV.

type ColumnType = "text" | "number" | "money" | "date";

interface Column {
  key: string;
  label: string;
  type: ColumnType;
  /** Needs costing.view. */
  money?: boolean;
  /** Added up in the totals row. */
  total?: boolean;
}

interface Filters {
  from: string;
  to: string;
  lotId?: string | undefined;
}

type Row = Record<string, string | number | null>;

interface Report {
  key: string;
  group: string;
  title: string;
  description: string;
  permission: Permission;
  /** Uses the date range (otherwise it is a snapshot of now). */
  dated: boolean;
  /** Can be narrowed to one lot. */
  byLot: boolean;
  columns: Column[];
  rows: (filters: Filters) => Promise<Row[]>;
}

const pad = (prefix: string, number: number) => `${prefix}-${String(number).padStart(4, "0")}`;

const lotFilter = (column: string, filters: Filters) =>
  filters.lotId ? Prisma.sql`AND ${Prisma.raw(column)} = ${filters.lotId}::uuid` : Prisma.empty;

const range = (column: string, filters: Filters) =>
  Prisma.sql`${Prisma.raw(column)} BETWEEN ${filters.from}::date AND ${filters.to}::date`;

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

const pct = (part: unknown, whole: unknown) =>
  num(whole) > 0 ? Math.round((num(part) / num(whole)) * 1000) / 10 : null;

const unitText = (unit: unknown) => (unit === "METER" ? "m" : "kg");

const REPORTS: Report[] = [
  {
    key: "fabric-stock",
    group: "Fabric",
    title: "Fabric stock",
    description: "Every fabric's balance now, its reorder level and stock value.",
    permission: "fabric.view",
    dated: false,
    byLot: false,
    columns: [
      { key: "fabric", label: "Fabric", type: "text" },
      { key: "code", label: "Code", type: "text" },
      { key: "unit", label: "Unit", type: "text" },
      { key: "balance", label: "In stock", type: "number" },
      { key: "reorder", label: "Reorder level", type: "number" },
      { key: "status", label: "Status", type: "text" },
      { key: "billsPending", label: "Bills pending", type: "number", total: true },
      { key: "avgRate", label: "Avg rate", type: "money", money: true },
      { key: "value", label: "Stock value", type: "money", money: true, total: true },
    ],
    rows: async () =>
      (
        await prisma.$queryRaw<Row[]>`
          SELECT f.name AS fabric, f.code, f.unit, s.balance::float8 AS balance,
                 f.low_stock_threshold::float8 AS reorder,
                 CASE WHEN s.balance <= 0 THEN 'Out of stock'
                      WHEN s.balance <= f.low_stock_threshold THEN 'Low' ELSE 'OK' END AS status,
                 (SELECT count(*)::int FROM fabric_inwards i
                  WHERE i.fabric_id = f.id AND i.bill_status = 'PENDING' AND i.reversed_at IS NULL) AS "billsPending",
                 round(s.purchased_amount / nullif(s.purchased_qty, 0), 2)::float8 AS "avgRate",
                 round(s.balance * s.purchased_amount / nullif(s.purchased_qty, 0), 2)::float8 AS value
          FROM fabrics f JOIN fabric_stock s ON s.fabric_id = f.id ORDER BY f.name`
      ).map((row) => ({ ...row, unit: unitText(row.unit) })),
  },
  {
    key: "fabric-purchases",
    group: "Fabric",
    title: "Fabric purchases",
    description: "Purchases received in the period, including those still waiting for their bill.",
    permission: "fabric.view",
    dated: true,
    byLot: false,
    columns: [
      { key: "date", label: "Date", type: "date" },
      { key: "number", label: "No.", type: "text" },
      { key: "fabric", label: "Fabric", type: "text" },
      { key: "quantity", label: "Quantity", type: "number", total: true },
      { key: "unit", label: "Unit", type: "text" },
      { key: "supplier", label: "Supplier", type: "text" },
      { key: "invoice", label: "Invoice", type: "text" },
      { key: "bill", label: "Bill", type: "text" },
      { key: "rate", label: "Rate", type: "money", money: true },
      { key: "amount", label: "Amount", type: "money", money: true, total: true },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<(Row & { n: number })[]>`
          SELECT i.inward_date::text AS date, i.number AS n, f.name AS fabric, i.quantity::float8 AS quantity, f.unit,
                 i.supplier, i.invoice_ref AS invoice,
                 CASE WHEN i.bill_status = 'PENDING' THEN 'Pending' ELSE 'Received' END AS bill,
                 i.rate::float8 AS rate, i.amount::float8 AS amount
          FROM fabric_inwards i JOIN fabrics f ON f.id = i.fabric_id
          WHERE i.reversed_at IS NULL AND ${range("i.inward_date", filters)}
          ORDER BY i.inward_date, i.number`
      ).map(({ n, ...row }) => ({ ...row, number: pad("FI", n), unit: unitText(row.unit) })),
  },
  {
    key: "fabric-consumption",
    group: "Fabric",
    title: "Fabric consumption & wastage",
    description: "Fabric issued to cutting in the period: used, returned and wasted, by lot.",
    permission: "production.view",
    dated: true,
    byLot: true,
    columns: [
      { key: "lot", label: "Lot", type: "text" },
      { key: "item", label: "Item", type: "text" },
      { key: "fabric", label: "Fabric", type: "text" },
      { key: "cuttings", label: "Cuttings", type: "number", total: true },
      { key: "issued", label: "Issued", type: "number", total: true },
      { key: "consumed", label: "Used", type: "number", total: true },
      { key: "returned", label: "Returned", type: "number", total: true },
      { key: "wastage", label: "Wastage", type: "number", total: true },
      { key: "wastagePct", label: "Wastage %", type: "number" },
      { key: "cost", label: "Fabric cost", type: "money", money: true, total: true },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<Row[]>`
          SELECT l.lot_number AS lot, l.article_name AS item, f.name AS fabric, count(*)::int AS cuttings,
                 sum(b.total_issued_kg)::float8 AS issued, sum(b.total_consumed_kg)::float8 AS consumed,
                 sum(b.total_returned_kg)::float8 AS returned, sum(b.total_wastage_kg)::float8 AS wastage,
                 sum(b.fabric_cost)::float8 AS cost
          FROM cutting_batches b JOIN production_lots l ON l.id = b.lot_id JOIN fabrics f ON f.id = l.fabric_id
          WHERE b.status = 'FINALIZED' AND ${range("b.cutting_date", filters)} ${lotFilter("b.lot_id", filters)}
          GROUP BY l.id, f.name ORDER BY l.lot_number`
      ).map((row) => ({ ...row, wastagePct: pct(row.wastage, row.issued) })),
  },
  {
    key: "lot-production",
    group: "Production",
    title: "Lot-wise production",
    description: "Where every lot's pieces are now: cut, with Jogadi, Good, rework, rejected and packed.",
    permission: "production.view",
    dated: false,
    byLot: true,
    columns: [
      { key: "lot", label: "Lot", type: "text" },
      { key: "item", label: "Item", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "cut", label: "Cut", type: "number", total: true },
      { key: "unissued", label: "Not issued", type: "number", total: true },
      { key: "withJogadi", label: "With Jogadi", type: "number", total: true },
      { key: "good", label: "Good", type: "number", total: true },
      { key: "inRework", label: "In rework", type: "number", total: true },
      { key: "rejected", label: "Rejected", type: "number", total: true },
      { key: "packed", label: "Packed", type: "number", total: true },
      { key: "toPack", label: "To pack", type: "number", total: true },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<Row[]>`
          SELECT l.lot_number AS lot, l.article_name AS item, initcap(l.status) AS status,
            (SELECT COALESCE(sum(o.accepted_quantity), 0) FROM cutting_outputs o
              JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED' WHERE o.lot_id = l.id)::int AS cut,
            (SELECT COALESCE(sum(o.available_for_stitching), 0) FROM cutting_outputs o
              JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED' WHERE o.lot_id = l.id)::int AS unissued,
            (SELECT COALESCE(sum(il.quantity - il.received), 0) FROM stitching_issue_lines il
              JOIN stitching_issues i ON i.id = il.issue_id AND i.status = 'POSTED' WHERE i.lot_id = l.id)::int AS "withJogadi",
            ((SELECT COALESCE(sum(good), 0) FROM stitching_receipts WHERE lot_id = l.id AND status = 'POSTED')
              + (SELECT COALESCE(sum(recovered), 0) FROM rework_items
                 WHERE lot_id = l.id AND status <> 'CANCELLED'))::int AS good,
            (SELECT COALESCE(sum(quantity - recovered - failed), 0) FROM rework_items
              WHERE lot_id = l.id AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED'))::int AS "inRework",
            ((SELECT COALESCE(sum(rl.reject), 0) FROM stitching_receipt_lines rl
               JOIN stitching_receipts r ON r.id = rl.receipt_id AND r.status = 'POSTED' WHERE r.lot_id = l.id)
              + (SELECT COALESCE(sum(failed), 0) FROM rework_items
                 WHERE lot_id = l.id AND status <> 'CANCELLED'))::int AS rejected,
            (SELECT COALESCE(sum(pieces), 0) FROM packing_entries WHERE lot_id = l.id AND status = 'POSTED')::int AS packed
          FROM production_lots l
          WHERE l.status <> 'CANCELLED' ${lotFilter("l.id", filters)}
          ORDER BY l.created_at DESC`
      ).map((row) => ({ ...row, toPack: Math.max(0, num(row.good) - num(row.packed)) })),
  },
  {
    key: "size-cutting",
    group: "Production",
    title: "Colour & size-wise cutting",
    description: "Pieces cut in the period by lot, colour and size.",
    permission: "production.view",
    dated: true,
    byLot: true,
    columns: [
      { key: "lot", label: "Lot", type: "text" },
      { key: "item", label: "Item", type: "text" },
      { key: "colour", label: "Colour", type: "text" },
      { key: "size", label: "Size", type: "text" },
      { key: "pieces", label: "Pieces cut", type: "number", total: true },
    ],
    rows: (filters) =>
      prisma.$queryRaw<Row[]>`
        SELECT l.lot_number AS lot, l.article_name AS item, o.colour_name AS colour, o.size_label AS size,
               sum(o.accepted_quantity)::int AS pieces
        FROM cutting_outputs o JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED'
        JOIN production_lots l ON l.id = o.lot_id
        WHERE ${range("b.cutting_date", filters)} ${lotFilter("o.lot_id", filters)}
        GROUP BY l.lot_number, l.article_name, o.colour_name, o.size_label
        ORDER BY l.lot_number, o.colour_name, min(o.position)`,
  },
  {
    key: "stitching-wip",
    group: "Stitching",
    title: "Stitching work in progress",
    description: "Who holds which pieces right now, by issue and size.",
    permission: "stitching.view",
    dated: false,
    byLot: true,
    columns: [
      { key: "issue", label: "Issue", type: "text" },
      { key: "date", label: "Issued on", type: "date" },
      { key: "lot", label: "Lot", type: "text" },
      { key: "holder", label: "Team / karigar", type: "text" },
      { key: "operation", label: "Work", type: "text" },
      { key: "size", label: "Size", type: "text" },
      { key: "issued", label: "Issued", type: "number", total: true },
      { key: "received", label: "Received", type: "number", total: true },
      { key: "holding", label: "Holding", type: "number", total: true },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<(Row & { n: number })[]>`
          SELECT i.number AS n, i.issue_date::text AS date, l.lot_number AS lot, i.team_name AS holder, i.operation,
                 il.size_label AS size, il.quantity AS issued, il.received, (il.quantity - il.received) AS holding
          FROM stitching_issue_lines il JOIN stitching_issues i ON i.id = il.issue_id AND i.status = 'POSTED'
          JOIN production_lots l ON l.id = i.lot_id
          WHERE il.quantity > il.received ${lotFilter("i.lot_id", filters)}
          ORDER BY i.issue_date, i.number, il.position`
      ).map(({ n, ...row }) => ({ ...row, issue: pad("SI", n) })),
  },
  {
    key: "jogadi-work",
    group: "Stitching",
    title: "Jogadi-wise work",
    description: "Pieces each team or karigar returned in the period, with quality and pay.",
    permission: "stitching.view",
    dated: true,
    byLot: true,
    columns: [
      { key: "holder", label: "Team / karigar", type: "text" },
      { key: "receipts", label: "Receipts", type: "number", total: true },
      { key: "received", label: "Received", type: "number", total: true },
      { key: "good", label: "Good", type: "number", total: true },
      { key: "rework", label: "Rework", type: "number", total: true },
      { key: "reject", label: "Reject", type: "number", total: true },
      { key: "goodPct", label: "Good %", type: "number" },
      { key: "earned", label: "Earned", type: "money", money: true, total: true },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<Row[]>`
          WITH receipts AS (
            SELECT r.id, r.earning, COALESCE(i.team_id, i.karigar_id) AS holder_id, i.team_name
            FROM stitching_receipts r JOIN stitching_issues i ON i.id = r.issue_id
            WHERE r.status = 'POSTED' AND ${range("r.receipt_date", filters)} ${lotFilter("r.lot_id", filters)}
          )
          SELECT max(x.team_name) AS holder, count(*)::int AS receipts,
                 sum(t.received)::int AS received, sum(t.good)::int AS good, sum(t.rework)::int AS rework,
                 sum(t.reject)::int AS reject, sum(x.earning)::float8 AS earned
          FROM receipts x
          JOIN LATERAL (SELECT sum(received) AS received, sum(good) AS good, sum(rework) AS rework,
                               sum(reject) AS reject
                        FROM stitching_receipt_lines WHERE receipt_id = x.id) t ON true
          GROUP BY x.holder_id ORDER BY 4 DESC`
      ).map((row) => ({ ...row, goodPct: pct(row.good, row.received) })),
  },
  {
    key: "worker-earnings",
    group: "Workers",
    title: "Earnings & balances",
    description: "What each person earned and was paid in the period, and what is owed now.",
    permission: "payments.view",
    dated: true,
    byLot: false,
    columns: [
      { key: "person", label: "Person", type: "text" },
      { key: "category", label: "Works as", type: "text" },
      { key: "earned", label: "Earned", type: "money", total: true },
      { key: "credits", label: "Credits", type: "money", total: true },
      { key: "paid", label: "Paid", type: "money", total: true },
      { key: "advances", label: "Advances & expenses", type: "money", total: true },
      { key: "balance", label: "Balance now", type: "money", total: true },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<Row[]>`
          SELECT k.name AS person, k.category,
                 COALESCE(sum(l.amount) FILTER (WHERE l.type IN ('EARNING', 'EARNING_REVERSAL')
                   AND ${range("l.entry_date", filters)}), 0)::float8 AS earned,
                 COALESCE(sum(l.amount) FILTER (WHERE l.type IN ('CREDIT', 'RECOVERY', 'OTHER_PLUS')
                   AND ${range("l.entry_date", filters)}), 0)::float8 AS credits,
                 COALESCE(-sum(l.amount) FILTER (WHERE l.type = 'PAYMENT'
                   AND ${range("l.entry_date", filters)}), 0)::float8 AS paid,
                 COALESCE(-sum(l.amount) FILTER (WHERE l.type IN ('ADVANCE', 'EXPENSE', 'OTHER_MINUS')
                   AND ${range("l.entry_date", filters)}), 0)::float8 AS advances,
                 COALESCE(sum(l.amount), 0)::float8 AS balance
          FROM karigars k LEFT JOIN karigar_ledger l ON l.karigar_id = k.id
          GROUP BY k.id HAVING k.active OR COALESCE(sum(l.amount), 0) <> 0
          ORDER BY k.name`
      ).map((row) => ({ ...row, category: label(CATEGORY_LABEL, String(row.category)) })),
  },
  {
    key: "rework-reject",
    group: "Quality",
    title: "Rework & reject",
    description: "Pieces rejected in the period and why, from receipts and failed rework.",
    permission: "stitching.view",
    dated: true,
    byLot: true,
    columns: [
      { key: "lot", label: "Lot", type: "text" },
      { key: "size", label: "Size", type: "text" },
      { key: "stage", label: "Found at", type: "text" },
      { key: "reason", label: "Reason", type: "text" },
      { key: "pieces", label: "Pieces", type: "number", total: true },
    ],
    rows: (filters) =>
      prisma.$queryRaw<Row[]>`
        SELECT lot, size, stage, reason, sum(pieces)::int AS pieces FROM (
          SELECT l.lot_number AS lot, rl.size_label AS size, 'Stitching receipt' AS stage,
                 COALESCE(rl.reject_reason, '—') AS reason, rl.reject AS pieces
          FROM stitching_receipt_lines rl JOIN stitching_receipts r ON r.id = rl.receipt_id AND r.status = 'POSTED'
          JOIN production_lots l ON l.id = r.lot_id
          WHERE rl.reject > 0 AND ${range("r.receipt_date", filters)} ${lotFilter("r.lot_id", filters)}
          UNION ALL
          SELECT l.lot_number, ri.size_label, 'Rework failed', COALESCE(rr.failed_reason, '—'), rr.failed
          FROM rework_resolutions rr JOIN rework_items ri ON ri.id = rr.rework_id AND ri.status <> 'CANCELLED'
          JOIN production_lots l ON l.id = ri.lot_id
          WHERE rr.failed > 0 AND ${range("rr.resolved_on", filters)} ${lotFilter("ri.lot_id", filters)}
        ) x GROUP BY lot, size, stage, reason ORDER BY lot, size, 5 DESC`,
  },
  {
    key: "packing-pending",
    group: "Finishing",
    title: "Packing pending",
    description: "Good pieces from stitching still waiting to be packed, by lot and size.",
    permission: "packing.view",
    dated: false,
    byLot: true,
    columns: [
      { key: "lot", label: "Lot", type: "text" },
      { key: "item", label: "Item", type: "text" },
      { key: "size", label: "Size", type: "text" },
      { key: "good", label: "Good", type: "number", total: true },
      { key: "packed", label: "Packed", type: "number", total: true },
      { key: "waiting", label: "Waiting", type: "number", total: true },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<Row[]>`
          WITH moves AS (
            SELECT r.lot_id, rl.size_label AS size, rl.good, 0 AS packed
            FROM stitching_receipt_lines rl JOIN stitching_receipts r ON r.id = rl.receipt_id AND r.status = 'POSTED'
            UNION ALL
            SELECT lot_id, size_label, recovered, 0 FROM rework_items WHERE recovered > 0 AND status <> 'CANCELLED'
            UNION ALL
            SELECT e.lot_id, pl.size_label, 0, pl.quantity
            FROM packing_lines pl JOIN packing_entries e ON e.id = pl.entry_id AND e.status = 'POSTED'
          )
          SELECT l.lot_number AS lot, l.article_name AS item, m.size, sum(m.good)::int AS good,
                 sum(m.packed)::int AS packed
          FROM moves m JOIN production_lots l ON l.id = m.lot_id
          WHERE true ${lotFilter("m.lot_id", filters)}
          GROUP BY l.lot_number, l.article_name, m.size HAVING sum(m.good) > sum(m.packed)
          ORDER BY l.lot_number, m.size`
      ).map((row) => ({ ...row, waiting: num(row.good) - num(row.packed) })),
  },
  {
    key: "finished-goods",
    group: "Finishing",
    title: "Finished goods stock",
    description: "Packed pieces in the godown now, by item and size.",
    permission: "godown.view",
    dated: false,
    byLot: false,
    columns: [
      { key: "item", label: "Item", type: "text" },
      { key: "code", label: "Code", type: "text" },
      { key: "size", label: "Size", type: "text" },
      { key: "inGodown", label: "In godown", type: "number", total: true },
    ],
    rows: () =>
      prisma.$queryRaw<Row[]>`
        SELECT a.name AS item, a.code, s.size_label AS size, s.balance AS "inGodown"
        FROM godown_stock s JOIN articles a ON a.id = s.article_id
        WHERE s.balance <> 0 ORDER BY a.name, s.size_label`,
  },
  {
    key: "dispatches",
    group: "Finishing",
    title: "Dispatches",
    description: "Goods sent out in the period.",
    permission: "godown.view",
    dated: true,
    byLot: false,
    columns: [
      { key: "date", label: "Date", type: "date" },
      { key: "number", label: "No.", type: "text" },
      { key: "party", label: "Party", type: "text" },
      { key: "challan", label: "Challan", type: "text" },
      { key: "pieces", label: "Pieces", type: "number", total: true },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<(Row & { n: number })[]>`
          SELECT dispatch_date::text AS date, number AS n, party, challan, pieces
          FROM dispatches WHERE status = 'POSTED' AND ${range("dispatch_date", filters)}
          ORDER BY dispatch_date, number`
      ).map(({ n, ...row }) => ({ ...row, number: pad("DS", n) })),
  },
  {
    key: "manufacturing-cost",
    group: "Management",
    title: "Manufacturing cost by lot",
    description: "What each lot cost, by kind, and its cost per packed piece.",
    permission: "costing.view",
    dated: false,
    byLot: true,
    columns: [
      { key: "lot", label: "Lot", type: "text" },
      { key: "item", label: "Item", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "fabric", label: "Fabric", type: "money", money: true, total: true },
      { key: "cutting", label: "Cutting", type: "money", money: true, total: true },
      { key: "stitching", label: "Stitching", type: "money", money: true, total: true },
      { key: "packing", label: "Packing", type: "money", money: true, total: true },
      { key: "other", label: "Accessories & other", type: "money", money: true, total: true },
      { key: "total", label: "Total", type: "money", money: true, total: true },
      { key: "packed", label: "Packed", type: "number", total: true },
      { key: "perPiece", label: "Per piece", type: "money", money: true },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<Row[]>`
          SELECT l.lot_number AS lot, l.article_name AS item, initcap(l.status) AS status,
                 COALESCE(sum(c.amount) FILTER (WHERE c.kind IN ('FABRIC_CONSUMED', 'FABRIC_WASTAGE')), 0)::float8 AS fabric,
                 COALESCE(sum(c.amount) FILTER (WHERE c.kind = 'CUTTING_LABOUR'), 0)::float8 AS cutting,
                 COALESCE(sum(c.amount) FILTER (WHERE c.kind = 'STITCHING_LABOUR'), 0)::float8 AS stitching,
                 COALESCE(sum(c.amount) FILTER (WHERE c.kind = 'PACKING_LABOUR'), 0)::float8 AS packing,
                 COALESCE(sum(c.amount) FILTER (WHERE c.kind IN ('ACCESSORIES', 'PROCESSING', 'OTHER_DIRECT')), 0)::float8 AS other,
                 COALESCE(sum(c.amount), 0)::float8 AS total,
                 (SELECT COALESCE(sum(pieces), 0) FROM packing_entries
                  WHERE lot_id = l.id AND status = 'POSTED')::int AS packed
          FROM production_lots l LEFT JOIN lot_costs c ON c.lot_id = l.id
          WHERE l.status <> 'CANCELLED' ${lotFilter("l.id", filters)}
          GROUP BY l.id ORDER BY l.created_at DESC`
      ).map((row) => ({
        ...row,
        perPiece: num(row.packed) > 0 ? Math.round((num(row.total) / num(row.packed)) * 100) / 100 : null,
      })),
  },
  {
    key: "production-loss",
    group: "Management",
    title: "Production loss",
    description: "Pieces lost to rejects and fabric lost to wastage, per lot.",
    permission: "production.view",
    dated: false,
    byLot: true,
    columns: [
      { key: "lot", label: "Lot", type: "text" },
      { key: "item", label: "Item", type: "text" },
      { key: "cut", label: "Cut", type: "number", total: true },
      { key: "rejected", label: "Rejected", type: "number", total: true },
      { key: "rejectPct", label: "Reject %", type: "number" },
      { key: "issuedKg", label: "Fabric issued", type: "number", total: true },
      { key: "wastageKg", label: "Fabric wasted", type: "number", total: true },
      { key: "wastagePct", label: "Wastage %", type: "number" },
    ],
    rows: async (filters) =>
      (
        await prisma.$queryRaw<Row[]>`
          SELECT l.lot_number AS lot, l.article_name AS item,
            (SELECT COALESCE(sum(total_accepted_pieces), 0) FROM cutting_batches
             WHERE lot_id = l.id AND status = 'FINALIZED')::int AS cut,
            ((SELECT COALESCE(sum(rl.reject), 0) FROM stitching_receipt_lines rl
               JOIN stitching_receipts r ON r.id = rl.receipt_id AND r.status = 'POSTED' WHERE r.lot_id = l.id)
              + (SELECT COALESCE(sum(failed), 0) FROM rework_items
                 WHERE lot_id = l.id AND status <> 'CANCELLED'))::int AS rejected,
            (SELECT COALESCE(sum(total_issued_kg), 0) FROM cutting_batches
             WHERE lot_id = l.id AND status = 'FINALIZED')::float8 AS "issuedKg",
            (SELECT COALESCE(sum(total_wastage_kg), 0) FROM cutting_batches
             WHERE lot_id = l.id AND status = 'FINALIZED')::float8 AS "wastageKg"
          FROM production_lots l WHERE l.status <> 'CANCELLED' ${lotFilter("l.id", filters)}
          ORDER BY l.created_at DESC`
      ).map((row) => ({
        ...row,
        rejectPct: pct(row.rejected, row.cut),
        wastagePct: pct(row.wastageKg, row.issuedKg),
      })),
  },
  {
    key: "approvals-history",
    group: "Management",
    title: "Approvals history",
    description: "Corrections asked for in the period and how they were decided.",
    permission: "approvals.decide",
    dated: true,
    byLot: false,
    columns: [
      { key: "date", label: "Asked on", type: "date" },
      { key: "record", label: "Record", type: "text" },
      { key: "change", label: "Change", type: "text" },
      { key: "reason", label: "Reason", type: "text" },
      { key: "askedBy", label: "Asked by", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "decidedBy", label: "Decided by", type: "text" },
    ],
    rows: (filters) =>
      prisma.$queryRaw<Row[]>`
        SELECT (a.requested_at AT TIME ZONE 'Asia/Kathmandu')::date::text AS date, a.title AS record,
               a.change, a.reason, u.name AS "askedBy", initcap(a.status) AS status, d.name AS "decidedBy"
        FROM approval_requests a JOIN users u ON u.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
        WHERE (a.requested_at AT TIME ZONE 'Asia/Kathmandu')::date
              BETWEEN ${filters.from}::date AND ${filters.to}::date
        ORDER BY a.requested_at DESC`,
  },
];

const BY_KEY = new Map(REPORTS.map((report) => [report.key, report]));

const filterSchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    lotId: z.uuid().optional(),
  })
  .transform((value) => ({
    from: value.from ?? `${factoryToday().slice(0, 8)}01`,
    to: value.to ?? factoryToday(),
    lotId: value.lotId,
  }))
  .refine((value) => value.from <= value.to, { message: "The start date is after the end date.", path: ["from"] });

/** The report and the columns this person may see. */
function open(req: Request) {
  const report = BY_KEY.get(String(req.params.key));

  if (!report || !can(req, report.permission)) throw errors.notFound("Report");

  const money = can(req, "costing.view");

  return { report, columns: report.columns.filter((column) => money || !column.money) };
}

async function run(req: Request) {
  const { report, columns } = open(req);
  const filters = filterSchema.parse(req.query);
  const keys = new Set(columns.map((column) => column.key));
  const rows = (await report.rows(filters)).map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => keys.has(key))),
  );
  const totals = Object.fromEntries(
    columns
      .filter((column) => column.total)
      .map((column) => [
        column.key,
        Math.round(rows.reduce((sum, row) => sum + num(row[column.key]), 0) * 1000) / 1000,
      ]),
  );

  return { report, columns, rows, totals, filters };
}

const meta = ({ key, group, title, description, dated, byLot }: Report) => ({
  key,
  group,
  title,
  description,
  dated,
  byLot,
});

export function reportRoutes(): Router {
  const router = Router();

  router.use(requireAuth, requirePermission("reports.view"));

  // The reports this person may open, grouped as the page lists them.
  router.get("/", ((req, res) => {
    res.json({ success: true, data: { reports: REPORTS.filter((report) => can(req, report.permission)).map(meta) } });
  }) satisfies RequestHandler);

  router.get("/:key", (async (req, res) => {
    const { report, columns, rows, totals, filters } = await run(req);

    res.json({ success: true, data: { report: meta(report), columns, rows, totals, filters } });
  }) satisfies RequestHandler);

  router.get("/:key/export", (async (req, res) => {
    const { report, columns, rows } = await run(req);

    sendCsv(
      req,
      res,
      report.key,
      columns.map((column) => ({ header: column.label, value: (row: Row) => row[column.key] ?? null })),
      rows,
      (row) => JSON.stringify(row),
    );
  }) satisfies RequestHandler);

  return router;
}
