import { randomUUID } from "node:crypto";

import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";

import { prisma, Prisma, transaction } from "../../db/prisma";
import { businessDate, factoryToday } from "../../lib/business-date";
import { errors } from "../../lib/errors";
import { contains, page } from "../../lib/list-query";
import { actorOf, clientMeta } from "../../lib/request";
import { recordAudit } from "../audit/audit.service";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import type { AuthContext, ClientMeta } from "../sessions/session.types";

// Manufacturing costing per lot. Costs from fabric, cutting, stitching and packing are posted by
// those documents (lot_costs) and are locked here; accessories, printing/embroidery/washing and
// other direct costs are added by hand with what they are for. Nothing is edited: removing a
// hand-added cost posts a reversal. Cost per piece = total ÷ packed (finished Good) pieces:
// provisional while the lot runs, final once it is completed, not available with none packed.

export const MANUAL_KINDS = ["ACCESSORIES", "PROCESSING", "OTHER_DIRECT"] as const;

/** Cost groups as the cost sheet shows them, in order. */
export const COST_GROUPS = [
  { key: "FABRIC", label: "Fabric", kinds: ["FABRIC_CONSUMED", "FABRIC_WASTAGE"] },
  { key: "CUTTING", label: "Cutting", kinds: ["CUTTING_LABOUR"] },
  { key: "STITCHING", label: "Stitching", kinds: ["STITCHING_LABOUR"] },
  { key: "PACKING", label: "Packing", kinds: ["PACKING_LABOUR"] },
  { key: "ACCESSORIES", label: "Accessories", kinds: ["ACCESSORIES"] },
  { key: "PROCESSING", label: "Printing / washing", kinds: ["PROCESSING"] },
  { key: "OTHER_DIRECT", label: "Other direct", kinds: ["OTHER_DIRECT"] },
] as const;

const KIND_LABEL: Record<string, string> = {
  FABRIC_CONSUMED: "Fabric consumed",
  FABRIC_WASTAGE: "Fabric wastage",
  CUTTING_LABOUR: "Cutting labour",
  STITCHING_LABOUR: "Stitching labour",
  PACKING_LABOUR: "Packing labour",
  ACCESSORIES: "Accessories",
  PROCESSING: "Printing / embroidery / washing",
  OTHER_DIRECT: "Other direct cost",
};

const pad = (prefix: string, number: number) => `${prefix}-${String(number).padStart(4, "0")}`;

const money = (value: string | number | Prisma.Decimal) => new Prisma.Decimal(value).toFixed(2);

/** "44.730000" → "44.73", "3" → "3". */
const qty = (value: string) => new Prisma.Decimal(value).toDecimalPlaces(3).toString();

const LOT_STATUSES = ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"] as const;

