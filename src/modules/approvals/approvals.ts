import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { prisma, Prisma, transaction } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { actorOf, clientMeta } from "../../lib/request";
import { recordAudit } from "../audit/audit.service";
import { requireAuth } from "../auth/auth.middleware";
import { cuttingService } from "../cutting/cutting.service";
import { dashboardService } from "../dashboard/dashboard";
import { fabricService, inwardService } from "../fabrics/fabric.service";
import { godownService } from "../godown/godown.service";
import { packingService } from "../packing/packing.service";
import { paymentsService } from "../payments/payments.service";
import { requirePermission } from "../permissions/permission.middleware";
import { OWNER_ROLE } from "../permissions/permission.types";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { getSettings } from "../settings/settings";
import { stitchingService } from "../stitching/stitching.service";

// Approvals. When Settings → Approval rules ask for it, the reversal and adjustment endpoints do not
// act: they record a request here (202) and the screen says it went for approval. An approver
// (approvals.decide, never the requester) approves it, and the very same service the screen would
// have called runs as the approver, with the original reason. If the record changed since (pieces
// packed, stock used) that service refuses as usual; the request stays pending with the error so it
// can be rejected. The Owner's own corrections never wait.

export const APPROVAL_TYPES = [
  "PURCHASE_REVERSAL",
  "FABRIC_ADJUSTMENT",
  "CUTTING_REVERSAL",
  "STITCHING_ISSUE_REVERSAL",
  "STITCHING_RECEIPT_REVERSAL",
  "PACKING_REVERSAL",
  "DISPATCH_REVERSAL",
  "GODOWN_ADJUSTMENT",
  "PAYMENT_REVERSAL",
] as const;

export type ApprovalType = (typeof APPROVAL_TYPES)[number];

const ADJUSTMENTS: readonly ApprovalType[] = ["FABRIC_ADJUSTMENT", "GODOWN_ADJUSTMENT"];

export const TYPE_LABEL: Record<ApprovalType, string> = {
  PURCHASE_REVERSAL: "Reverse fabric purchase",
  FABRIC_ADJUSTMENT: "Adjust fabric stock",
  CUTTING_REVERSAL: "Reverse cutting",
  STITCHING_ISSUE_REVERSAL: "Reverse stitching issue",
  STITCHING_RECEIPT_REVERSAL: "Reverse stitching receipt",
  PACKING_REVERSAL: "Reverse packing",
  DISPATCH_REVERSAL: "Reverse dispatch",
  GODOWN_ADJUSTMENT: "Correct godown count",
  PAYMENT_REVERSAL: "Reverse payment entry",
};

/** What the screen sent, replayed on approval. Reversals carry only the reason. */
export type ApprovalPayload = { reason: string } & Record<string, string | number>;

const pad = (prefix: string, number: number) => `${prefix}-${String(number).padStart(4, "0")}`;

const qty = (value: string | number, unit: string) =>
  `${new Prisma.Decimal(value).toDecimalPlaces(3).toString()} ${unit === "METER" ? "m" : "kg"}`;

const pcs = (count: number) => `${count.toLocaleString("en-IN")} pcs`;

async function one<T>(query: Prisma.Sql): Promise<T> {
  const [row] = await prisma.$queryRaw<T[]>(query);

  if (!row) throw errors.notFound("Record");

  return row;
}

