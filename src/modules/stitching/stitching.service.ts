import { prisma, Prisma, transaction } from "../../db/prisma";
import { factoryToday } from "../../lib/business-date";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { columnFilters, contains, orderBy, page, where } from "../../lib/list-query";
import { recordAudit } from "../audit/audit.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import {
  ISSUE_COLUMNS,
  REJECT_COLUMNS,
  REWORK_COLUMNS,
  type IssueInput,
  type IssueListQuery,
  type ReceiptInput,
  type RejectListQuery,
  type ReworkListQuery,
  type ReworkResolveInput,
} from "./stitching.schema";
import { paisaText, splitEarning, toPaisa, type SplitMember, type SplitMethod } from "./stitching.split";

// Stitching: cut pieces issued to a Jogadi team (drawing down cutting output), then
// received back as Good / Rework / Reject. Every receipt pays the team for its Good
// pieces, split over the members frozen on the issue, into each karigar's ledger and
// the lot's labour cost, in one transaction. Corrections are reversals.
//
// Lock order: lot, then issue, then receipt / rework item, then cutting outputs.

type Tx = Prisma.TransactionClient;

export const issueNumber = (number: number) => `SI-${String(number).padStart(4, "0")}`;

export const receiptNumber = (number: number) => `SR-${String(number).padStart(4, "0")}`;

export const reworkNumber = (number: number) => `RW-${String(number).padStart(4, "0")}`;

function fieldError(path: string, message: string): AppError {
  return new AppError(400, ErrorCode.VALIDATION_ERROR, message, { [path]: [message] });
}

function audit(actor: AuthContext, meta: ClientMeta) {
  return { actorUserId: actor.user.id, sessionId: actor.sessionId, meta };
}

const today = () => new Date(factoryToday());

const pcs = (count: number) => `${count.toLocaleString("en-IN")} piece${count === 1 ? "" : "s"}`;

/** "SI-12", "si12" or "12" → 12, so document numbers are searchable. */
function numberOf(text: string, prefix: string): number | null {
  const match = new RegExp(`^(?:${prefix}-?)?0*(\\d{1,9})$`, "i").exec(text.trim());

  return match ? Number(match[1]) : null;
}

interface OutputRow {
  id: string;
  colour_name: string;
  size_label: string;
  available: number;
  accepted: number;
}

/** The lot's finalized cutting output, locked, oldest cutting first. */
function lockOutputs(tx: Tx, lotId: string) {
  return tx.$queryRaw<OutputRow[]>`
    SELECT o.id, o.colour_name, o.size_label, o.available_for_stitching AS available, o.accepted_quantity AS accepted
    FROM cutting_outputs o JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED'
    WHERE o.lot_id = ${lotId}::uuid
    ORDER BY b.number, o.position
    FOR UPDATE OF o`;
}

async function setAvailable(tx: Tx, rows: Map<string, number>): Promise<void> {
  if (rows.size === 0) return;

  const values = [...rows].map(([id, available]) => Prisma.sql`(${id}::uuid, ${available}::int)`);

  await tx.$executeRaw`
    UPDATE cutting_outputs o SET available_for_stitching = v.available
    FROM (VALUES ${Prisma.join(values)}) AS v (id, available) WHERE o.id = v.id`;
}

async function lockLot(tx: Tx, lotId: string, path = "lotId") {
  const [lot] = await tx.$queryRaw<{ id: string; lot_number: string; status: string }[]>`
    SELECT id, lot_number, status FROM production_lots WHERE id = ${lotId}::uuid FOR UPDATE`;

  if (!lot) throw fieldError(path, "Choose a lot.");

  return lot;
}

interface LockedIssue {
  id: string;
  number: number;
  lot_id: string;
  lot_number: string;
  team_name: string;
  rate: string;
  split_method: "EQUAL" | "PERCENT";
  status: string;
}

/** Locks an issue after its lot (the lot is looked up first, unlocked, to keep the lock order). */
async function lockIssue(tx: Tx, issueId: string): Promise<LockedIssue> {
  const found = await tx.stitchingIssue.findUnique({ where: { id: issueId }, select: { lotId: true } });

  if (!found) throw errors.notFound("Stitching issue");

  await lockLot(tx, found.lotId);

  const [issue] = await tx.$queryRaw<LockedIssue[]>`
    SELECT i.id, i.number, i.lot_id, l.lot_number, i.team_name, i.rate::text AS rate, i.split_method, i.status
    FROM stitching_issues i JOIN production_lots l ON l.id = i.lot_id
    WHERE i.id = ${issueId}::uuid FOR UPDATE OF i`;

  return issue!;
}

async function snapshotMembers(tx: Tx, issueId: string): Promise<(SplitMember & { name: string })[]> {
  const members = await tx.stitchingIssueMember.findMany({
    where: { issueId },
    orderBy: { karigarName: "asc" },
  });

  return members.map((member) => ({
    karigarId: member.karigarId,
    name: member.karigarName,
    shareHundredths: member.sharePercent === null ? null : Math.round(member.sharePercent.toNumber() * 100),
  }));
}

/**
 * Posts a team earning: one ledger row per member who gets money, plus the lot's
 * stitching labour cost. sourceType/sourceId make a repeat posting impossible.
 */