export const lotListSchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(LOT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const addCostSchema = z.strictObject({
  kind: z.enum(MANUAL_KINDS, { error: "Choose what the cost is." }),
  amount: z
    .number({ error: "Enter the amount." })
    .positive("Enter an amount above zero.")
    .max(99_999_999, "Amount is too large.")
    .multipleOf(0.01, "Use at most 2 decimals (paisa)."),
  entryDate: businessDate,
  note: z.string().trim().min(3, "Say what it is for (at least 3 characters).").max(300),
  reference: z
    .string()
    .trim()
    .max(60, "Keep the reference under 60 characters.")
    .nullish()
    .transform((value) => value || null),
});

export const removeSchema = z.strictObject({
  reason: z.string().trim().min(3, "Give a reason (at least 3 characters).").max(300),
});

const idSchema = z.object({ id: z.uuid() });

/** Per-lot totals: cost by kind, pieces at each stage. */
const LOT_TOTALS = Prisma.sql`
  SELECT l.id, l.lot_number, l.article_name, l.article_code, l.status, f.name AS fabric_name,
         COALESCE(c.total, 0)::text AS total,
         COALESCE(c.by_kind, '{}'::jsonb) AS by_kind,
         COALESCE(o.cut, 0)::int AS cut,
         COALESCE(g.good, 0)::int AS good,
         COALESCE(p.packed, 0)::int AS packed
  FROM production_lots l
  JOIN fabrics f ON f.id = l.fabric_id
  LEFT JOIN LATERAL (
    SELECT sum(k.amount) AS total, jsonb_object_agg(k.kind, k.amount) AS by_kind
    FROM (SELECT kind, sum(amount) AS amount FROM lot_costs WHERE lot_id = l.id GROUP BY kind) k
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT sum(o.accepted_quantity) AS cut FROM cutting_outputs o
    JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED' WHERE o.lot_id = l.id
  ) o ON true
  LEFT JOIN LATERAL (
    SELECT (SELECT COALESCE(sum(good), 0) FROM stitching_receipts WHERE lot_id = l.id AND status = 'POSTED')
         + (SELECT COALESCE(sum(recovered), 0) FROM rework_items WHERE lot_id = l.id AND status <> 'CANCELLED') AS good
  ) g ON true
  LEFT JOIN LATERAL (
    SELECT sum(pieces) AS packed FROM packing_entries WHERE lot_id = l.id AND status = 'POSTED'
  ) p ON true`;

interface TotalsRow {
  id: string;
  lot_number: string;
  article_name: string;
  article_code: string;
  status: string;
  fabric_name: string;
  total: string;
  by_kind: Record<string, string | number>;
  cut: number;
  good: number;
  packed: number;
}

function summary(row: TotalsRow) {
  const total = new Prisma.Decimal(row.total);
  const groups = COST_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    amount: money(group.kinds.reduce((sum, kind) => sum.plus(row.by_kind[kind] ?? 0), new Prisma.Decimal(0))),
  }));

  return {
    id: row.id,
    lotNumber: row.lot_number,
    article: { code: row.article_code, name: row.article_name },
    fabricName: row.fabric_name,
    status: row.status,
    total: money(total),
    groups,
    pieces: { cut: row.cut, good: row.good, packed: row.packed },
    /** Null with nothing packed yet: never 0 and never a division by zero. */
    perPiece: row.packed > 0 ? total.dividedBy(row.packed).toFixed(2) : null,
    /** Final once the lot is completed; until then the figure moves as work and costs post. */
    final: row.status === "COMPLETED",
  };
}

async function lotSummary(id: string) {
  const [row] = await prisma.$queryRaw<TotalsRow[]>`${LOT_TOTALS} WHERE l.id = ${id}::uuid`;

  if (!row) throw errors.notFound("Lot");

  return summary(row);
}

interface LineRow {
  id: string;
  kind: string;
  entry_date: string;
  quantity: string;
  rate: string;
  amount: string;
  note: string | null;
  reference: string | null;
  reversal_of: string | null;
  reversed: boolean;
  created_by: string;
  created_at: Date;
  batch_number: number | null;
  receipt_number: number | null;
  receipt_team: string | null;
  rework_number: number | null;
  packing_number: number | null;
  packing_who: string | null;
  rate_change: boolean;
  original_note: string | null;
}

/** Where an automatic cost came from, e.g. "CUT-0004" or "SR-0012 · Team Ram". */
function sourceOf(row: LineRow): string | null {
  if (row.batch_number) return pad("CUT", row.batch_number);

  if (row.receipt_number) return `${pad("SR", row.receipt_number)}${row.receipt_team ? ` · ${row.receipt_team}` : ""}`;

  if (row.rework_number) return `${pad("RW", row.rework_number)} recovered`;

  if (row.packing_number) return `${pad("PK", row.packing_number)}${row.packing_who ? ` · ${row.packing_who}` : ""}`;

  return row.rate_change ? "Rate change" : null;
}

