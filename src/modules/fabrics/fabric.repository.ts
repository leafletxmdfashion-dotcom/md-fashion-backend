import { prisma, Prisma, type Db } from "../../db/prisma";
import { columnFilters, contains, orderBy, page, where } from "../../lib/list-query";
import { AVG_RATE, FABRIC_COLUMNS, INWARD_COLUMNS, MOVEMENT_COLUMNS, STOCK_VALUE } from "./fabric.columns";
import type {
  CreateFabricInput,
  CreateInwardInput,
  FabricListQuery,
  InwardListQuery,
  MovementListQuery,
  MovementType,
  UpdateFabricInput,
} from "./fabric.schema";

// Writes go through Prisma Client. Reads that join the stock projection, compute
// figures or page the ledger are typed raw SQL: numerics are cast to float8 and
// dates to text so the API returns plain JSON numbers and 'YYYY-MM-DD' strings.
// Stock figures come from fabric_stock, a trigger-maintained projection of the
// ledger, so no request sums the whole movement table.

export interface FabricDto {
  id: string;
  code: string;
  name: string;
  unit: "KG" | "METER";
  lowStockThreshold: number | null;
  description: string | null;
  balance: number;
  avgRate: number | null;
  stockValue: number;
  movementCount: number;
  createdAt: Date;
}

export interface FabricOptionDto {
  id: string;
  code: string;
  name: string;
  unit: "KG" | "METER";
  balance: number;
}

export interface FabricSummary {
  stockValue: number;
  fabrics: number;
  inStock: number;
  reorder: number;
}

export interface InwardDto {
  id: string;
  number: number;
  fabric: { id: string; code: string; name: string; unit: string };
  inwardDate: string;
  quantity: number;
  rate: number;
  amount: number;
  supplier: string | null;
  invoiceRef: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  reversal: { at: Date; by: string | null; reason: string } | null;
}

export interface MovementDto {
  id: string;
  fabric: { id: string; code: string; name: string; unit: string };
  date: string;
  type: MovementType;
  qtyIn: number;
  qtyOut: number;
  balance: number;
  reason: string | null;
  inward: { id: string; number: number; invoiceRef: string | null; supplier: string | null } | null;
  createdBy: string | null;
  createdAt: Date;
}

const FABRIC_SELECT = Prisma.raw(`
  f.id, f.code, f.name, f.unit, f.low_stock_threshold::float8 AS low_stock_threshold,
  f.description, f.created_at, s.balance::float8 AS balance, s.movement_count,
  ${AVG_RATE}::float8 AS avg_rate, ${STOCK_VALUE}::float8 AS stock_value`);

const FABRIC_FROM = Prisma.raw("FROM fabrics f JOIN fabric_stock s ON s.fabric_id = f.id");

// "Needs reorder" = out of stock, or at or below its reorder level.
const NEEDS_REORDER = Prisma.raw("(s.balance <= 0 OR s.balance <= f.low_stock_threshold)");

interface FabricRow {
  id: string;
  code: string;
  name: string;
  unit: "KG" | "METER";
  low_stock_threshold: number | null;
  description: string | null;
  created_at: Date;
  balance: number;
  movement_count: number;
  avg_rate: number | null;
  stock_value: number;
}

function toFabric(row: FabricRow): FabricDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    lowStockThreshold: row.low_stock_threshold,
    description: row.description,
    balance: row.balance,
    avgRate: row.avg_rate,
    stockValue: row.stock_value,
    movementCount: row.movement_count,
    createdAt: row.created_at,
  };
}

/** "FI-12", "fi0012" or "12" → purchase number 12, so register numbers are searchable. */
export function inwardNumberOf(text: string): number | null {
  const match = /^(?:fi-?)?0*(\d{1,9})$/i.exec(text.trim());
  return match ? Number(match[1]) : null;
}