async function postEarning(
  tx: Tx,
  actor: AuthContext,
  posting: {
    sourceType: "STITCHING" | "REWORK";
    sourceId: string;
    lotId: string;
    date: Date;
    pieces: number;
    rate: string;
    amounts: Map<string, bigint>;
    description: string;
  },
): Promise<bigint> {
  const total = [...posting.amounts.values()].reduce((sum, amount) => sum + amount, 0n);

  if (total === 0n) return 0n;

  await tx.karigarLedgerEntry.createMany({
    data: [...posting.amounts].flatMap(([karigarId, amount]) =>
      amount > 0n
        ? [
            {
              karigarId,
              entryDate: posting.date,
              type: "EARNING",
              payMode: "PER_PIECE",
              quantity: posting.pieces,
              rate: posting.rate,
              amount: paisaText(amount),
              sourceType: posting.sourceType,
              sourceId: posting.sourceId,
              description: posting.description,
              createdById: actor.user.id,
            },
          ]
        : [],
    ),
  });
  await tx.lotCost.create({
    data: {
      lotId: posting.lotId,
      sourceId: posting.sourceId,
      kind: "STITCHING_LABOUR",
      entryDate: posting.date,
      quantity: posting.pieces,
      rate: posting.rate,
      amount: paisaText(total),
      createdById: actor.user.id,
    },
  });

  return total;
}

/** Posts negative twins of a source's earnings and labour cost. */
async function reverseEarning(
  tx: Tx,
  actor: AuthContext,
  sourceType: "STITCHING" | "REWORK",
  sourceId: string,
  note: string,
) {
  const date = today();

  const [entries, costs] = await Promise.all([
    tx.karigarLedgerEntry.findMany({ where: { sourceType, sourceId, type: "EARNING" } }),
    tx.lotCost.findMany({ where: { sourceId, kind: "STITCHING_LABOUR", reversalOfId: null } }),
  ]);

  if (entries.length > 0) {
    await tx.karigarLedgerEntry.createMany({
      data: entries.map((entry) => ({
        karigarId: entry.karigarId,
        entryDate: date,
        type: "EARNING_REVERSAL",
        payMode: entry.payMode,
        quantity: entry.quantity.negated(),
        rate: entry.rate,
        amount: entry.amount.negated(),
        sourceType,
        sourceId,
        description: `${entry.description} · reversed: ${note}`.slice(0, 500),
        createdById: actor.user.id,
      })),
    });
  }

  if (costs.length > 0) {
    await tx.lotCost.createMany({
      data: costs.map((cost) => ({
        lotId: cost.lotId,
        sourceId,
        kind: cost.kind,
        entryDate: date,
        quantity: cost.quantity.negated(),
        rate: cost.rate,
        amount: cost.amount.negated(),
        reversalOfId: cost.id,
        createdById: actor.user.id,
      })),
    });
  }
}

/** Ledger split for a team receipt, per its method; amounts need costing.view to have been chosen. */
function receiptSplit(
  input: ReceiptInput["split"],
  issue: LockedIssue,
  members: (SplitMember & { name: string })[],
  total: bigint,
) {
  const method: SplitMethod = input?.method ?? issue.split_method;
  const given = new Map((input?.members ?? []).map((member) => [member.karigarId, member]));

  if (
    input &&
    input.members.length > 0 &&
    input.members.some((member) => !members.some((m) => m.karigarId === member.karigarId))
  ) {
    throw fieldError("split", "Split the earning only over the team members of this issue.");
  }

  const splitMembers: SplitMember[] = members.map((member) => {
    const chosen = given.get(member.karigarId);

    return {
      karigarId: member.karigarId,
      shareHundredths:
        method === "PERCENT"
          ? chosen?.percent !== undefined && chosen.percent !== null
            ? Math.round(chosen.percent * 100)
            : given.size > 0
              ? 0
              : (member.shareHundredths ?? null)
          : null,
      amountPaisa: method === "AMOUNT" ? toPaisa(chosen?.amount ?? 0) : null,
    };
  });

  if (method === "PERCENT" && splitMembers.every((member) => member.shareHundredths === null)) {
    throw fieldError("split", "Enter each member's share.");
  }

  const result = splitEarning(total, method, splitMembers);

  if (!result.ok) throw fieldError("split", result.message);

  return { method, amounts: result.amounts };
}