/** The record and the change, as people read them in Approvals. */
async function describe(type: ApprovalType, targetId: string, payload: ApprovalPayload) {
  switch (type) {
    case "PURCHASE_REVERSAL": {
      const row = await one<{ number: number; name: string; unit: string; quantity: string }>(Prisma.sql`
        SELECT i.number, f.name, f.unit, i.quantity::text AS quantity
        FROM fabric_inwards i JOIN fabrics f ON f.id = i.fabric_id WHERE i.id = ${targetId}::uuid`);

      return {
        title: `${pad("FI", row.number)} · ${row.name} ${qty(row.quantity, row.unit)}`,
        change: `Posted → Reversed (stock −${qty(row.quantity, row.unit)})`,
      };
    }
    case "FABRIC_ADJUSTMENT": {
      const row = await one<{ name: string; unit: string; balance: string }>(Prisma.sql`
        SELECT f.name, f.unit, s.balance::text AS balance
        FROM fabrics f JOIN fabric_stock s ON s.fabric_id = f.id WHERE f.id = ${targetId}::uuid`);
      const delta = new Prisma.Decimal(String(payload.quantity)).times(payload.direction === "OUT" ? -1 : 1);
      const after = new Prisma.Decimal(row.balance).plus(delta).toString();

      return {
        title: `${row.name} stock`,
        change: `${qty(row.balance, row.unit)} → ${qty(after, row.unit)} (${delta.isNegative() ? "−" : "+"}${qty(
          delta.abs().toString(),
          row.unit,
        )})`,
      };
    }
    case "CUTTING_REVERSAL": {
      const row = await one<{ number: number; lot_number: string; pieces: number | null }>(Prisma.sql`
        SELECT b.number, l.lot_number, b.total_accepted_pieces AS pieces
        FROM cutting_batches b JOIN production_lots l ON l.id = b.lot_id WHERE b.id = ${targetId}::uuid`);

      return {
        title: `${pad("CUT", row.number)} · ${row.lot_number}`,
        change: `Finalized → Reversed (${pcs(row.pieces ?? 0)} cut, fabric back to store)`,
      };
    }
    case "STITCHING_ISSUE_REVERSAL": {
      const row = await one<{ number: number; lot_number: string; team_name: string; pieces: number }>(Prisma.sql`
        SELECT i.number, l.lot_number, i.team_name,
               (SELECT COALESCE(sum(quantity), 0)::int FROM stitching_issue_lines WHERE issue_id = i.id) AS pieces
        FROM stitching_issues i JOIN production_lots l ON l.id = i.lot_id WHERE i.id = ${targetId}::uuid`);

      return {
        title: `${pad("SI", row.number)} · ${row.lot_number} · ${row.team_name}`,
        change: `Issued ${pcs(row.pieces)} → Reversed (pieces wait for stitching again)`,
      };
    }
    case "STITCHING_RECEIPT_REVERSAL": {
      const row = await one<{ number: number; lot_number: string; team_name: string; good: number }>(Prisma.sql`
        SELECT r.number, l.lot_number, i.team_name, r.good
        FROM stitching_receipts r JOIN stitching_issues i ON i.id = r.issue_id
        JOIN production_lots l ON l.id = r.lot_id WHERE r.id = ${targetId}::uuid`);

      return {
        title: `${pad("SR", row.number)} · ${row.lot_number} · ${row.team_name}`,
        change: `Received ${pcs(row.good)} Good → Reversed (pieces back with the team, pay taken back)`,
      };
    }
    case "PACKING_REVERSAL": {
      const row = await one<{ number: number; lot_number: string; who: string; pieces: number }>(Prisma.sql`
        SELECT e.number, l.lot_number, COALESCE(e.team_name, e.packer_name) AS who, e.pieces
        FROM packing_entries e JOIN production_lots l ON l.id = e.lot_id WHERE e.id = ${targetId}::uuid`);

      return {
        title: `${pad("PK", row.number)} · ${row.lot_number} · ${row.who}`,
        change: `Packed ${pcs(row.pieces)} → Reversed (out of the godown, pay taken back)`,
      };
    }
    case "DISPATCH_REVERSAL": {
      const row = await one<{ number: number; party: string; pieces: number }>(Prisma.sql`
        SELECT number, party, pieces FROM dispatches WHERE id = ${targetId}::uuid`);

      return {
        title: `${pad("DS", row.number)} · ${row.party}`,
        change: `Dispatched ${pcs(row.pieces)} → Reversed (back into the godown)`,
      };
    }
    case "GODOWN_ADJUSTMENT": {
      const row = await one<{ name: string; balance: number }>(Prisma.sql`
        SELECT a.name, COALESCE((SELECT balance FROM godown_stock
                                 WHERE article_id = a.id AND size_label = ${String(payload.sizeLabel)}), 0)::int AS balance
        FROM articles a WHERE a.id = ${targetId}::uuid`);
      const counted = Number(payload.counted);
      const delta = counted - row.balance;

      return {
        title: `${row.name} · ${String(payload.sizeLabel)}`,
        change: `In godown ${pcs(row.balance)} → counted ${pcs(counted)} (${delta >= 0 ? "+" : "−"}${Math.abs(delta)})`,
      };
    }
    case "PAYMENT_REVERSAL": {
      const row = await one<{ name: string; description: string; amount: string }>(Prisma.sql`
        SELECT k.name, l.description, l.amount::text AS amount
        FROM karigar_ledger l JOIN karigars k ON k.id = l.karigar_id WHERE l.id = ${targetId}::uuid`);

      return {
        title: `${row.name} · ${row.description}`,
        change: `Rs ${new Prisma.Decimal(row.amount).abs().toFixed(2)} recorded → Reversed`,
      };
    }
  }
}

