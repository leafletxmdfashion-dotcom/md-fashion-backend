import { prisma, Prisma, transaction } from "../../db/prisma";
import { factoryToday } from "../../lib/business-date";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { columnFilters, contains, orderBy, page, where } from "../../lib/list-query";
import { compareSizes } from "../../lib/sizes";
import { recordAudit } from "../audit/audit.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import {
  DISPATCH_COLUMNS,
  LOT_COLUMNS,
  MOVEMENT_COLUMNS,
  type AdjustInput,
  type DispatchInput,
  type DispatchListQuery,
  type FinishedLotQuery,
  type MovementListQuery,
  type StockQuery,
} from "./godown.schema";

// The godown: finished goods per item and size. Packing puts pieces in (packing.service),
// dispatches send them out, a counted adjustment corrects them. godown_movements is the
// ledger; godown_stock is its trigger-kept projection, whose CHECK keeps stock ≥ 0 and
// whose rows are locked (in item, size order) before anything goes out.

type Tx = Prisma.TransactionClient;

export const dispatchNumber = (number: number) => `DS-${String(number).padStart(4, "0")}`;

const pcs = (count: number) => `${count.toLocaleString("en-IN")} piece${count === 1 ? "" : "s"}`;

function fieldError(path: string, message: string): AppError {
  return new AppError(400, ErrorCode.VALIDATION_ERROR, message, { [path]: [message] });
}

function audit(actor: AuthContext, meta: ClientMeta) {
  return { actorUserId: actor.user.id, sessionId: actor.sessionId, meta };
}

function numberOf(text: string, prefix: string): number | null {
  const match = new RegExp(`^(?:${prefix}-?)?0*(\\d{1,9})$`, "i").exec(text.trim());

  return match ? Number(match[1]) : null;
}

/** Net pieces in and out per item and size: reversals cancel what they undo. */
const NET = Prisma.raw(`
  COALESCE(sum(m.qty_in) FILTER (WHERE m.type IN ('PACKED_IN', 'ADJUST_IN')), 0)
    - COALESCE(sum(m.qty_out) FILTER (WHERE m.type = 'PACKING_REVERSAL'), 0)`);

const NET_OUT = Prisma.raw(`
  COALESCE(sum(m.qty_out) FILTER (WHERE m.type IN ('DISPATCH', 'ADJUST_OUT')), 0)
    - COALESCE(sum(m.qty_in) FILTER (WHERE m.type = 'DISPATCH_REVERSAL'), 0)`);

/** Per lot: cut, waiting for stitching, with teams, Good, rejected, rework pending and packed. */
const LOT_FLOW = Prisma.sql`
  WITH cut AS (
    SELECT o.lot_id, sum(o.accepted_quantity)::int AS cut, sum(o.available_for_stitching)::int AS unissued
    FROM cutting_outputs o JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED' GROUP BY 1
  ), iss AS (
    SELECT i.lot_id, sum(l.quantity - l.received)::int AS wip
    FROM stitching_issue_lines l JOIN stitching_issues i ON i.id = l.issue_id AND i.status = 'POSTED' GROUP BY 1
  ), rec AS (
    SELECT r.lot_id, sum(rl.good)::int AS good, sum(rl.reject)::int AS reject
    FROM stitching_receipt_lines rl JOIN stitching_receipts r ON r.id = rl.receipt_id AND r.status = 'POSTED' GROUP BY 1
  ), rw AS (
    SELECT lot_id, sum(recovered)::int AS recovered, sum(failed)::int AS failed,
           sum(quantity - recovered - failed)::int AS pending
    FROM rework_items WHERE status <> 'CANCELLED' GROUP BY 1
  ), pk AS (
    SELECT lot_id, sum(pieces)::int AS packed, max(pack_date) AS last_packed
    FROM packing_entries WHERE status = 'POSTED' GROUP BY 1
  )
  SELECT c.lot_id, c.cut, c.unissued, COALESCE(iss.wip, 0) AS wip,
         (COALESCE(rec.good, 0) + COALESCE(rw.recovered, 0))::int AS good,
         (COALESCE(rec.reject, 0) + COALESCE(rw.failed, 0))::int AS reject,
         COALESCE(rw.pending, 0) AS rework, COALESCE(pk.packed, 0) AS packed, pk.last_packed
  FROM cut c
  LEFT JOIN iss ON iss.lot_id = c.lot_id
  LEFT JOIN rec ON rec.lot_id = c.lot_id
  LEFT JOIN rw ON rw.lot_id = c.lot_id
  LEFT JOIN pk ON pk.lot_id = c.lot_id`;