export const stitchingService = {
  /** Lots with cut pieces still waiting for stitching, for the issue form. */
  async availableLots(search: string | undefined) {
    const filter = search ? Prisma.sql`AND l.search_text LIKE ${contains(search)}` : Prisma.empty;

    return prisma.$queryRaw<{ id: string; lotNumber: string; articleName: string; available: number }[]>`
      SELECT l.id, l.lot_number AS "lotNumber", l.article_name AS "articleName",
             sum(o.available_for_stitching)::int AS available
      FROM production_lots l
      JOIN cutting_outputs o ON o.lot_id = l.id
      JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED'
      WHERE l.status <> 'CANCELLED' ${filter}
      GROUP BY l.id
      HAVING sum(o.available_for_stitching) > 0
      ORDER BY max(l.production_date) DESC, l.lot_number
      LIMIT 50`;
  },

  /**
   * Where every piece of a lot is, per colour and size: cut, waiting (unissued),
   * with the teams (WIP), received, Good, rework pending and rejected.
   */
  async lotBalance(lotId: string) {
    const lot = await prisma.productionLot.findUnique({
      where: { id: lotId },
      select: { id: true, lotNumber: true, articleName: true, status: true },
    });

    if (!lot) throw errors.notFound("Production lot");

    const rows = await prisma.$queryRaw<
      {
        colour: string;
        size: string;
        cut: number;
        unissued: number;
        issued: number;
        received: number;
        good: number;
        rework: number;
        reject: number;
      }[]
    >`
      WITH cut AS (
        SELECT o.colour_name AS colour, o.size_label AS size, min(b.number) AS batch, min(o.position) AS position,
               sum(o.accepted_quantity)::int AS cut, sum(o.available_for_stitching)::int AS unissued
        FROM cutting_outputs o JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED'
        WHERE o.lot_id = ${lotId}::uuid GROUP BY 1, 2
      ), issued AS (
        SELECT l.colour, l.size_label AS size, sum(l.quantity)::int AS issued, sum(l.received)::int AS received
        FROM stitching_issue_lines l JOIN stitching_issues i ON i.id = l.issue_id AND i.status = 'POSTED'
        WHERE i.lot_id = ${lotId}::uuid GROUP BY 1, 2
      ), received AS (
        SELECT rl.colour, rl.size_label AS size, sum(rl.good)::int AS good, sum(rl.reject)::int AS reject
        FROM stitching_receipt_lines rl JOIN stitching_receipts r ON r.id = rl.receipt_id AND r.status = 'POSTED'
        WHERE r.lot_id = ${lotId}::uuid GROUP BY 1, 2
      ), rework AS (
        SELECT colour, size_label AS size, sum(recovered)::int AS recovered, sum(failed)::int AS failed,
               sum(quantity - recovered - failed)::int AS pending
        FROM rework_items WHERE lot_id = ${lotId}::uuid AND status <> 'CANCELLED' GROUP BY 1, 2
      )
      SELECT c.colour, c.size, c.cut, c.unissued,
             COALESCE(i.issued, 0) AS issued, COALESCE(i.received, 0) AS received,
             (COALESCE(r.good, 0) + COALESCE(w.recovered, 0))::int AS good,
             COALESCE(w.pending, 0) AS rework,
             (COALESCE(r.reject, 0) + COALESCE(w.failed, 0))::int AS reject
      FROM cut c
      LEFT JOIN issued i ON i.colour = c.colour AND i.size = c.size
      LEFT JOIN received r ON r.colour = c.colour AND r.size = c.size
      LEFT JOIN rework w ON w.colour = c.colour AND w.size = c.size
      ORDER BY c.batch, c.colour, c.position`;

    const lines = rows.map((row) => ({ ...row, wip: row.issued - row.received }));
    const sum = (key: keyof (typeof lines)[number]) => lines.reduce((total, row) => total + Number(row[key]), 0);

    return {
      lot: { id: lot.id, lotNumber: lot.lotNumber, articleName: lot.articleName, status: lot.status },
      rows: lines,
      totals: {
        cut: sum("cut"),
        unissued: sum("unissued"),
        issued: sum("issued"),
        received: sum("received"),
        wip: sum("wip"),
        good: sum("good"),
        rework: sum("rework"),
        reject: sum("reject"),
      },
    };
  },

  async listIssues(query: IssueListQuery, showMoney: boolean) {
    const clauses = columnFilters(ISSUE_COLUMNS, query);

    if (query.search) {
      const pattern = contains(query.search);

      clauses.push(Prisma.sql`(lp.search_text LIKE ${pattern} OR lower(i.team_name) LIKE ${pattern}
        OR lower(i.operation) LIKE ${pattern} OR i.number = ${numberOf(query.search, "si")}::int)`);
    }

    if (query.lotId) clauses.push(Prisma.sql`i.lot_id = ${query.lotId}::uuid`);

    if (query.teamId) clauses.push(Prisma.sql`i.team_id = ${query.teamId}::uuid`);

    const filter = where(clauses);
    const order = orderBy(ISSUE_COLUMNS, query, "i.issue_date DESC", "i.number DESC");

    const from = Prisma.sql`
      FROM stitching_issues i
      JOIN production_lots lp ON lp.id = i.lot_id
      JOIN LATERAL (SELECT sum(quantity)::int AS issued, sum(received)::int AS received
                    FROM stitching_issue_lines WHERE issue_id = i.id) t ON true`;

    const [rows, [summary]] = await Promise.all([
      prisma.$queryRaw<
        {
          id: string;
          number: number;
          issue_date: string;
          status: string;
          operation: string;
          rate: string;
          team_id: string;
          team_name: string;
          lot_id: string;
          lot_number: string;
          article_name: string;
          issued: number;
          received: number;
        }[]
      >`
        SELECT i.id, i.number, i.issue_date::text AS issue_date, i.status, i.operation, i.rate::text AS rate,
               i.team_id, i.team_name, lp.id AS lot_id, lp.lot_number, lp.article_name, t.issued, t.received
        ${from} ${filter} ${order} ${page(query)}`,
      prisma.$queryRaw<{ total: number; wip: number; open: number }[]>`
        SELECT count(*)::int AS total,
               COALESCE(sum(t.issued - t.received) FILTER (WHERE i.status = 'POSTED'), 0)::int AS wip,
               count(*) FILTER (WHERE i.status = 'POSTED' AND t.issued > t.received)::int AS open
        ${from} ${filter}`,
    ]);

    return {
      issues: rows.map((row) => ({
        id: row.id,
        number: row.number,
        date: row.issue_date,
        status: row.status,
        operation: row.operation,
        rate: showMoney ? row.rate : null,
        team: { id: row.team_id, name: row.team_name },
        lot: { id: row.lot_id, lotNumber: row.lot_number, articleName: row.article_name },
        issued: row.issued,
        received: row.received,
        wip: row.status === "POSTED" ? row.issued - row.received : 0,
      })),
      total: summary!.total,
      summary: { wip: summary!.wip, open: summary!.open },
    };
  },

  async getIssue(id: string, showMoney: boolean) {
    const issue = await prisma.stitchingIssue.findUnique({
      where: { id },
      include: {
        lot: { select: { id: true, lotNumber: true, articleName: true, status: true } },
        lines: { orderBy: { position: "asc" } },
        members: { orderBy: { karigarName: "asc" } },
        createdBy: { select: { name: true } },
        reversedBy: { select: { name: true } },
        receipts: {
          orderBy: { number: "asc" },
          include: {
            lines: true,
            createdBy: { select: { name: true } },
            reversedBy: { select: { name: true } },
          },
        },
      },
      relationLoadStrategy: "join",
    });

    if (!issue) throw errors.notFound("Stitching issue");

    const earnings = showMoney
      ? await prisma.karigarLedgerEntry.findMany({
          where: {
            sourceType: "STITCHING",
            sourceId: { in: issue.receipts.map((receipt) => receipt.id) },
            type: "EARNING",
          },
          select: { sourceId: true, karigarId: true, amount: true },
        })
      : [];

    const linesById = new Map(issue.lines.map((line) => [line.id, line]));

    return {
      id: issue.id,
      number: issue.number,
      status: issue.status,
      date: issue.issueDate.toISOString().slice(0, 10),
      operation: issue.operation,
      rate: showMoney ? issue.rate.toFixed(2) : null,
      splitMethod: issue.splitMethod,
      notes: issue.notes,
      lot: issue.lot,
      team: { id: issue.teamId, name: issue.teamName },
      members: issue.members.map((member) => ({
        karigarId: member.karigarId,
        name: member.karigarName,
        sharePercent: member.sharePercent === null ? null : member.sharePercent.toNumber(),
      })),
      lines: issue.lines.map((line) => ({
        id: line.id,
        colour: line.colour,
        sizeLabel: line.sizeLabel,
        quantity: line.quantity,
        received: line.received,
        outstanding: issue.status === "POSTED" ? line.quantity - line.received : 0,
      })),
      receipts: issue.receipts.map((receipt) => ({
        id: receipt.id,
        number: receipt.number,
        status: receipt.status,
        date: receipt.receiptDate.toISOString().slice(0, 10),
        splitMethod: receipt.splitMethod,
        good: receipt.good,
        earning: showMoney ? receipt.earning.toFixed(2) : null,
        notes: receipt.notes,
        lines: receipt.lines
          .map((line) => ({
            colour: line.colour,
            sizeLabel: line.sizeLabel,
            received: line.received,
            good: line.good,
            rework: line.rework,
            reject: line.reject,
            rejectReason: line.rejectReason,
            position: linesById.get(line.issueLineId)?.position ?? 0,
          }))
          .sort((a, b) => a.position - b.position),
        allocations: showMoney
          ? earnings
              .filter((entry) => entry.sourceId === receipt.id)
              .map((entry) => ({ karigarId: entry.karigarId, amount: entry.amount.toFixed(2) }))
          : null,
        createdBy: receipt.createdBy.name,
        createdAt: receipt.createdAt,
        reversal: receipt.reversedAt
          ? { at: receipt.reversedAt, by: receipt.reversedBy?.name ?? null, reason: receipt.reversalReason }
          : null,
      })),
      createdBy: issue.createdBy.name,
      createdAt: issue.createdAt,
      reversal: issue.reversedAt
        ? { at: issue.reversedAt, by: issue.reversedBy?.name ?? null, reason: issue.reversalReason }
        : null,
    };
  },

  /**
   * Issues cut pieces of a lot to one team, or divides them between several: one issue
   * per team, all posted in one transaction. Pieces are drawn from the lot's cutting
   * output, oldest cutting first; together the teams never get more than is waiting.
   */
  async issue(actor: AuthContext, input: IssueInput, meta: ClientMeta) {
    const ids = await transaction(async (tx) => {
      const lot = await lockLot(tx, input.lotId);

      if (lot.status === "CANCELLED") throw fieldError("lotId", `${lot.lot_number} is cancelled.`);

      const teams = await tx.jogadiTeam.findMany({
        where: { id: { in: input.teams.map((team) => team.teamId) } },
        select: {
          id: true,
          name: true,
          active: true,
          members: {
            where: { leftAt: null },
            orderBy: { joinedAt: "asc" },
            select: { karigarId: true, sharePercent: true, karigar: { select: { name: true } } },
          },
        },
      });
      const teamById = new Map(teams.map((team) => [team.id, team]));

      input.teams.forEach((entry, index) => {
        const team = teamById.get(entry.teamId);

        if (!team?.active) throw fieldError(`teams.${index}.teamId`, "Choose an active Jogadi team.");

        if (team.members.length === 0) {
          throw fieldError(`teams.${index}.teamId`, `${team.name} has no members. Add them in Jogadi Teams.`);
        }
      });

      const outputs = await lockOutputs(tx, lot.id);
      const updates = new Map<string, number>();

      input.teams.forEach((entry, teamIndex) => {
        entry.lines.forEach((line, index) => {
          const matching = outputs.filter(
            (output) => output.colour_name === line.colour && output.size_label === line.sizeLabel,
          );
          const available = matching.reduce((sum, output) => sum + (updates.get(output.id) ?? output.available), 0);

          if (line.quantity > available) {
            throw fieldError(
              `teams.${teamIndex}.lines.${index}.quantity`,
              available === 0
                ? `No more ${line.colour} ${line.sizeLabel} pieces of ${lot.lot_number} are waiting for stitching.`
                : `Only ${pcs(available)} of ${line.colour} ${line.sizeLabel} ${input.teams.length > 1 ? "are left for this team" : "are waiting for stitching"}.`,
            );
          }

          let left = line.quantity;

          for (const output of matching) {
            const current = updates.get(output.id) ?? output.available;
            const take = Math.min(current, left);

            if (take > 0) updates.set(output.id, current - take);

            left -= take;
          }
        });
      });

      await setAvailable(tx, updates);

      const created: string[] = [];

      for (const entry of input.teams) {
        const team = teamById.get(entry.teamId)!;
        const shared = team.members.every((member) => member.sharePercent !== null);

        const issue = await tx.stitchingIssue.create({
          data: {
            lotId: lot.id,
            teamId: team.id,
            teamName: team.name,
            operation: input.operation,
            rate: input.rate,
            splitMethod: shared ? "PERCENT" : "EQUAL",
            issueDate: new Date(input.issueDate),
            notes: input.notes,
            createdById: actor.user.id,
            lines: {
              createMany: {
                data: entry.lines.map((line, position) => ({
                  colour: line.colour,
                  sizeLabel: line.sizeLabel,
                  position,
                  quantity: line.quantity,
                })),
              },
            },
            members: {
              createMany: {
                data: team.members.map((member) => ({
                  karigarId: member.karigarId,
                  karigarName: member.karigar.name,
                  sharePercent: shared ? member.sharePercent : null,
                })),
              },
            },
          },
          select: { id: true },
        });

        await recordAudit(tx, {
          type: "STITCHING_ISSUED",
          ...audit(actor, meta),
          metadata: {
            issueId: issue.id,
            lotId: lot.id,
            teamId: team.id,
            pieces: entry.lines.reduce((sum, line) => sum + line.quantity, 0),
          },
        });
        created.push(issue.id);
      }

      return created;
    });

    const showMoney = actor.user.permissions.has("costing.view");

    return Promise.all(ids.map((id) => this.getIssue(id, showMoney)));
  },

  /** Undoes an issue nothing has come back from: the pieces wait for stitching again. */
  async reverseIssue(actor: AuthContext, id: string, reason: string, meta: ClientMeta) {
    await transaction(async (tx) => {
      const issue = await lockIssue(tx, id);

      if (issue.status === "REVERSED") throw errors.conflict(`${issueNumber(issue.number)} has already been reversed.`);

      const lines = await tx.stitchingIssueLine.findMany({ where: { issueId: id } });

      if (lines.some((line) => line.received > 0)) {
        throw errors.conflict(
          `Pieces of ${issueNumber(issue.number)} have been received. Reverse those receipts first.`,
        );
      }

      const outputs = await lockOutputs(tx, issue.lot_id);
      const updates = new Map<string, number>();

      for (const line of lines) {
        let left = line.quantity;

        for (const output of outputs) {
          if (left === 0) break;

          if (output.colour_name !== line.colour || output.size_label !== line.sizeLabel) continue;

          const current = updates.get(output.id) ?? output.available;
          const room = Math.min(output.accepted - current, left);

          if (room > 0) updates.set(output.id, current + room);

          left -= room;
        }

        // Only possible if the cutting was reversed underneath, which issued pieces block.
        if (left > 0)
          throw errors.conflict(`The cutting of ${line.colour} ${line.sizeLabel} no longer has room for these pieces.`);
      }

      await setAvailable(tx, updates);
      await tx.stitchingIssue.update({
        where: { id },
        data: { status: "REVERSED", reversedAt: new Date(), reversedById: actor.user.id, reversalReason: reason },
      });
      await recordAudit(tx, {
        type: "STITCHING_ISSUE_REVERSED",
        ...audit(actor, meta),
        metadata: { issueId: id, reason },
      });
    });

    return this.getIssue(id, actor.user.permissions.has("costing.view"));
  },

  /**
   * Receives stitched pieces back: Good + Rework + Reject per line, never more than
   * the team still holds. Good pieces are paid now; rework goes to the rework list.
   */
  async receive(actor: AuthContext, issueId: string, input: ReceiptInput, meta: ClientMeta) {
    const showMoney = actor.user.permissions.has("costing.view");

    if (input.split?.method === "AMOUNT" && !showMoney) {
      throw new AppError(403, ErrorCode.AUTH_FORBIDDEN, "Splitting by amount needs permission to see rates and costs.");
    }

    await transaction(async (tx) => {
      const issue = await lockIssue(tx, issueId);

      if (issue.status === "REVERSED") throw errors.conflict(`${issueNumber(issue.number)} has been reversed.`);

      const lines = await tx.stitchingIssueLine.findMany({ where: { issueId } });
      const byId = new Map(lines.map((line) => [line.id, line]));

      input.lines.forEach((line, index) => {
        const issued = byId.get(line.issueLineId);

        if (!issued)
          throw fieldError(`lines.${index}.good`, "This line is not part of the issue. Reload and try again.");

        const outstanding = issued.quantity - issued.received;
        const received = line.good + line.rework + line.reject;

        if (received > outstanding) {
          throw fieldError(
            `lines.${index}.good`,
            `${issued.colour} ${issued.sizeLabel}: ${pcs(received)} entered, the team holds ${pcs(outstanding)}.`,
          );
        }
      });

      const members = await snapshotMembers(tx, issueId);
      const good = input.lines.reduce((sum, line) => sum + line.good, 0);
      const total = BigInt(good) * toPaisa(issue.rate);
      const split = receiptSplit(input.split, issue, members, total);
      const date = new Date(input.receiptDate);

      const receipt = await tx.stitchingReceipt.create({
        data: {
          issueId,
          lotId: issue.lot_id,
          receiptDate: date,
          splitMethod: split.method,
          good,
          earning: paisaText(total),
          notes: input.notes,
          createdById: actor.user.id,
        },
        select: { id: true, number: true },
      });

      const created = await tx.stitchingReceiptLine.createManyAndReturn({
        data: input.lines.map((line) => {
          const issued = byId.get(line.issueLineId)!;

          return {
            receiptId: receipt.id,
            issueLineId: line.issueLineId,
            colour: issued.colour,
            sizeLabel: issued.sizeLabel,
            received: line.good + line.rework + line.reject,
            good: line.good,
            rework: line.rework,
            reject: line.reject,
            rejectReason: line.reject > 0 ? line.rejectReason : null,
          };
        }),
        select: { id: true, issueLineId: true, colour: true, sizeLabel: true, received: true, rework: true },
      });

      const received = created.map((line) => Prisma.sql`(${line.issueLineId}::uuid, ${line.received}::int)`);

      await tx.$executeRaw`
        UPDATE stitching_issue_lines l SET received = l.received + v.received
        FROM (VALUES ${Prisma.join(received)}) AS v (id, received) WHERE l.id = v.id`;

      const rework = created.filter((line) => line.rework > 0);

      if (rework.length > 0) {
        await tx.reworkItem.createMany({
          data: rework.map((line) => ({
            receiptLineId: line.id,
            receiptId: receipt.id,
            issueId,
            lotId: issue.lot_id,
            colour: line.colour,
            sizeLabel: line.sizeLabel,
            quantity: line.rework,
          })),
        });
      }

      await postEarning(tx, actor, {
        sourceType: "STITCHING",
        sourceId: receipt.id,
        lotId: issue.lot_id,
        date,
        pieces: good,
        rate: issue.rate,
        amounts: split.amounts,
        description: `Stitching ${receiptNumber(receipt.number)} · ${issue.lot_number} · ${pcs(good)} Good`,
      });

      await recordAudit(tx, {
        type: "STITCHING_RECEIVED",
        ...audit(actor, meta),
        metadata: {
          receiptId: receipt.id,
          issueId,
          good,
          rework: input.lines.reduce((sum, line) => sum + line.rework, 0),
          reject: input.lines.reduce((sum, line) => sum + line.reject, 0),
        },
      });
    });

    return this.getIssue(issueId, showMoney);
  },

  /** Undoes a receipt whose rework is untouched: pieces go back to the team, earnings and cost are reversed. */
  async reverseReceipt(actor: AuthContext, receiptId: string, reason: string, meta: ClientMeta) {
    const found = await prisma.stitchingReceipt.findUnique({ where: { id: receiptId }, select: { issueId: true } });

    if (!found) throw errors.notFound("Stitching receipt");

    await transaction(async (tx) => {
      await lockIssue(tx, found.issueId);

      const [receipt] = await tx.$queryRaw<{ number: number; status: string }[]>`
        SELECT number, status FROM stitching_receipts WHERE id = ${receiptId}::uuid FOR UPDATE`;

      if (receipt!.status === "REVERSED")
        throw errors.conflict(`${receiptNumber(receipt!.number)} has already been reversed.`);

      const touched = await tx.reworkItem.count({
        where: { receiptId, status: { not: "CANCELLED" }, OR: [{ recovered: { gt: 0 } }, { failed: { gt: 0 } }] },
      });

      if (touched > 0) {
        throw errors.conflict(
          `Rework from ${receiptNumber(receipt!.number)} has already been resolved, so it cannot be reversed.`,
        );
      }

      const lines = await tx.stitchingReceiptLine.findMany({ where: { receiptId } });
      const values = lines.map((line) => Prisma.sql`(${line.issueLineId}::uuid, ${line.received}::int)`);

      await tx.$executeRaw`
        UPDATE stitching_issue_lines l SET received = l.received - v.received
        FROM (VALUES ${Prisma.join(values)}) AS v (id, received) WHERE l.id = v.id`;
      await tx.reworkItem.updateMany({ where: { receiptId }, data: { status: "CANCELLED" } });
      await reverseEarning(tx, actor, "STITCHING", receiptId, reason);
      await tx.stitchingReceipt.update({
        where: { id: receiptId },
        data: { status: "REVERSED", reversedAt: new Date(), reversedById: actor.user.id, reversalReason: reason },
      });
      await recordAudit(tx, {
        type: "STITCHING_RECEIPT_REVERSED",
        ...audit(actor, meta),
        metadata: { receiptId, reason },
      });
    });

    return this.getIssue(found.issueId, actor.user.permissions.has("costing.view"));
  },

  async listRework(query: ReworkListQuery) {
    const clauses = columnFilters(REWORK_COLUMNS, query);

    // Unless the status column is filtered, the list shows rework still to be done.
    if (!query.status) clauses.push(Prisma.sql`r.status IN ('PENDING', 'ASSIGNED', 'IN_PROGRESS')`);

    if (query.search) {
      const pattern = contains(query.search);

      clauses.push(Prisma.sql`(lp.search_text LIKE ${pattern} OR lower(r.colour) LIKE ${pattern}
        OR lower(i.team_name) LIKE ${pattern} OR r.number = ${numberOf(query.search, "rw")}::int)`);
    }

    if (query.lotId) clauses.push(Prisma.sql`r.lot_id = ${query.lotId}::uuid`);

    const filter = where(clauses);

    const from = Prisma.sql`
      FROM rework_items r
      JOIN stitching_issues i ON i.id = r.issue_id
      JOIN stitching_receipts sr ON sr.id = r.receipt_id
      JOIN production_lots lp ON lp.id = r.lot_id
      LEFT JOIN karigars k ON k.id = r.assigned_to`;

    const [rows, [count]] = await Promise.all([
      prisma.$queryRaw<
        {
          id: string;
          number: number;
          status: string;
          colour: string;
          size_label: string;
          quantity: number;
          recovered: number;
          failed: number;
          created_at: Date;
          lot_id: string;
          lot_number: string;
          article_name: string;
          issue_id: string;
          issue_number: number;
          team_name: string;
          receipt_number: number;
          assigned_id: string | null;
          assigned_name: string | null;
        }[]
      >`
        SELECT r.id, r.number, r.status, r.colour, r.size_label, r.quantity, r.recovered, r.failed, r.created_at,
               lp.id AS lot_id, lp.lot_number, lp.article_name, i.id AS issue_id, i.number AS issue_number, i.team_name,
               sr.number AS receipt_number, k.id AS assigned_id, k.name AS assigned_name
        ${from} ${filter} ${orderBy(REWORK_COLUMNS, query, "r.created_at ASC", "r.number ASC")} ${page(query)}`,
      prisma.$queryRaw<{ total: number; pending: number }[]>`
        SELECT count(*)::int AS total, COALESCE(sum(r.quantity - r.recovered - r.failed), 0)::int AS pending ${from} ${filter}`,
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        colour: row.colour,
        sizeLabel: row.size_label,
        quantity: row.quantity,
        recovered: row.recovered,
        failed: row.failed,
        pending: row.status === "CANCELLED" ? 0 : row.quantity - row.recovered - row.failed,
        createdAt: row.created_at,
        lot: { id: row.lot_id, lotNumber: row.lot_number, articleName: row.article_name },
        issue: { id: row.issue_id, number: row.issue_number, teamName: row.team_name },
        receiptNumber: row.receipt_number,
        assignedTo: row.assigned_id ? { id: row.assigned_id, name: row.assigned_name! } : null,
      })),
      total: count!.total,
      pending: count!.pending,
    };
  },

  async updateRework(
    actor: AuthContext,
    id: string,
    input: { status: "ASSIGNED" | "IN_PROGRESS"; assignedToId: string | null },
    meta: ClientMeta,
  ) {
    await transaction(async (tx) => {
      const [item] = await tx.$queryRaw<{ status: string; number: number }[]>`
        SELECT status, number FROM rework_items WHERE id = ${id}::uuid FOR UPDATE`;

      if (!item) throw errors.notFound("Rework item");

      if (!["PENDING", "ASSIGNED", "IN_PROGRESS"].includes(item.status)) {
        throw errors.conflict(`${reworkNumber(item.number)} is closed.`);
      }

      if (input.assignedToId) {
        const karigar = await tx.karigar.findUnique({ where: { id: input.assignedToId }, select: { active: true } });

        if (!karigar?.active) throw fieldError("assignedToId", "Choose an active karigar.");
      }

      await tx.reworkItem.update({ where: { id }, data: { status: input.status, assignedToId: input.assignedToId } });
      await recordAudit(tx, {
        type: "REWORK_UPDATED",
        ...audit(actor, meta),
        metadata: { reworkId: id, status: input.status, assignedToId: input.assignedToId },
      });
    });
  },

  /**
   * Records rework outcome: recovered pieces become Good and are paid to the team that
   * stitched them (the issue's members and split); failed pieces become Reject.
   */
  async resolveRework(actor: AuthContext, id: string, input: ReworkResolveInput, meta: ClientMeta) {
    await transaction(async (tx) => {
      const found = await tx.reworkItem.findUnique({ where: { id }, select: { issueId: true } });

      if (!found) throw errors.notFound("Rework item");

      const issue = await lockIssue(tx, found.issueId);

      const [item] = await tx.$queryRaw<
        {
          number: number;
          status: string;
          quantity: number;
          recovered: number;
          failed: number;
          colour: string;
          size_label: string;
        }[]
      >`SELECT number, status, quantity, recovered, failed, colour, size_label FROM rework_items WHERE id = ${id}::uuid FOR UPDATE`;

      if (!["PENDING", "ASSIGNED", "IN_PROGRESS"].includes(item!.status)) {
        throw errors.conflict(`${reworkNumber(item!.number)} is closed.`);
      }

      const pending = item!.quantity - item!.recovered - item!.failed;

      if (input.recovered + input.failed > pending) {
        throw fieldError("recovered", `Only ${pcs(pending)} are waiting for rework.`);
      }

      const date = new Date(input.resolvedOn);
      const members = await snapshotMembers(tx, found.issueId);
      const total = BigInt(input.recovered) * toPaisa(issue.rate);
      const split = splitEarning(total, issue.split_method, members);

      if (!split.ok) throw fieldError("recovered", split.message);

      const resolution = await tx.reworkResolution.create({
        data: {
          reworkId: id,
          resolvedOn: date,
          recovered: input.recovered,
          failed: input.failed,
          failedReason: input.failed > 0 ? input.failedReason : null,
          earning: paisaText(total),
          createdById: actor.user.id,
        },
        select: { id: true },
      });

      const recovered = item!.recovered + input.recovered;
      const failed = item!.failed + input.failed;
      const done = recovered + failed === item!.quantity;

      await tx.reworkItem.update({
        where: { id },
        data: { recovered, failed, status: done ? (recovered > 0 ? "COMPLETED" : "FAILED") : "IN_PROGRESS" },
      });

      if (input.recovered > 0) {
        await postEarning(tx, actor, {
          sourceType: "REWORK",
          sourceId: resolution.id,
          lotId: issue.lot_id,
          date,
          pieces: input.recovered,
          rate: issue.rate,
          amounts: split.amounts,
          description: `Rework ${reworkNumber(item!.number)} · ${issue.lot_number} · ${pcs(input.recovered)} recovered`,
        });
      }

      await recordAudit(tx, {
        type: "REWORK_RESOLVED",
        ...audit(actor, meta),
        metadata: { reworkId: id, recovered: input.recovered, failed: input.failed },
      });
    });
  },

  /** Rejected pieces: from receipts and from failed rework, newest first. */
  async listRejects(query: RejectListQuery) {
    const clauses = columnFilters(REJECT_COLUMNS, query);

    if (query.search) {
      const pattern = contains(query.search);

      clauses.push(
        Prisma.sql`(lower(x.lot_number || ' ' || x.article_name || ' ' || x.colour || ' ' || x.reason) LIKE ${pattern})`,
      );
    }

    if (query.lotId) clauses.push(Prisma.sql`x.lot_id = ${query.lotId}::uuid`);

    const filter = where(clauses);

    const source = Prisma.sql`
      (SELECT rl.id, r.receipt_date AS date, 'RECEIPT' AS source, r.number, r.lot_id, lp.lot_number, lp.article_name,
              i.team_name, rl.colour, rl.size_label, rl.reject AS quantity, rl.reject_reason AS reason
       FROM stitching_receipt_lines rl
       JOIN stitching_receipts r ON r.id = rl.receipt_id AND r.status = 'POSTED'
       JOIN stitching_issues i ON i.id = r.issue_id
       JOIN production_lots lp ON lp.id = r.lot_id
       WHERE rl.reject > 0
       UNION ALL
       SELECT rr.id, rr.resolved_on, 'REWORK', w.number, w.lot_id, lp.lot_number, lp.article_name,
              i.team_name, w.colour, w.size_label, rr.failed, rr.failed_reason
       FROM rework_resolutions rr
       JOIN rework_items w ON w.id = rr.rework_id
       JOIN stitching_issues i ON i.id = w.issue_id
       JOIN production_lots lp ON lp.id = w.lot_id
       WHERE rr.failed > 0) x`;

    const [rows, [count]] = await Promise.all([
      prisma.$queryRaw<
        {
          id: string;
          date: string;
          source: "RECEIPT" | "REWORK";
          number: number;
          lot_id: string;
          lot_number: string;
          article_name: string;
          team_name: string;
          colour: string;
          size_label: string;
          quantity: number;
          reason: string;
        }[]
      >`SELECT x.id, x.date::text AS date, x.source, x.number, x.lot_id, x.lot_number, x.article_name, x.team_name,
               x.colour, x.size_label, x.quantity, x.reason
        FROM ${source} ${filter} ${orderBy(REJECT_COLUMNS, query, "x.date DESC", "x.number DESC")} ${page(query)}`,
      prisma.$queryRaw<{ total: number; pieces: number }[]>`
        SELECT count(*)::int AS total, COALESCE(sum(x.quantity), 0)::int AS pieces FROM ${source} ${filter}`,
    ]);

    return {
      rejects: rows.map((row) => ({
        id: row.id,
        date: row.date,
        source: row.source,
        reference: row.source === "RECEIPT" ? receiptNumber(row.number) : reworkNumber(row.number),
        lot: { id: row.lot_id, lotNumber: row.lot_number, articleName: row.article_name },
        teamName: row.team_name,
        colour: row.colour,
        sizeLabel: row.size_label,
        quantity: row.quantity,
        reason: row.reason,
      })),
      total: count!.total,
      pieces: count!.pieces,
    };
  },
};

export type IssueDetail = Awaited<ReturnType<typeof stitchingService.getIssue>>;