const INWARD_SELECT = Prisma.raw(`
  i.id, i.number, i.fabric_id, f.code AS fabric_code, f.name AS fabric_name, f.unit AS fabric_unit,
  i.inward_date::text AS inward_date, i.quantity::float8 AS quantity, i.rate::float8 AS rate, i.amount::float8 AS amount,
  i.supplier, i.invoice_ref, i.notes, cu.name AS created_by_name, i.created_at,
  i.reversed_at, ru.name AS reversed_by_name, i.reversal_reason`);

const INWARD_JOINS = Prisma.raw(`
  JOIN fabrics f ON f.id = i.fabric_id
  LEFT JOIN users cu ON cu.id = i.created_by
  LEFT JOIN users ru ON ru.id = i.reversed_by`);

interface InwardRow {
  id: string;
  number: number;
  fabric_id: string;
  fabric_code: string;
  fabric_name: string;
  fabric_unit: string;
  inward_date: string;
  quantity: number;
  rate: number;
  amount: number;
  supplier: string | null;
  invoice_ref: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: Date;
  reversed_at: Date | null;
  reversed_by_name: string | null;
  reversal_reason: string | null;
}

function toInward(row: InwardRow): InwardDto {
  return {
    id: row.id,
    number: row.number,
    fabric: { id: row.fabric_id, code: row.fabric_code, name: row.fabric_name, unit: row.fabric_unit },
    inwardDate: row.inward_date,
    quantity: row.quantity,
    rate: row.rate,
    amount: row.amount,
    supplier: row.supplier,
    invoiceRef: row.invoice_ref,
    notes: row.notes,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
    reversal:
      row.reversed_at && row.reversal_reason
        ? { at: row.reversed_at, by: row.reversed_by_name, reason: row.reversal_reason }
        : null,
  };
}

interface MovementRow {
  id: string;
  fabric_id: string;
  fabric_code: string;
  fabric_name: string;
  fabric_unit: string;
  movement_date: string;
  type: MovementType;
  qty_in: number;
  qty_out: number;
  balance: number;
  reason: string | null;
  inward_id: string | null;
  inward_number: number | null;
  invoice_ref: string | null;
  supplier: string | null;
  created_by_name: string | null;
  created_at: Date;
}

function toMovement(row: MovementRow): MovementDto {
  return {
    id: row.id,
    fabric: { id: row.fabric_id, code: row.fabric_code, name: row.fabric_name, unit: row.fabric_unit },
    date: row.movement_date,
    type: row.type,
    qtyIn: row.qty_in,
    qtyOut: row.qty_out,
    balance: row.balance,
    reason: row.reason,
    inward:
      row.inward_id && row.inward_number !== null
        ? { id: row.inward_id, number: row.inward_number, invoiceRef: row.invoice_ref, supplier: row.supplier }
        : null,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
  };
}