/**
 * Locks the stock rows of these item sizes, in a fixed order, and returns their balances.
 * Missing rows are created at zero first, so even a size's first movement is serialized.
 */
export async function lockStock(tx: Tx, keys: { articleId: string; sizeLabel: string }[]) {
  const pairs = keys.map((key) => Prisma.sql`(${key.articleId}::uuid, ${key.sizeLabel}::text)`);

  await tx.$executeRaw`
    INSERT INTO godown_stock (article_id, size_label)
    SELECT v.article_id, v.size_label FROM (VALUES ${Prisma.join(pairs)}) AS v (article_id, size_label)
    JOIN articles a ON a.id = v.article_id
    ORDER BY 1, 2
    ON CONFLICT (article_id, size_label) DO NOTHING`;

  const rows = await tx.$queryRaw<{ article_id: string; size_label: string; balance: number }[]>`
    SELECT article_id, size_label, balance FROM godown_stock
    WHERE (article_id, size_label) IN (${Prisma.join(pairs)})
    ORDER BY article_id, size_label FOR UPDATE`;

  return new Map(rows.map((row) => [`${row.article_id}|${row.size_label}`, row.balance]));
}

export const godownService = {
  /** Stock per item, with each size's net in, out and balance. */
  async stock(query: StockQuery) {
    const clauses: Prisma.Sql[] = [];

    if (query.search) clauses.push(Prisma.sql`a.search_text LIKE ${contains(query.search)}`);

    if (query.articleId) clauses.push(Prisma.sql`a.id = ${query.articleId}::uuid`);

    const having = query.inStock === "true" ? Prisma.sql`HAVING sum(s.balance) > 0` : Prisma.empty;
    const month = factoryToday().slice(0, 7) + "-01";

    const items = Prisma.sql`
      SELECT a.id, a.code, a.name, sum(s.balance)::int AS balance, max(s.last_movement_at) AS last_movement_at
      FROM godown_stock s JOIN articles a ON a.id = s.article_id ${where(clauses)}
      GROUP BY a.id ${having}`;

    const [rows, [count], [summary]] = await Promise.all([
      prisma.$queryRaw<{ id: string; code: string; name: string; balance: number; last_movement_at: Date }[]>`
        ${items} ORDER BY a.name, a.code ${page(query)}`,
      prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM (${items}) i`,
      prisma.$queryRaw<{ items: number; pieces: number; sizes: number; in_month: number; out_month: number }[]>`
        SELECT (SELECT count(DISTINCT article_id)::int FROM godown_stock WHERE balance > 0) AS items,
               (SELECT COALESCE(sum(balance), 0)::int FROM godown_stock) AS pieces,
               (SELECT count(*)::int FROM godown_stock WHERE balance > 0) AS sizes,
               (${NET})::int AS in_month, (${NET_OUT})::int AS out_month
        FROM godown_movements m WHERE m.movement_date >= ${month}::date`,
    ]);

    const sizes = rows.length
      ? await prisma.$queryRaw<{ article_id: string; size_label: string; in: number; out: number; balance: number }[]>`
          SELECT m.article_id, m.size_label, (${NET})::int AS in, (${NET_OUT})::int AS out,
                 (sum(m.qty_in) - sum(m.qty_out))::int AS balance
          FROM godown_movements m WHERE m.article_id IN (${Prisma.join(rows.map((row) => Prisma.sql`${row.id}::uuid`))})
          GROUP BY 1, 2`
      : [];

    return {
      items: rows.map((row) => {
        const own = sizes
          .filter((size) => size.article_id === row.id)
          .sort((a, b) => compareSizes(a.size_label, b.size_label))
          .map((size) => ({ size: size.size_label, in: size.in, out: size.out, balance: size.balance }));

        return {
          article: { id: row.id, code: row.code, name: row.name },
          sizes: own,
          in: own.reduce((sum, size) => sum + size.in, 0),
          out: own.reduce((sum, size) => sum + size.out, 0),
          balance: row.balance,
          lastMovementAt: row.last_movement_at,
        };
      }),
      total: count!.total,
      summary: {
        items: summary?.items ?? 0,
        pieces: summary?.pieces ?? 0,
        sizes: summary?.sizes ?? 0,
        inThisMonth: summary?.in_month ?? 0,
        outThisMonth: summary?.out_month ?? 0,
      },
    };
  },

  async movements(query: MovementListQuery) {
    const clauses = columnFilters(MOVEMENT_COLUMNS, query);

    if (query.search) {
      const pattern = contains(query.search);

      clauses.push(Prisma.sql`(a.search_text LIKE ${pattern} OR lower(COALESCE(d.party, '')) LIKE ${pattern}
        OR lower(COALESCE(l.lot_number, '')) LIKE ${pattern} OR lower(COALESCE(m.reason, '')) LIKE ${pattern})`);
    }

    if (query.articleId) clauses.push(Prisma.sql`m.article_id = ${query.articleId}::uuid`);

    const filter = where(clauses);
    const from = Prisma.sql`
      FROM godown_movements m
      JOIN articles a ON a.id = m.article_id
      JOIN users u ON u.id = m.created_by
      LEFT JOIN production_lots l ON l.id = m.lot_id
      LEFT JOIN packing_entries pe ON pe.id = m.packing_entry_id
      LEFT JOIN dispatches d ON d.id = m.dispatch_id`;

    const [rows, [summary]] = await Promise.all([
      prisma.$queryRaw<
        {
          id: string;
          movement_date: string;
          type: string;
          article_id: string;
          article_name: string;
          article_code: string;
          size_label: string;
          qty_in: number;
          qty_out: number;
          lot_number: string | null;
          packing_number: number | null;
          packer_name: string | null;
          dispatch_id: string | null;
          dispatch_number: number | null;
          party: string | null;
          reason: string | null;
          created_by: string;
        }[]
      >`
        SELECT m.id, m.movement_date::text AS movement_date, m.type, a.id AS article_id, a.name AS article_name,
               a.code AS article_code, m.size_label, m.qty_in, m.qty_out, l.lot_number, pe.number AS packing_number,
               pe.packer_name, d.id AS dispatch_id, d.number AS dispatch_number, d.party, m.reason, u.name AS created_by
        ${from} ${filter} ${orderBy(MOVEMENT_COLUMNS, query, "m.movement_date DESC", "m.seq DESC")} ${page(query)}`,
      prisma.$queryRaw<{ total: number; in: number; out: number }[]>`
        SELECT count(*)::int AS total, COALESCE(sum(m.qty_in), 0)::int AS in, COALESCE(sum(m.qty_out), 0)::int AS out
        ${from} ${filter}`,
    ]);

    return {
      movements: rows.map((row) => ({
        id: row.id,
        date: row.movement_date,
        type: row.type,
        article: { id: row.article_id, name: row.article_name, code: row.article_code },
        sizeLabel: row.size_label,
        direction: row.qty_in > 0 ? "IN" : "OUT",
        quantity: row.qty_in + row.qty_out,
        lotNumber: row.lot_number,
        reference:
          row.packing_number !== null
            ? `PK-${String(row.packing_number).padStart(4, "0")}${row.packer_name ? ` · ${row.packer_name}` : ""}`
            : row.dispatch_number !== null
              ? `${dispatchNumber(row.dispatch_number)} · ${row.party}`
              : null,
        dispatchId: row.dispatch_id,
        reason: row.reason,
        createdBy: row.created_by,
      })),
      total: summary!.total,
      summary: { in: summary!.in, out: summary!.out },
    };
  },

  async listDispatches(query: DispatchListQuery) {
    const clauses = columnFilters(DISPATCH_COLUMNS, query);

    if (query.search) {
      const pattern = contains(query.search);

      clauses.push(Prisma.sql`(lower(d.party) LIKE ${pattern} OR lower(COALESCE(d.challan, '')) LIKE ${pattern}
        OR d.number = ${numberOf(query.search, "ds")}::int)`);
    }

    const filter = where(clauses);

    const [rows, [summary]] = await Promise.all([
      prisma.$queryRaw<
        {
          id: string;
          number: number;
          dispatch_date: string;
          party: string;
          challan: string | null;
          pieces: number;
          status: string;
          items: string;
          created_by: string;
        }[]
      >`
        SELECT d.id, d.number, d.dispatch_date::text AS dispatch_date, d.party, d.challan, d.pieces, d.status,
               (SELECT string_agg(DISTINCT a.name, ', ') FROM godown_movements m JOIN articles a ON a.id = m.article_id
                WHERE m.dispatch_id = d.id AND m.type = 'DISPATCH') AS items,
               u.name AS created_by
        FROM dispatches d JOIN users u ON u.id = d.created_by
        ${filter} ${orderBy(DISPATCH_COLUMNS, query, "d.dispatch_date DESC", "d.number DESC")} ${page(query)}`,
      prisma.$queryRaw<{ total: number; posted: number; pieces: number; parties: number }[]>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE d.status = 'POSTED')::int AS posted,
               COALESCE(sum(d.pieces) FILTER (WHERE d.status = 'POSTED'), 0)::int AS pieces,
               count(DISTINCT lower(d.party)) FILTER (WHERE d.status = 'POSTED')::int AS parties
        FROM dispatches d ${filter}`,
    ]);

    return {
      dispatches: rows.map((row) => ({
        id: row.id,
        number: row.number,
        date: row.dispatch_date,
        party: row.party,
        challan: row.challan,
        pieces: row.pieces,
        status: row.status,
        items: row.items,
        createdBy: row.created_by,
      })),
      total: summary!.total,
      summary: { dispatches: summary!.posted, pieces: summary!.pieces, parties: summary!.parties },
    };
  },

  async getDispatch(id: string) {
    const dispatch = await prisma.dispatch.findUnique({
      where: { id },
      include: {
        movements: {
          where: { type: "DISPATCH" },
          orderBy: { seq: "asc" },
          include: { article: { select: { id: true, code: true, name: true } } },
        },
        createdBy: { select: { name: true } },
        reversedBy: { select: { name: true } },
      },
      relationLoadStrategy: "join",
    });

    if (!dispatch) throw errors.notFound("Dispatch");

    return {
      id: dispatch.id,
      number: dispatch.number,
      status: dispatch.status,
      date: dispatch.dispatchDate.toISOString().slice(0, 10),
      party: dispatch.party,
      challan: dispatch.challan,
      notes: dispatch.notes,
      pieces: dispatch.pieces,
      lines: dispatch.movements.map((move) => ({
        article: move.article,
        sizeLabel: move.sizeLabel,
        quantity: move.qtyOut,
      })),
      createdBy: dispatch.createdBy.name,
      createdAt: dispatch.createdAt,
      reversal: dispatch.reversedAt
        ? { at: dispatch.reversedAt, by: dispatch.reversedBy?.name ?? null, reason: dispatch.reversalReason }
        : null,
    };
  },

  async dispatch(actor: AuthContext, input: DispatchInput, meta: ClientMeta) {
    const id = await transaction(async (tx) => {
      const balances = await lockStock(tx, input.lines);
      const articles = await tx.article.findMany({
        where: { id: { in: [...new Set(input.lines.map((line) => line.articleId))] } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(articles.map((article) => [article.id, article.name]));

      input.lines.forEach((line, index) => {
        const name = nameOf.get(line.articleId);

        if (!name) throw fieldError(`lines.${index}.articleId`, "This item no longer exists. Reload and try again.");

        const balance = balances.get(`${line.articleId}|${line.sizeLabel}`) ?? 0;

        if (line.quantity > balance) {
          throw fieldError(
            `lines.${index}.quantity`,
            balance === 0
              ? `No ${name} ${line.sizeLabel} pieces are in the godown.`
              : `Only ${pcs(balance)} of ${name} ${line.sizeLabel} are in the godown.`,
          );
        }
      });

      const date = new Date(input.dispatchDate);
      const pieces = input.lines.reduce((sum, line) => sum + line.quantity, 0);

      const dispatch = await tx.dispatch.create({
        data: {
          dispatchDate: date,
          party: input.party,
          challan: input.challan,
          notes: input.notes,
          pieces,
          createdById: actor.user.id,
        },
        select: { id: true },
      });

      await tx.godownMovement.createMany({
        data: input.lines.map((line) => ({
          articleId: line.articleId,
          sizeLabel: line.sizeLabel,
          movementDate: date,
          type: "DISPATCH",
          qtyOut: line.quantity,
          dispatchId: dispatch.id,
          createdById: actor.user.id,
        })),
      });
      await recordAudit(tx, {
        type: "DISPATCH_POSTED",
        ...audit(actor, meta),
        metadata: { dispatchId: dispatch.id, party: input.party, pieces },
      });

      return dispatch.id;
    });

    return this.getDispatch(id);
  },

  async reverseDispatch(actor: AuthContext, id: string, reason: string, meta: ClientMeta) {
    await transaction(async (tx) => {
      const [dispatch] = await tx.$queryRaw<{ number: number; status: string }[]>`
        SELECT number, status FROM dispatches WHERE id = ${id}::uuid FOR UPDATE`;

      if (!dispatch) throw errors.notFound("Dispatch");

      if (dispatch.status === "REVERSED") {
        throw errors.conflict(`${dispatchNumber(dispatch.number)} has already been reversed.`);
      }

      const lines = await tx.godownMovement.findMany({ where: { dispatchId: id, type: "DISPATCH" } });
      const date = new Date(factoryToday());

      // Same lock order as dispatch and item merge: stock rows before anything is written.
      await lockStock(tx, lines);

      await tx.godownMovement.createMany({
        data: lines.map((line) => ({
          articleId: line.articleId,
          sizeLabel: line.sizeLabel,
          movementDate: date,
          type: "DISPATCH_REVERSAL",
          qtyIn: line.qtyOut,
          dispatchId: id,
          reason,
          createdById: actor.user.id,
        })),
      });
      await tx.dispatch.update({
        where: { id },
        data: { status: "REVERSED", reversedAt: new Date(), reversedById: actor.user.id, reversalReason: reason },
      });
      await recordAudit(tx, { type: "DISPATCH_REVERSED", ...audit(actor, meta), metadata: { dispatchId: id, reason } });
    });

    return this.getDispatch(id);
  },

  /** Sets one item size to the quantity counted in the godown, posting the difference. */
  async adjust(actor: AuthContext, input: AdjustInput, meta: ClientMeta) {
    return transaction(async (tx) => {
      const article = await tx.article.findUnique({ where: { id: input.articleId }, select: { name: true } });

      if (!article) throw fieldError("articleId", "Choose the item.");

      const balances = await lockStock(tx, [input]);
      const balance = balances.get(`${input.articleId}|${input.sizeLabel}`) ?? 0;
      const difference = input.counted - balance;

      if (difference === 0) {
        throw fieldError(
          "counted",
          `${pcs(balance)} of ${article.name} ${input.sizeLabel} are already recorded. Nothing to change.`,
        );
      }

      await tx.godownMovement.create({
        data: {
          articleId: input.articleId,
          sizeLabel: input.sizeLabel,
          movementDate: new Date(input.date),
          type: difference > 0 ? "ADJUST_IN" : "ADJUST_OUT",
          qtyIn: Math.max(difference, 0),
          qtyOut: Math.max(-difference, 0),
          reason: input.reason,
          createdById: actor.user.id,
        },
      });
      await recordAudit(tx, {
        type: "GODOWN_ADJUSTED",
        ...audit(actor, meta),
        metadata: { articleId: input.articleId, sizeLabel: input.sizeLabel, from: balance, to: input.counted },
      });

      return {
        article: { id: input.articleId, name: article.name },
        sizeLabel: input.sizeLabel,
        from: balance,
        to: input.counted,
      };
    });
  },

  /** Parties goods were sent to, most recent first, for the dispatch form. */
  async parties() {
    const rows = await prisma.$queryRaw<{ party: string }[]>`
      SELECT party FROM (SELECT DISTINCT ON (lower(party)) party, created_at FROM dispatches ORDER BY lower(party), created_at DESC) p
      ORDER BY created_at DESC LIMIT 50`;

    return rows.map((row) => row.party);
  },

  /** Finished goods per lot: from cutting through stitching to packing. */
  async finishedLots(query: FinishedLotQuery) {
    const clauses = columnFilters(LOT_COLUMNS, query);

    if (query.search) clauses.push(Prisma.sql`l.search_text LIKE ${contains(query.search)}`);

    if (query.articleId) clauses.push(Prisma.sql`l.article_id = ${query.articleId}::uuid`);

    const filter = where(clauses);
    const from = Prisma.sql`FROM (${LOT_FLOW}) x JOIN production_lots l ON l.id = x.lot_id`;

    const [rows, [summary]] = await Promise.all([
      prisma.$queryRaw<
        {
          id: string;
          lot_number: string;
          article_id: string;
          article_name: string;
          production_date: string;
          status: string;
          cut: number;
          unissued: number;
          wip: number;
          good: number;
          reject: number;
          rework: number;
          packed: number;
          last_packed: string | null;
        }[]
      >`
        SELECT l.id, l.lot_number, l.article_id, l.article_name, l.production_date::text AS production_date, l.status,
               x.cut, x.unissued, x.wip, x.good, x.reject, x.rework, x.packed, x.last_packed::text AS last_packed
        ${from} ${filter} ${orderBy(LOT_COLUMNS, query, "l.production_date DESC", "l.lot_key")} ${page(query)}`,
      prisma.$queryRaw<
        {
          total: number;
          cut: number;
          good: number;
          reject: number;
          packed: number;
          to_pack: number;
          in_production: number;
        }[]
      >`
        SELECT count(*)::int AS total, COALESCE(sum(x.cut), 0)::int AS cut, COALESCE(sum(x.good), 0)::int AS good,
               COALESCE(sum(x.reject), 0)::int AS reject, COALESCE(sum(x.packed), 0)::int AS packed,
               COALESCE(sum(x.good - x.packed), 0)::int AS to_pack,
               COALESCE(sum(x.unissued + x.wip + x.rework), 0)::int AS in_production
        ${from} ${filter}`,
    ]);

    return {
      lots: rows.map((row) => ({
        id: row.id,
        lotNumber: row.lot_number,
        article: { id: row.article_id, name: row.article_name },
        articleName: row.article_name,
        productionDate: row.production_date,
        status: row.status,
        cut: row.cut,
        unissued: row.unissued,
        wip: row.wip,
        good: row.good,
        reject: row.reject,
        rework: row.rework,
        packed: row.packed,
        toPack: row.good - row.packed,
        lastPacked: row.last_packed,
        stage: row.unissued + row.wip + row.rework > 0 ? "production" : row.good > row.packed ? "packing" : "done",
      })),
      total: summary!.total,
      summary: {
        lots: summary!.total,
        cut: summary!.cut,
        good: summary!.good,
        reject: summary!.reject,
        packed: summary!.packed,
        toPack: summary!.to_pack,
        inProduction: summary!.in_production,
      },
    };
  },

  /** Finished goods per item: lots, cut, Good, packed, dispatched and in stock. */
  async finishedItems(search: string | undefined) {
    const filter = search ? Prisma.sql`AND a.search_text LIKE ${contains(search)}` : Prisma.empty;

    const rows = await prisma.$queryRaw<
      {
        id: string;
        code: string;
        name: string;
        lots: number;
        cut: number;
        good: number;
        reject: number;
        packed: number;
        dispatched: number;
        in_stock: number;
      }[]
    >`
      WITH flow AS (
        SELECT l.article_id, count(*)::int AS lots, sum(x.cut)::int AS cut, sum(x.good)::int AS good,
               sum(x.reject)::int AS reject, sum(x.packed)::int AS packed
        FROM (${LOT_FLOW}) x JOIN production_lots l ON l.id = x.lot_id GROUP BY 1
      ), moved AS (
        SELECT m.article_id, (${NET_OUT})::int AS out,
               (COALESCE(sum(m.qty_out) FILTER (WHERE m.type = 'DISPATCH'), 0)
                 - COALESCE(sum(m.qty_in) FILTER (WHERE m.type = 'DISPATCH_REVERSAL'), 0))::int AS dispatched
        FROM godown_movements m GROUP BY 1
      ), stock AS (SELECT article_id, sum(balance)::int AS in_stock FROM godown_stock GROUP BY 1)
      SELECT a.id, a.code, a.name, COALESCE(f.lots, 0) AS lots, COALESCE(f.cut, 0) AS cut, COALESCE(f.good, 0) AS good,
             COALESCE(f.reject, 0) AS reject, COALESCE(f.packed, 0) AS packed,
             COALESCE(mv.dispatched, 0) AS dispatched, COALESCE(s.in_stock, 0) AS in_stock
      FROM articles a
      LEFT JOIN flow f ON f.article_id = a.id
      LEFT JOIN moved mv ON mv.article_id = a.id
      LEFT JOIN stock s ON s.article_id = a.id
      WHERE (f.article_id IS NOT NULL OR s.article_id IS NOT NULL) ${filter}
      ORDER BY a.name`;

    return {
      items: rows.map((row) => ({
        id: row.id,
        code: row.code,
        articleName: row.name,
        lots: row.lots,
        cut: row.cut,
        good: row.good,
        reject: row.reject,
        packed: row.packed,
        dispatched: row.dispatched,
        inStock: row.in_stock,
      })),
    };
  },
};