/** Every cost line of a lot with where it came from, oldest first. */
async function lines(lotId: string) {
  const rows = await prisma.$queryRaw<LineRow[]>`
    SELECT c.id, c.kind, c.entry_date::text AS entry_date, c.quantity::text AS quantity, c.rate::text AS rate,
           c.amount::text AS amount, c.note, c.reference, c.reversal_of,
           EXISTS (SELECT 1 FROM lot_costs r WHERE r.reversal_of = c.id) AS reversed,
           u.name AS created_by, c.created_at,
           b.number AS batch_number, sr.number AS receipt_number, si.team_name AS receipt_team,
           ri.number AS rework_number, pe.number AS packing_number,
           COALESCE(pe.team_name, pe.packer_name) AS packing_who, (rc.id IS NOT NULL) AS rate_change,
           o.note AS original_note
    FROM lot_costs c
    JOIN users u ON u.id = c.created_by
    LEFT JOIN cutting_batches b ON b.id = c.batch_id
    LEFT JOIN stitching_receipts sr ON sr.id = c.source_id
    LEFT JOIN stitching_issues si ON si.id = sr.issue_id
    LEFT JOIN rework_resolutions rr ON rr.id = c.source_id
    LEFT JOIN rework_items ri ON ri.id = rr.rework_id
    LEFT JOIN packing_entries pe ON pe.id = c.source_id
    LEFT JOIN rate_changes rc ON rc.id = c.source_id
    LEFT JOIN lot_costs o ON o.id = c.reversal_of
    WHERE c.lot_id = ${lotId}::uuid
    ORDER BY c.entry_date, c.seq`;

  return rows.map((row) => {
    const manual = (MANUAL_KINDS as readonly string[]).includes(row.kind);
    const quantity = qty(row.quantity);

    return {
      id: row.id,
      kind: row.kind,
      label: KIND_LABEL[row.kind] ?? row.kind,
      date: row.entry_date,
      /** What it is: the typed note, or the document it came from with quantity × rate. */
      description: manual
        ? (row.note ?? row.original_note ?? "")
        : [sourceOf(row), quantity !== "0" ? `${quantity} @ Rs ${money(row.rate)}` : null].filter(Boolean).join(" · "),
      reference: row.reference,
      amount: money(row.amount),
      source: manual ? ("MANUAL" as const) : ("AUTO" as const),
      reversal: row.reversal_of !== null,
      reversed: row.reversed,
      removable: manual && row.reversal_of === null && !row.reversed,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  });
}

async function addCost(actor: AuthContext, lotId: string, input: z.infer<typeof addCostSchema>, meta: ClientMeta) {
  await transaction(async (tx) => {
    const [lot] = await tx.$queryRaw<{ status: string; lot_number: string }[]>`
      SELECT status, lot_number FROM production_lots WHERE id = ${lotId}::uuid FOR UPDATE`;

    if (!lot) throw errors.notFound("Lot");

    if (lot.status === "CANCELLED") throw errors.conflict(`${lot.lot_number} is cancelled.`);

    const cost = await tx.lotCost.create({
      data: {
        lotId,
        sourceId: randomUUID(),
        kind: input.kind,
        entryDate: new Date(input.entryDate),
        quantity: 1,
        rate: input.amount,
        amount: input.amount,
        note: input.note,
        reference: input.reference,
        createdById: actor.user.id,
      },
      select: { id: true },
    });

    await recordAudit(tx, {
      type: "LOT_COST_ADDED",
      actorUserId: actor.user.id,
      sessionId: actor.sessionId,
      meta,
      metadata: { lotId, costId: cost.id, kind: input.kind, amount: money(input.amount), note: input.note },
    });
  });

  return lotSummary(lotId);
}

/** Removes a hand-added cost with an opposite row; costs posted by documents follow their documents. */
async function removeCost(actor: AuthContext, id: string, reason: string, meta: ClientMeta) {
  const lotId = await transaction(async (tx) => {
    const [cost] = await tx.$queryRaw<
      {
        lot_id: string;
        kind: string;
        amount: string;
        quantity: string;
        rate: string;
        source_id: string;
        reversal_of: string | null;
      }[]
    >`SELECT lot_id, kind, amount::text AS amount, quantity::text AS quantity, rate::text AS rate, source_id,
             reversal_of
      FROM lot_costs WHERE id = ${id}::uuid FOR UPDATE`;

    if (!cost) throw errors.notFound("Cost");

    if (!(MANUAL_KINDS as readonly string[]).includes(cost.kind) || cost.reversal_of) {
      throw errors.conflict("Only costs added by hand can be removed here; the rest follow their documents.");
    }

    if (await tx.lotCost.findFirst({ where: { reversalOfId: id }, select: { id: true } })) {
      throw errors.conflict("This cost has already been removed.");
    }

    await tx.lotCost.create({
      data: {
        lotId: cost.lot_id,
        sourceId: cost.source_id,
        kind: cost.kind,
        entryDate: new Date(factoryToday()),
        quantity: new Prisma.Decimal(cost.quantity).negated(),
        rate: cost.rate,
        amount: new Prisma.Decimal(cost.amount).negated(),
        reversalOfId: id,
        note: `Removed: ${reason}`.slice(0, 300),
        createdById: actor.user.id,
      },
    });
    await recordAudit(tx, {
      type: "LOT_COST_REMOVED",
      actorUserId: actor.user.id,
      sessionId: actor.sessionId,
      meta,
      metadata: { lotId: cost.lot_id, costId: id, kind: cost.kind, amount: money(cost.amount), reason },
    });

    return cost.lot_id;
  });

  return lotSummary(lotId);
}

const idOf = (req: Request) => idSchema.parse(req.params).id;

export function costingRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  // The whole module is money.
  const view = requirePermission("costing.view");
  const manage = requirePermission("costing.manage");

  router.get("/lots", view, (async (req, res) => {
    const query = lotListSchema.parse(req.query);
    const clauses: Prisma.Sql[] = [
      query.status ? Prisma.sql`l.status = ${query.status}` : Prisma.sql`l.status <> 'CANCELLED'`,
    ];

    if (query.search) {
      const pattern = contains(query.search);

      clauses.push(Prisma.sql`(lower(l.lot_number) LIKE ${pattern} OR lower(l.article_name) LIKE ${pattern}
        OR lower(l.article_code) LIKE ${pattern})`);
    }

    const filter = Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}`;
    const [rows, [count]] = await Promise.all([
      prisma.$queryRaw<TotalsRow[]>`${LOT_TOTALS} ${filter}
        ORDER BY (l.status = 'COMPLETED'), l.created_at DESC ${page(query)}`,
      prisma.$queryRaw<{ total: number; cost: string }[]>`
        SELECT count(*)::int AS total,
               COALESCE(sum((SELECT sum(amount) FROM lot_costs c WHERE c.lot_id = l.id)), 0)::text AS cost
        FROM production_lots l ${filter}`,
    ]);

    res.json({
      success: true,
      data: { lots: rows.map(summary), total: count!.total, totalCost: money(count!.cost) },
    });
  }) satisfies RequestHandler);

  router.get("/lots/:id", view, (async (req, res) => {
    const id = idOf(req);

    res.json({ success: true, data: { lot: await lotSummary(id), lines: await lines(id) } });
  }) satisfies RequestHandler);

  router.post("/lots/:id/costs", view, manage, (async (req, res) => {
    const id = idOf(req);
    const lot = await addCost(actorOf(req), id, addCostSchema.parse(req.body), clientMeta(req));

    res.status(201).json({ success: true, data: { lot, lines: await lines(id) } });
  }) satisfies RequestHandler);

  router.post("/costs/:id/remove", view, manage, (async (req, res) => {
    const { reason } = removeSchema.parse(req.body);
    const lot = await removeCost(actorOf(req), idOf(req), reason, clientMeta(req));

    res.json({ success: true, data: { lot, lines: await lines(lot.id) } });
  }) satisfies RequestHandler);

  return router;
}