/** Runs the correction itself, exactly as the screen's endpoint would have. */
async function execute(
  type: ApprovalType,
  actor: AuthContext,
  targetId: string,
  payload: ApprovalPayload,
  meta: ClientMeta,
) {
  const reason = payload.reason;

  switch (type) {
    case "PURCHASE_REVERSAL":
      return inwardService.reverse(actor, targetId, reason, meta);
    case "FABRIC_ADJUSTMENT":
      return fabricService.adjust(
        actor,
        targetId,
        { direction: payload.direction === "OUT" ? "OUT" : "IN", quantity: Number(payload.quantity), reason },
        meta,
      );
    case "CUTTING_REVERSAL":
      return cuttingService.reverse(actor, targetId, reason, meta, actor.user.permissions.has("costing.view"));
    case "STITCHING_ISSUE_REVERSAL":
      return stitchingService.reverseIssue(actor, targetId, reason, meta);
    case "STITCHING_RECEIPT_REVERSAL":
      return stitchingService.reverseReceipt(actor, targetId, reason, meta);
    case "PACKING_REVERSAL":
      return packingService.reverse(actor, targetId, reason, meta);
    case "DISPATCH_REVERSAL":
      return godownService.reverseDispatch(actor, targetId, reason, meta);
    case "GODOWN_ADJUSTMENT":
      return godownService.adjust(
        actor,
        {
          date: String(payload.date),
          articleId: targetId,
          sizeLabel: String(payload.sizeLabel),
          counted: Number(payload.counted),
          reason,
        },
        meta,
      );
    case "PAYMENT_REVERSAL":
      return paymentsService.reverse(actor, targetId, reason, meta);
  }
}

const REQUEST_INCLUDE = {
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { name: true } },
} satisfies Prisma.ApprovalRequestInclude;

type RequestRow = Prisma.ApprovalRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

const dto = (row: RequestRow) => ({
  id: row.id,
  number: row.number,
  type: row.type as ApprovalType,
  typeLabel: TYPE_LABEL[row.type as ApprovalType],
  targetId: row.targetId,
  title: row.title,
  change: row.change,
  reason: row.reason,
  status: row.status as "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED",
  requestedBy: row.requestedBy,
  requestedAt: row.requestedAt,
  decidedBy: row.decidedBy?.name ?? null,
  decidedAt: row.decidedAt,
  comment: row.comment,
  lastError: row.lastError,
});

export type ApprovalDto = ReturnType<typeof dto>;

/**
 * Called by a reversal/adjustment endpoint before it acts. Returns null when the correction may go
 * ahead now (rule off, or the Owner), or the request it recorded instead.
 */