export const fabricRepository = {
  /** Filters shared by the page and the export: toolbar search, quick stock level, column filters. */
  filterClauses(query: FabricListQuery): Prisma.Sql[] {
    const clauses = columnFilters(FABRIC_COLUMNS, query);
    if (query.search) clauses.push(Prisma.sql`f.search_text LIKE ${contains(query.search)}`);
    if (query.stock === "out") clauses.push(Prisma.sql`s.balance <= 0`);
    if (query.stock === "low") clauses.push(NEEDS_REORDER);
    return clauses;
  },

  /** One filtered page with its total, plus workspace-wide summary figures. */
  async list(query: FabricListQuery): Promise<{ fabrics: FabricDto[]; total: number; summary: FabricSummary }> {
    const filter = where(this.filterClauses(query));
    // Reorder views put the most urgent first: lowest stock relative to its level.
    const fallback = query.stock ? "s.balance / nullif(f.low_stock_threshold, 0) ASC NULLS FIRST, f.name" : "f.name";
    const order = orderBy(FABRIC_COLUMNS, query, fallback, "f.code, f.id");
    const [rows, [count], [summary]] = await Promise.all([
      prisma.$queryRaw<FabricRow[]>`SELECT ${FABRIC_SELECT} ${FABRIC_FROM} ${filter} ${order} ${page(query)}`,
      prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${FABRIC_FROM} ${filter}`,
      prisma.$queryRaw<{ stock_value: number; fabrics: number; in_stock: number; reorder: number }[]>`
        SELECT COALESCE(sum(${Prisma.raw(STOCK_VALUE)}), 0)::float8 AS stock_value,
               count(*)::int AS fabrics,
               count(*) FILTER (WHERE s.balance > 0)::int AS in_stock,
               count(*) FILTER (WHERE ${NEEDS_REORDER})::int AS reorder
        ${FABRIC_FROM}`,
    ]);
    return {
      fabrics: rows.map(toFabric),
      total: count!.total,
      summary: {
        stockValue: summary!.stock_value,
        fabrics: summary!.fabrics,
        inStock: summary!.in_stock,
        reorder: summary!.reorder,
      },
    };
  },

  /** Lightweight id/name list for pickers and the command palette. */
  async options(): Promise<FabricOptionDto[]> {
    const fabrics = await prisma.fabric.findMany({
      select: { id: true, code: true, name: true, unit: true, stock: { select: { balance: true } } },
      orderBy: [{ name: "asc" }, { code: "asc" }],
    });
    return fabrics.map(({ stock, unit, ...fabric }) => ({
      ...fabric,
      unit: unit as FabricOptionDto["unit"],
      balance: stock ? stock.balance.toNumber() : 0,
    }));
  },

  async findById(db: Db, id: string): Promise<FabricDto | null> {
    const [row] = await db.$queryRaw<FabricRow[]>`SELECT ${FABRIC_SELECT} ${FABRIC_FROM} WHERE f.id = ${id}::uuid`;
    return row ? toFabric(row) : null;
  },

  /** Row lock that serializes every stock-changing write for one fabric. */
  async lock(db: Db, id: string): Promise<{ unit: string; balance: number } | null> {
    const [row] = await db.$queryRaw<{ unit: string; balance: number }[]>`
      SELECT f.unit, s.balance::float8 AS balance ${FABRIC_FROM} WHERE f.id = ${id}::uuid FOR UPDATE OF f`;
    return row ?? null;
  },

  async create(db: Db, input: CreateFabricInput, createdBy: string): Promise<string> {
    const fabric = await db.fabric.create({ data: { ...input, createdById: createdBy }, select: { id: true } });
    return fabric.id;
  },

  async update(db: Db, id: string, input: UpdateFabricInput): Promise<void> {
    await db.fabric.update({ where: { id }, data: input });
  },

  /** Appends one ledger entry; a trigger updates fabric_stock in the same transaction. */
  async addMovement(
    db: Db,
    movement: {
      fabricId: string;
      date?: string;
      type: MovementType;
      quantity: number;
      inwardId?: string | null;
      reason?: string | null;
      createdBy: string;
    },
  ): Promise<void> {
    const isIn = movement.type === "PURCHASE_IN" || movement.type === "ADJUSTMENT_IN";
    // Raw so an undated movement takes the database's current_date.
    await db.$executeRaw`
      INSERT INTO fabric_movements
        (fabric_id, movement_date, type, qty_in, qty_out, inward_id, reason, created_by)
      VALUES (${movement.fabricId}::uuid, COALESCE(${movement.date ?? null}::date, current_date), ${movement.type},
              ${isIn ? movement.quantity : 0}, ${isIn ? 0 : movement.quantity},
              ${movement.inwardId ?? null}::uuid, ${movement.reason ?? null},
              ${movement.createdBy}::uuid)`;
  },

  /**
   * One page of the ledger, plus totals over every matching movement: the count and,
   * per unit (kg and metres never add up together), the quantity received and issued.
   */
  async listMovements(
    query: MovementListQuery,
  ): Promise<{ movements: MovementDto[]; total: number; byUnit: Record<string, { in: number; out: number }> }> {
    const clauses = columnFilters(MOVEMENT_COLUMNS, query);
    if (query.search) {
      const pattern = contains(query.search);
      clauses.push(Prisma.sql`(f.search_text LIKE ${pattern} OR lower(COALESCE(m.reason, '')) LIKE ${pattern})`);
    }
    if (query.fabricId) clauses.push(Prisma.sql`m.fabric_id = ${query.fabricId}::uuid`);
    const filter = where(clauses);
    const joins = Prisma.raw("JOIN fabrics f ON f.id = m.fabric_id LEFT JOIN users u ON u.id = m.created_by");
    const order = orderBy(MOVEMENT_COLUMNS, query, "m.movement_date DESC", "m.seq DESC");

    // Page first, then each row's running balance (in business-date order) via an
    // index-only range sum: cost grows with the page size, not with the ledger.
    const [rows, totals] = await Promise.all([
      prisma.$queryRaw<MovementRow[]>`
        WITH page AS (
          SELECT m.*, f.code AS fabric_code, f.name AS fabric_name, f.unit AS fabric_unit,
                 u.name AS created_by_name, row_number() OVER (${order}) AS position
          FROM fabric_movements m ${joins} ${filter} ${order} ${page(query)}
        )
        SELECT p.id, p.fabric_id, p.fabric_code, p.fabric_name, p.fabric_unit,
               p.movement_date::text AS movement_date, p.type, p.qty_in::float8 AS qty_in, p.qty_out::float8 AS qty_out,
               (SELECT sum(b.qty_in - b.qty_out) FROM fabric_movements b
                 WHERE b.fabric_id = p.fabric_id AND (b.movement_date, b.seq) <= (p.movement_date, p.seq))::float8 AS balance,
               p.reason, p.inward_id, i.number AS inward_number,
               i.invoice_ref, i.supplier, p.created_by_name, p.created_at
        FROM page p
        LEFT JOIN fabric_inwards i ON i.id = p.inward_id
        ORDER BY p.position`,
      prisma.$queryRaw<{ unit: string; count: number; qty_in: number; qty_out: number }[]>`
        SELECT f.unit, count(*)::int AS count,
               COALESCE(sum(m.qty_in), 0)::float8 AS qty_in, COALESCE(sum(m.qty_out), 0)::float8 AS qty_out
        FROM fabric_movements m ${joins} ${filter} GROUP BY f.unit`,
    ]);
    return {
      movements: rows.map(toMovement),
      total: totals.reduce((sum, row) => sum + row.count, 0),
      byUnit: Object.fromEntries(totals.map((row) => [row.unit, { in: row.qty_in, out: row.qty_out }])),
    };
  },

  /** Opening (before `from`), in and out within the range, for one fabric. */
  async ledgerSummary(
    fabricId: string,
    range: { from?: string | undefined; to?: string | undefined },
  ): Promise<{ opening: number; totalIn: number; totalOut: number; closing: number }> {
    const from = range.from ?? null;
    const to = range.to ?? null;
    const [row] = await prisma.$queryRaw<{ opening: number; total_in: number; total_out: number }[]>`
      SELECT COALESCE(sum(qty_in - qty_out) FILTER (WHERE movement_date < ${from}::date), 0)::float8 AS opening,
             COALESCE(sum(qty_in) FILTER (WHERE ${from}::date IS NULL OR movement_date >= ${from}::date), 0)::float8
               AS total_in,
             COALESCE(sum(qty_out) FILTER (WHERE ${from}::date IS NULL OR movement_date >= ${from}::date), 0)::float8
               AS total_out
      FROM fabric_movements
      WHERE fabric_id = ${fabricId}::uuid AND (${to}::date IS NULL OR movement_date <= ${to}::date)`;
    const { opening, total_in: totalIn, total_out: totalOut } = row!;
    return { opening, totalIn, totalOut, closing: opening + totalIn - totalOut };
  },
};

export const inwardRepository = {
  /** Filters shared by the page and the export: toolbar search, fabric picker, column filters. */
  filterClauses(query: InwardListQuery): Prisma.Sql[] {
    const clauses = columnFilters(INWARD_COLUMNS, query);
    if (query.search) {
      // Free text hits the trigram index on search_text; fabric name/code is resolved
      // against the small fabrics table first and matched by id; "FI-12" finds number 12.
      const pattern = contains(query.search);
      clauses.push(Prisma.sql`(i.search_text LIKE ${pattern} OR i.number = ${inwardNumberOf(query.search)}::int
        OR i.fabric_id IN (SELECT id FROM fabrics WHERE search_text LIKE ${pattern}))`);
    }
    if (query.fabricId) clauses.push(Prisma.sql`i.fabric_id = ${query.fabricId}::uuid`);
    return clauses;
  },

  async list(
    query: InwardListQuery,
  ): Promise<{ inwards: InwardDto[]; total: number; totalAmount: number; totalQuantity: Record<string, number> }> {
    const filter = where(this.filterClauses(query));
    const order = orderBy(INWARD_COLUMNS, query, "i.inward_date DESC", "i.number DESC");
    const [rows, summary] = await Promise.all([
      prisma.$queryRaw<InwardRow[]>`
        SELECT ${INWARD_SELECT} FROM fabric_inwards i ${INWARD_JOINS} ${filter} ${order} ${page(query)}`,
      // Totals cover posted purchases only: a reversed purchase no longer counts.
      prisma.$queryRaw<{ unit: string; count: number; quantity: number; amount: number }[]>`
        SELECT f.unit, count(*)::int AS count,
               COALESCE(sum(i.quantity) FILTER (WHERE i.reversed_at IS NULL), 0)::float8 AS quantity,
               COALESCE(sum(i.amount) FILTER (WHERE i.reversed_at IS NULL), 0)::float8 AS amount
        FROM fabric_inwards i JOIN fabrics f ON f.id = i.fabric_id ${filter} GROUP BY f.unit`,
    ]);
    return {
      inwards: rows.map(toInward),
      total: summary.reduce((sum, row) => sum + row.count, 0),
      totalAmount: summary.reduce((sum, row) => sum + row.amount, 0),
      totalQuantity: Object.fromEntries(summary.map((row) => [row.unit, row.quantity])),
    };
  },

  async findById(db: Db, id: string, lock = false): Promise<InwardDto | null> {
    const [row] = await db.$queryRaw<InwardRow[]>`
      SELECT ${INWARD_SELECT} FROM fabric_inwards i ${INWARD_JOINS}
      WHERE i.id = ${id}::uuid ${lock ? Prisma.sql`FOR UPDATE OF i` : Prisma.empty}`;
    return row ? toInward(row) : null;
  },

  async create(db: Db, { fabricId, inwardDate, ...input }: CreateInwardInput, createdBy: string): Promise<string> {
    const inward = await db.fabricInward.create({
      data: { ...input, fabricId, inwardDate: new Date(inwardDate), createdById: createdBy },
      select: { id: true },
    });
    return inward.id;
  },

  async markReversed(db: Db, id: string, reversedBy: string, reason: string): Promise<void> {
    await db.fabricInward.update({
      where: { id },
      data: { reversedAt: new Date(), reversedById: reversedBy, reversalReason: reason },
    });
  },

  /** Distinct suppliers, most used first, for the purchase form's suggestions. */
  async suppliers(): Promise<string[]> {
    const rows = await prisma.fabricInward.groupBy({
      by: ["supplier"],
      where: { supplier: { not: null } },
      orderBy: [{ _count: { supplier: "desc" } }, { supplier: "asc" }],
      take: 50,
    });
    return rows.flatMap((row) => (row.supplier ? [row.supplier] : []));
  },
};
