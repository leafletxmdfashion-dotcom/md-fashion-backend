import { Router, type RequestHandler } from "express";
import { z } from "zod";

import { prisma } from "../../db/prisma";
import { factoryToday } from "../../lib/business-date";
import { AppError, ErrorCode } from "../../lib/errors";
import { actorOf } from "../../lib/request";
import { auditReadService } from "../audit/audit.routes";
import { requireAuth } from "../auth/auth.middleware";
import { packingBalance } from "../packing/packing.service";
import { requirePermission } from "../permissions/permission.middleware";
import type { Permission } from "../permissions/permission.types";

// The dashboard in one request: for a date range, how much was cut, stitched Good, packed
// and dispatched (per day, or per week for long ranges, and against the same length of
// time just before), where pieces are right now, the busiest items and teams, labour cost
// and money owed. Each section is sent only to people who may see it; money only with
// costing.view, balances only with payments.view.

const MAX_DAYS = 366;

const DAY = 86_400_000;

export const dashboardQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((range) => range.from <= range.to, { message: "The start must be on or before the end.", path: ["from"] });

type Range = { from: string; to: string };

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;

const shift = (date: string, days: number) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);

/** Monday of the week a date falls in. */
const weekOf = (date: string) => shift(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

const money = (value: string | null | undefined) => Number(value ?? 0).toFixed(2);

export const FLOWS = ["cut", "good", "packed", "dispatched"] as const;

type Flow = (typeof FLOWS)[number];

/** Pieces cut, stitched Good (receipts + recovered rework), packed and dispatched, per day. */
function dailyFlows(range: Range) {
  return prisma.$queryRaw<{ day: string; flow: Flow; pieces: number }[]>`
    SELECT b.cutting_date::text AS day, 'cut' AS flow, sum(b.total_accepted_pieces)::int AS pieces
      FROM cutting_batches b WHERE b.status = 'FINALIZED' AND b.cutting_date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY 1
    UNION ALL
    SELECT r.receipt_date::text, 'good', sum(r.good)::int
      FROM stitching_receipts r WHERE r.status = 'POSTED' AND r.receipt_date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY 1
    UNION ALL
    SELECT rr.resolved_on::text, 'good', sum(rr.recovered)::int
      FROM rework_resolutions rr WHERE rr.recovered > 0 AND rr.resolved_on BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY 1
    UNION ALL
    SELECT e.pack_date::text, 'packed', sum(e.pieces)::int
      FROM packing_entries e WHERE e.status = 'POSTED' AND e.pack_date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY 1
    UNION ALL
    SELECT m.movement_date::text, 'dispatched',
           (COALESCE(sum(m.qty_out) FILTER (WHERE m.type = 'DISPATCH'), 0)
             - COALESCE(sum(m.qty_in) FILTER (WHERE m.type = 'DISPATCH_REVERSAL'), 0))::int
      FROM godown_movements m WHERE m.type IN ('DISPATCH', 'DISPATCH_REVERSAL')
        AND m.movement_date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY 1`;
}

function totals(rows: { flow: Flow; pieces: number }[]): Record<Flow, number> {
  const out = { cut: 0, good: 0, packed: 0, dispatched: 0 };

  for (const row of rows) out[row.flow] += row.pieces;

  return out;
}

/** One point per day (or per week from Monday), zeros included, so the line never skips. */
export function toSeries(rows: { day: string; flow: Flow; pieces: number }[], range: Range, week: boolean) {
  const keyOf = (day: string) => (week ? weekOf(day) : day);
  const points = new Map<string, Record<Flow, number>>();

  for (let day = keyOf(range.from); day <= range.to; day = shift(day, week ? 7 : 1)) {
    points.set(day, { cut: 0, good: 0, packed: 0, dispatched: 0 });
  }

  for (const row of rows) points.get(keyOf(row.day))![row.flow] += row.pieces;

  return [...points].map(([date, values]) => ({ date, ...values }));
}

export const dashboardService = {
  async get(permissions: ReadonlySet<Permission>, range: Range) {
    const days = daysBetween(range.from, range.to);

    if (days > MAX_DAYS) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Choose a range of a year or less.", {
        from: ["Choose a range of a year or less."],
      });
    }

    const can = (permission: Permission) => permissions.has(permission);
    const week = days > 45;
    const previous = { from: shift(range.from, -days), to: shift(range.from, -1) };
    const production = ["production.view", "stitching.view", "packing.view", "godown.view"].some((key) =>
      can(key as Permission),
    );

    const [current, before, pipeline, rejects, jogadi, packing, items, fabric, costs, payments, recent] =
      await Promise.all([
        production ? dailyFlows(range) : [],
        production ? dailyFlows(previous) : [],
        production ? this.pipeline() : null,
        can("stitching.view") ? this.rejects(range) : null,
        can("stitching.view") ? this.jogadiOutput(range) : null,
        can("packing.view") ? this.packingOutput(range) : null,
        production ? this.items(range) : null,
        can("fabric.view") ? this.fabric(range, can("costing.view")) : null,
        can("costing.view") ? this.costs(range, previous) : null,
        can("payments.view") ? this.payments(range) : null,
        can("audit.view") ? this.recent() : null,
      ]);

    return {
      range: { ...range, days, bucket: week ? ("week" as const) : ("day" as const), previous },
      flow: production ? { totals: totals(current), previous: totals(before), series: toSeries(current, range, week) } : null,
      pipeline,
      rejects,
      teams: jogadi || packing ? { jogadi, packing } : null,
      items,
      fabric,
      costs,
      payments,
      recent,
    };
  },

  /** Where pieces are right now, stage by stage. */
  async pipeline() {
    const [[row], balances] = await Promise.all([
      prisma.$queryRaw<{ unissued: number; wip: number; rework: number; stock: number }[]>`
        SELECT
          (SELECT COALESCE(sum(o.available_for_stitching), 0)::int FROM cutting_outputs o
            JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED'
            JOIN production_lots l ON l.id = o.lot_id AND l.status <> 'CANCELLED') AS unissued,
          (SELECT COALESCE(sum(il.quantity - il.received), 0)::int FROM stitching_issue_lines il
            JOIN stitching_issues i ON i.id = il.issue_id AND i.status = 'POSTED') AS wip,
          (SELECT COALESCE(sum(quantity - recovered - failed), 0)::int FROM rework_items
            WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')) AS rework,
          (SELECT COALESCE(sum(balance), 0)::int FROM godown_stock) AS stock`,
      packingBalance(prisma),
    ]);

    return {
      toIssue: row!.unissued,
      withTeams: row!.wip,
      inRework: row!.rework,
      toPack: balances.reduce((sum, size) => sum + Math.max(0, size.good - size.packed), 0),
      inGodown: row!.stock,
    };
  },

  async rejects(range: Range) {
    const [row] = await prisma.$queryRaw<{ rejected: number; rework: number }[]>`
      SELECT COALESCE(sum(rl.reject), 0)::int AS rejected, COALESCE(sum(rl.rework), 0)::int AS rework
      FROM stitching_receipt_lines rl JOIN stitching_receipts r ON r.id = rl.receipt_id AND r.status = 'POSTED'
      WHERE r.receipt_date BETWEEN ${range.from}::date AND ${range.to}::date`;

    return { rejected: row!.rejected, sentToRework: row!.rework };
  },

  /** Good pieces received from each Jogadi in the range, busiest first. */
  jogadiOutput(range: Range) {
    return prisma.$queryRaw<{ id: string; name: string; pieces: number }[]>`
      SELECT i.team_id AS id, max(i.team_name) AS name, sum(r.good)::int AS pieces
      FROM stitching_receipts r JOIN stitching_issues i ON i.id = r.issue_id
      WHERE r.status = 'POSTED' AND r.receipt_date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY i.team_id HAVING sum(r.good) > 0 ORDER BY 3 DESC, 2 LIMIT 6`;
  },

  /** Pieces each packing team (or, before teams, each person) packed in the range. */
  packingOutput(range: Range) {
    return prisma.$queryRaw<{ id: string; name: string; pieces: number }[]>`
      SELECT COALESCE(e.team_id, e.packer_id) AS id, max(COALESCE(e.team_name, e.packer_name)) AS name,
             sum(e.pieces)::int AS pieces
      FROM packing_entries e
      WHERE e.status = 'POSTED' AND e.pack_date BETWEEN ${range.from}::date AND ${range.to}::date
      GROUP BY 1 ORDER BY 3 DESC, 2 LIMIT 6`;
  },

  /** The items packed most in the range, and the items with most in the godown now. */
  async items(range: Range) {
    const [packed, inStock] = await Promise.all([
      prisma.$queryRaw<{ id: string; name: string; pieces: number }[]>`
        SELECT l.article_id AS id, max(l.article_name) AS name, sum(e.pieces)::int AS pieces
        FROM packing_entries e JOIN production_lots l ON l.id = e.lot_id
        WHERE e.status = 'POSTED' AND e.pack_date BETWEEN ${range.from}::date AND ${range.to}::date
        GROUP BY 1 ORDER BY 3 DESC, 2 LIMIT 6`,
      prisma.$queryRaw<{ id: string; name: string; pieces: number }[]>`
        SELECT a.id, a.name, sum(s.balance)::int AS pieces
        FROM godown_stock s JOIN articles a ON a.id = s.article_id
        GROUP BY a.id HAVING sum(s.balance) > 0 ORDER BY 3 DESC, 2 LIMIT 6`,
    ]);

    return { packed, inStock };
  },

  /** Fabrics at or under their reorder level, and purchases in the range (value with money). */
  async fabric(range: Range, showMoney: boolean) {
    const [low, [moved]] = await Promise.all([
      prisma.$queryRaw<{ id: string; name: string; unit: string; balance: string; threshold: string }[]>`
        SELECT f.id, f.name, f.unit, COALESCE(s.balance, 0)::text AS balance, f.low_stock_threshold::text AS threshold
        FROM fabrics f LEFT JOIN fabric_stock s ON s.fabric_id = f.id
        WHERE f.low_stock_threshold > 0 AND COALESCE(s.balance, 0) <= f.low_stock_threshold
        ORDER BY COALESCE(s.balance, 0) / f.low_stock_threshold, f.name LIMIT 8`,
      prisma.$queryRaw<{ purchases: number; amount: string }[]>`
        SELECT
          (SELECT count(*)::int FROM fabric_inwards WHERE reversed_at IS NULL
             AND inward_date BETWEEN ${range.from}::date AND ${range.to}::date) AS purchases,
          (SELECT COALESCE(sum(amount), 0)::text FROM fabric_inwards WHERE reversed_at IS NULL
             AND inward_date BETWEEN ${range.from}::date AND ${range.to}::date) AS amount`,
    ]);

    return {
      lowStock: low.map((row) => ({
        id: row.id,
        name: row.name,
        unit: row.unit,
        balance: Number(row.balance),
        threshold: Number(row.threshold),
      })),
      purchases: moved!.purchases,
      purchasedAmount: showMoney ? money(moved!.amount) : null,
    };
  },

  /** Cost booked on lots, by kind, in the range and in the period before it. */
  async costs(range: Range, previous: Range) {
    const rows = await prisma.$queryRaw<{ kind: string; now: string; before: string }[]>`
      SELECT kind,
             COALESCE(sum(amount) FILTER (WHERE entry_date BETWEEN ${range.from}::date AND ${range.to}::date), 0)::text AS now,
             COALESCE(sum(amount) FILTER (WHERE entry_date BETWEEN ${previous.from}::date AND ${previous.to}::date), 0)::text AS before
      FROM lot_costs WHERE entry_date BETWEEN ${previous.from}::date AND ${range.to}::date
      GROUP BY kind`;
    const kinds = ["FABRIC_CONSUMED", "FABRIC_WASTAGE", "CUTTING_LABOUR", "STITCHING_LABOUR", "PACKING_LABOUR"];

    return kinds.map((kind) => {
      const row = rows.find((entry) => entry.kind === kind);

      return { kind, amount: money(row?.now), previous: money(row?.before) };
    });
  },

  /** What the factory owes its people and is owed back, and what was paid in the range. */
  async payments(range: Range) {
    const [row] = await prisma.$queryRaw<{ payable: string; receivable: string; paid: string; people: number }[]>`
      WITH b AS (SELECT karigar_id, sum(amount) AS balance FROM karigar_ledger GROUP BY 1)
      SELECT COALESCE(sum(balance) FILTER (WHERE balance > 0), 0)::text AS payable,
             COALESCE(-sum(balance) FILTER (WHERE balance < 0), 0)::text AS receivable,
             count(*) FILTER (WHERE balance > 0)::int AS people,
             (SELECT COALESCE(-sum(amount), 0)::text FROM karigar_ledger
               WHERE type = 'PAYMENT' AND entry_date BETWEEN ${range.from}::date AND ${range.to}::date) AS paid
      FROM b`;

    return {
      payable: money(row!.payable),
      receivable: money(row!.receivable),
      peopleToPay: row!.people,
      paidInRange: money(row!.paid),
    };
  },

  /** The latest audit events, for people who may read the audit log. */
  async recent() {
    const { events } = await auditReadService.list({
      category: [],
      type: [],
      severity: [],
      sort: "desc",
      page: 1,
      pageSize: 10,
    });

    return events.map((event) => ({
      id: event.id,
      at: event.at,
      label: event.label,
      severity: event.severity,
      outcome: event.outcome,
      actor: event.actor?.name ?? null,
      reason: event.reason,
    }));
  },
};

export function dashboardRoutes(): Router {
  const router = Router();

  router.use(requireAuth, requirePermission("dashboard.view"));

  router.get("/", (async (req, res) => {
    const today = factoryToday();
    const query = dashboardQuerySchema.parse({
      from: typeof req.query.from === "string" ? req.query.from : shift(today, -29),
      to: typeof req.query.to === "string" ? req.query.to : today,
    });

    res.json({ success: true, data: await dashboardService.get(actorOf(req).user.permissions, query) });
  }) satisfies RequestHandler);

  return router;
}