export async function approvalGate(
  actor: AuthContext,
  meta: ClientMeta,
  request: { type: ApprovalType; targetId: string; payload: ApprovalPayload },
): Promise<ApprovalDto | null> {
  const settings = await getSettings();
  const needed = ADJUSTMENTS.includes(request.type) ? settings.approveAdjustments : settings.approveReversals;

  if (!needed || actor.user.role.key === OWNER_ROLE) return null;

  const described = await describe(request.type, request.targetId, request.payload);

  try {
    return await transaction(async (tx) => {
      const created = await tx.approvalRequest.create({
        data: {
          type: request.type,
          targetId: request.targetId,
          payload: request.payload,
          title: described.title.slice(0, 200),
          change: described.change.slice(0, 300),
          reason: request.payload.reason,
          requestedById: actor.user.id,
        },
        include: REQUEST_INCLUDE,
      });

      await recordAudit(tx, {
        type: "APPROVAL_REQUESTED",
        actorUserId: actor.user.id,
        sessionId: actor.sessionId,
        meta,
        metadata: { approvalId: created.id, type: request.type, targetId: request.targetId, reason: created.reason },
      });

      return dto(created);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw errors.conflict("A request to reverse this is already waiting in Approvals.");
    }

    throw error;
  }
}

/** For endpoints: sends 202 with the request when the gate held the correction, and says so. */
export async function heldForApproval(
  req: Request,
  res: Response,
  request: { type: ApprovalType; targetId: string; payload: ApprovalPayload },
): Promise<boolean> {
  const approval = await approvalGate(actorOf(req), clientMeta(req), request);

  if (!approval) return false;

  res.status(202).json({ success: true, data: { approval } });

  return true;
}

const listSchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const approveSchema = z.strictObject({
  comment: z
    .string()
    .trim()
    .max(500, "Keep the comment under 500 characters.")
    .nullish()
    .transform((value) => value || null),
});

const rejectSchema = z.strictObject({
  comment: z.string().trim().min(3, "Say why (at least 3 characters).").max(500),
});

const idSchema = z.object({ id: z.uuid() });

async function lockPending(tx: Prisma.TransactionClient, id: string) {
  const [row] = await tx.$queryRaw<{ status: string; requested_by: string }[]>`
    SELECT status, requested_by FROM approval_requests WHERE id = ${id}::uuid FOR UPDATE`;

  if (!row) throw errors.notFound("Request");

  if (row.status !== "PENDING") throw errors.conflict(`This request is already ${row.status.toLowerCase()}.`);

  return row;
}

const auditOf = (actor: AuthContext, meta: ClientMeta) => ({
  actorUserId: actor.user.id,
  sessionId: actor.sessionId,
  meta,
});

export const approvalsService = {
  /** Approvers see every request; everyone else sees their own. */
  async list(actor: AuthContext, query: z.infer<typeof listSchema>) {
    const mineOnly = !actor.user.permissions.has("approvals.decide");
    const scope: Prisma.ApprovalRequestWhereInput = mineOnly ? { requestedById: actor.user.id } : {};
    const where = { ...scope, ...(query.status ? { status: query.status } : {}) };
    const [rows, total, counts] = await Promise.all([
      prisma.approvalRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: [{ requestedAt: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.approvalRequest.count({ where }),
      prisma.approvalRequest.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
    ]);
    const count = (status: string) => counts.find((row) => row.status === status)?._count._all ?? 0;

    return {
      requests: rows.map(dto),
      total,
      counts: {
        PENDING: count("PENDING"),
        APPROVED: count("APPROVED"),
        REJECTED: count("REJECTED"),
        CANCELLED: count("CANCELLED"),
        ALL: counts.reduce((sum, row) => sum + row._count._all, 0),
      },
      canDecide: !mineOnly,
    };
  },

  /** Pending requests the actor can act on: others' to decide (approvers), else their own. */
  pendingCount(actor: AuthContext) {
    return prisma.approvalRequest.count({
      where: actor.user.permissions.has("approvals.decide")
        ? { status: "PENDING", requestedById: { not: actor.user.id } }
        : { status: "PENDING", requestedById: actor.user.id },
    });
  },

  async approve(actor: AuthContext, id: string, comment: string | null, meta: ClientMeta) {
    const request = await prisma.approvalRequest.findUnique({ where: { id } });

    if (!request) throw errors.notFound("Request");

    if (request.status !== "PENDING") {
      throw errors.conflict(`This request is already ${request.status.toLowerCase()}.`);
    }

    if (request.requestedById === actor.user.id) {
      throw new AppError(403, ErrorCode.AUTH_FORBIDDEN, "Someone else must approve your own request.");
    }

    // Claim it first, so two approvers cannot both run the correction.
    const claimed = await prisma.approvalRequest.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "APPROVED", decidedById: actor.user.id, decidedAt: new Date(), comment, lastError: null },
    });

    if (claimed.count === 0) throw errors.conflict("Someone else has just decided this request.");

    try {
      await execute(request.type as ApprovalType, actor, request.targetId, request.payload as ApprovalPayload, meta);
    } catch (error) {
      // The record changed since the request, or the correction is no longer possible: keep it open.
      const message = error instanceof AppError ? error.message : "The correction could not be made.";

      await prisma.approvalRequest.update({
        where: { id },
        data: {
          status: "PENDING",
          decidedById: null,
          decidedAt: null,
          comment: null,
          lastError: message.slice(0, 500),
        },
      });

      throw error;
    }

    await recordAudit(prisma, {
      type: "APPROVAL_APPROVED",
      ...auditOf(actor, meta),
      metadata: { approvalId: id, type: request.type, targetId: request.targetId, comment },
    });

    return dto((await prisma.approvalRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE }))!);
  },

  async reject(actor: AuthContext, id: string, comment: string, meta: ClientMeta) {
    return transaction(async (tx) => {
      const row = await lockPending(tx, id);

      if (row.requested_by === actor.user.id) {
        throw new AppError(403, ErrorCode.AUTH_FORBIDDEN, "Cancel your own request instead.");
      }

      const updated = await tx.approvalRequest.update({
        where: { id },
        data: { status: "REJECTED", decidedById: actor.user.id, decidedAt: new Date(), comment },
        include: REQUEST_INCLUDE,
      });

      await recordAudit(tx, {
        type: "APPROVAL_REJECTED",
        ...auditOf(actor, meta),
        metadata: { approvalId: id, type: updated.type, comment },
      });

      return dto(updated);
    });
  },

  /** The requester withdraws their own pending request. */
  async cancel(actor: AuthContext, id: string, meta: ClientMeta) {
    return transaction(async (tx) => {
      const row = await lockPending(tx, id);

      if (row.requested_by !== actor.user.id) {
        throw new AppError(403, ErrorCode.AUTH_FORBIDDEN, "Only the person who asked can cancel a request.");
      }

      const updated = await tx.approvalRequest.update({
        where: { id },
        data: { status: "CANCELLED", decidedById: actor.user.id, decidedAt: new Date() },
        include: REQUEST_INCLUDE,
      });

      await recordAudit(tx, {
        type: "APPROVAL_CANCELLED",
        ...auditOf(actor, meta),
        metadata: { approvalId: id, type: updated.type },
      });

      return dto(updated);
    });
  },
};

const idOf = (req: Request) => idSchema.parse(req.params).id;

export function approvalRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  router.get("/", (async (req, res) => {
    res.json({ success: true, data: await approvalsService.list(actorOf(req), listSchema.parse(req.query)) });
  }) satisfies RequestHandler);

  // The header bell: things waiting on someone, each only for people who may see that area.
  router.get("/alerts", (async (req, res) => {
    const actor = actorOf(req);
    const has = (permission: Parameters<typeof actor.user.permissions.has>[0]) =>
      actor.user.permissions.has(permission);
    const [approvals, waiting, [low]] = await Promise.all([
      approvalsService.pendingCount(actor),
      dashboardService.waiting({
        stitching: has("stitching.view"),
        packing: has("packing.view"),
        fabric: has("fabric.view"),
      }),
      prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM fabrics f JOIN fabric_stock s ON s.fabric_id = f.id
        WHERE f.low_stock_threshold > 0 AND s.balance <= f.low_stock_threshold`,
    ]);
    const items = [
      approvals > 0 && {
        key: "approvals",
        label: has("approvals.decide") ? "Corrections to approve" : "Your requests waiting",
        count: approvals,
        href: "/approvals",
      },
      (waiting.stitchingRates?.issues ?? 0) > 0 && {
        key: "stitching-rates",
        label: "Stitching issues need a rate",
        count: waiting.stitchingRates!.issues,
        href: "/stitching?ratePending=1",
      },
      (waiting.packingRates?.entries ?? 0) > 0 && {
        key: "packing-rates",
        label: "Packing entries need a rate",
        count: waiting.packingRates!.entries,
        href: "/packing?tab=entries&ratePending=1",
      },
      (waiting.fabricBills?.purchases ?? 0) > 0 && {
        key: "fabric-bills",
        label: "Fabric waiting for its bill",
        count: waiting.fabricBills!.purchases,
        href: "/fabric/purchases?billStatus=PENDING",
      },
      has("fabric.view") &&
        low!.count > 0 && {
          key: "low-fabric",
          label: "Fabrics low on stock",
          count: low!.count,
          href: "/fabric/ledger",
        },
    ].filter(Boolean);

    res.json({ success: true, data: { items } });
  }) satisfies RequestHandler);

  router.get("/pending-count", (async (req, res) => {
    res.json({ success: true, data: { count: await approvalsService.pendingCount(actorOf(req)) } });
  }) satisfies RequestHandler);

  router.post("/:id/approve", requirePermission("approvals.decide"), (async (req, res) => {
    const { comment } = approveSchema.parse(req.body ?? {});
    const request = await approvalsService.approve(actorOf(req), idOf(req), comment, clientMeta(req));

    res.json({ success: true, data: { request } });
  }) satisfies RequestHandler);

  router.post("/:id/reject", requirePermission("approvals.decide"), (async (req, res) => {
    const { comment } = rejectSchema.parse(req.body);
    const request = await approvalsService.reject(actorOf(req), idOf(req), comment, clientMeta(req));

    res.json({ success: true, data: { request } });
  }) satisfies RequestHandler);

  router.post("/:id/cancel", (async (req, res) => {
    const request = await approvalsService.cancel(actorOf(req), idOf(req), clientMeta(req));

    res.json({ success: true, data: { request } });
  }) satisfies RequestHandler);

  return router;
}
