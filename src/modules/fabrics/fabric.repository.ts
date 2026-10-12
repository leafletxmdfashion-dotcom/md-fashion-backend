import { pool, type Queryable } from "../../db/pool";
import { columnFilters, contains, orderBy } from "../../lib/list-query";
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

// Numerics are cast to float8 and dates to text in SQL so the API returns plain
// JSON numbers and 'YYYY-MM-DD' strings (pg would give strings and local Date objects).
// Stock figures come from fabric_stock, a trigger-maintained projection of the ledger
// (migration 0003), so no request sums the whole movement table.

export interface FabricDto {
  id: string;
  code: string;
  name: string;
  unit: "KG" | "METER";
  category: string | null;
  lowStockThreshold: number | null;
  description: string | null;
  isActive: boolean;
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
  isActive: boolean;
  balance: number;
}

export interface FabricSummary {
  stockValue: number;
  active: number;
  inStock: number;
  reorder: number;
  inactive: number;
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
  color: string | null;
  rollRef: string | null;
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
  color: string | null;
  rollRef: string | null;
  reason: string | null;
  inward: { id: string; number: number; invoiceRef: string | null; supplier: string | null } | null;
  createdBy: string | null;
  createdAt: Date;
}

const FABRIC_SELECT = `
  f.id, f.code, f.name, f.unit, f.category, f.low_stock_threshold::float8 AS low_stock_threshold,
  f.description, f.is_active, f.created_at, s.balance::float8 AS balance, s.movement_count,
  ${AVG_RATE}::float8 AS avg_rate, ${STOCK_VALUE}::float8 AS stock_value`;

const FABRIC_FROM = "FROM fabrics f JOIN fabric_stock s ON s.fabric_id = f.id";

// "Needs reorder" = out of stock, or at or below its reorder level.
const NEEDS_REORDER = "(s.balance <= 0 OR s.balance <= f.low_stock_threshold)";

/** WHERE clause from conditions; an empty list matches everything. */
function where(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

/** LIMIT/OFFSET from validated integers (zod bounds them), so inlining is safe. */
function pageOf(query: { page: number; pageSize: number }): string {
  return `LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
}

interface FabricRow {
  id: string;
  code: string;
  name: string;
  unit: "KG" | "METER";
  category: string | null;
  low_stock_threshold: number | null;
  description: string | null;
  is_active: boolean;
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
    category: row.category,
    lowStockThreshold: row.low_stock_threshold,
    description: row.description,
    isActive: row.is_active,
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

const INWARD_SELECT = `
  i.id, i.number, i.fabric_id, f.code AS fabric_code, f.name AS fabric_name, f.unit AS fabric_unit,
  i.inward_date::text AS inward_date, i.quantity::float8 AS quantity, i.rate::float8 AS rate, i.amount::float8 AS amount,
  i.supplier, i.invoice_ref, i.color, i.roll_ref, i.notes, cu.name AS created_by_name, i.created_at,
  i.reversed_at, ru.name AS reversed_by_name, i.reversal_reason`;

const INWARD_JOINS = `
  JOIN fabrics f ON f.id = i.fabric_id
  LEFT JOIN users cu ON cu.id = i.created_by
  LEFT JOIN users ru ON ru.id = i.reversed_by`;

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
  color: string | null;
  roll_ref: string | null;
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
    color: row.color,
    rollRef: row.roll_ref,
    notes: row.notes,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
    reversal:
      row.reversed_at && row.reversal_reason
        ? { at: row.reversed_at, by: row.reversed_by_name, reason: row.reversal_reason }
        : null,
  };
}

export const fabricRepository = {
  /** Filters shared by the page and the export: toolbar search, quick stock level, column filters. */
  filterClauses(query: FabricListQuery, params: unknown[]): string[] {
    const clauses = columnFilters(FABRIC_COLUMNS, query, params);
    if (query.search) {
      params.push(contains(query.search));
      clauses.push(`lower(f.name || ' ' || f.code) LIKE $${params.length}`);
    }
    if (query.stock === "out") clauses.push("s.balance <= 0");
    if (query.stock === "low") clauses.push(NEEDS_REORDER);
    // Without a status filter the master lists active fabrics only.
    if (!query.status) clauses.push("f.is_active");
    return clauses;
  },

  /** One filtered page with its total, plus workspace-wide summary figures. */
  async list(query: FabricListQuery): Promise<{ fabrics: FabricDto[]; total: number; summary: FabricSummary }> {
    const params: unknown[] = [];
    const filter = where(this.filterClauses(query, params));
    // Reorder views put the most urgent first: lowest stock relative to its level.
    const fallback = query.stock ? "s.balance / nullif(f.low_stock_threshold, 0) ASC NULLS FIRST, f.name" : "f.name";
    const order = orderBy(FABRIC_COLUMNS, query, fallback, "f.code, f.id");
    const [{ rows }, count, summary] = await Promise.all([
      pool.query<FabricRow>(`SELECT ${FABRIC_SELECT} ${FABRIC_FROM} ${filter} ${order} ${pageOf(query)}`, params),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total ${FABRIC_FROM} ${filter}`, params),
      pool.query<{ stock_value: number; active: number; in_stock: number; reorder: number; inactive: number }>(
        `SELECT COALESCE(sum(${STOCK_VALUE}) FILTER (WHERE f.is_active), 0)::float8 AS stock_value,
                count(*) FILTER (WHERE f.is_active)::int AS active,
                count(*) FILTER (WHERE f.is_active AND s.balance > 0)::int AS in_stock,
                count(*) FILTER (WHERE f.is_active AND ${NEEDS_REORDER})::int AS reorder,
                count(*) FILTER (WHERE NOT f.is_active)::int AS inactive
         ${FABRIC_FROM}`,
      ),
    ]);
    const s = summary.rows[0]!;
    return {
      fabrics: rows.map(toFabric),
      total: count.rows[0]!.total,
      summary: {
        stockValue: s.stock_value,
        active: s.active,
        inStock: s.in_stock,
        reorder: s.reorder,
        inactive: s.inactive,
      },
    };
  },

  /** Sets status for many fabrics; returns the ids that actually changed. */
  async setActive(db: Queryable, ids: string[], isActive: boolean): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE fabrics SET is_active = $2, updated_at = now()
       WHERE id = ANY($1::uuid[]) AND is_active <> $2 RETURNING id`,
      [ids, isActive],
    );
    return rows.map((row) => row.id);
  },

  /** Categories in use, most common first, for the form's suggestions. */
  async categories(): Promise<string[]> {
    const { rows } = await pool.query<{ category: string }>(
      `SELECT min(category) AS category FROM fabrics WHERE category IS NOT NULL
       GROUP BY lower(category) ORDER BY count(*) DESC, 1 LIMIT 100`,
    );
    return rows.map((row) => row.category);
  },

  async existingCodes(db: Queryable, codes: string[]): Promise<Set<string>> {
    const { rows } = await db.query<{ code: string }>("SELECT code FROM fabrics WHERE code = ANY($1::text[])", [codes]);
    return new Set(rows.map((row) => row.code));
  },

  /** Lightweight id/name list for pickers and the command palette. */
  async options(): Promise<FabricOptionDto[]> {
    const { rows } = await pool.query<FabricOptionDto>(
      `SELECT f.id, f.code, f.name, f.unit, f.is_active AS "isActive", s.balance::float8 AS balance
       ${FABRIC_FROM} ORDER BY f.name, f.code`,
    );
    return rows;
  },

  async findById(db: Queryable, id: string): Promise<FabricDto | null> {
    const { rows } = await db.query<FabricRow>(`SELECT ${FABRIC_SELECT} ${FABRIC_FROM} WHERE f.id = $1`, [id]);
    return rows[0] ? toFabric(rows[0]) : null;
  },

  /** Row lock that serializes every stock-changing write for one fabric. */
  async lock(db: Queryable, id: string): Promise<{ unit: string; isActive: boolean; balance: number } | null> {
    const { rows } = await db.query<{ unit: string; is_active: boolean; balance: number }>(
      `SELECT f.unit, f.is_active, s.balance::float8 AS balance ${FABRIC_FROM} WHERE f.id = $1 FOR UPDATE OF f`,
      [id],
    );
    const row = rows[0];
    return row ? { unit: row.unit, isActive: row.is_active, balance: row.balance } : null;
  },

  async create(db: Queryable, input: CreateFabricInput, createdBy: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fabrics (code, name, unit, category, low_stock_threshold, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.code, input.name, input.unit, input.category, input.lowStockThreshold, input.description, createdBy],
    );
    return rows[0]!.id;
  },

  async update(db: Queryable, id: string, input: UpdateFabricInput): Promise<void> {
    await db.query(
      `UPDATE fabrics SET code = $2, name = $3, unit = $4, category = $5, low_stock_threshold = $6,
              description = $7, is_active = $8, updated_at = now()
       WHERE id = $1`,
      [
        id,
        input.code,
        input.name,
        input.unit,
        input.category,
        input.lowStockThreshold,
        input.description,
        input.isActive,
      ],
    );
  },

  async addMovement(
    db: Queryable,
    movement: {
      fabricId: string;
      date?: string;
      type: MovementType;
      quantity: number;
      color?: string | null;
      rollRef?: string | null;
      inwardId?: string | null;
      reason?: string | null;
      createdBy: string;
    },
  ): Promise<void> {
    const isIn = movement.type === "PURCHASE_IN" || movement.type === "ADJUSTMENT_IN";
    await db.query(
      `INSERT INTO fabric_movements (fabric_id, movement_date, type, qty_in, qty_out, color, roll_ref, inward_id, reason, created_by)
       VALUES ($1, COALESCE($2::date, current_date), $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        movement.fabricId,
        movement.date ?? null,
        movement.type,
        isIn ? movement.quantity : 0,
        isIn ? 0 : movement.quantity,
        movement.color ?? null,
        movement.rollRef ?? null,
        movement.inwardId ?? null,
        movement.reason ?? null,
        movement.createdBy,
      ],
    );
  },

  async listMovements(query: MovementListQuery): Promise<{ movements: MovementDto[]; total: number }> {
    const params: unknown[] = [];
    const clauses = columnFilters(MOVEMENT_COLUMNS, query, params);
    if (query.search) {
      params.push(contains(query.search));
      const ref = `$${params.length}`;
      clauses.push(`(lower(f.name || ' ' || f.code) LIKE ${ref} OR lower(COALESCE(m.reason, '')) LIKE ${ref}
        OR lower(COALESCE(m.color, '') || ' ' || COALESCE(m.roll_ref, '')) LIKE ${ref})`);
    }
    if (query.fabricId) {
      params.push(query.fabricId);
      clauses.push(`m.fabric_id = $${params.length}`);
    }
    const filter = where(clauses);
    const joins = "JOIN fabrics f ON f.id = m.fabric_id LEFT JOIN users u ON u.id = m.created_by";
    const order = orderBy(MOVEMENT_COLUMNS, query, "m.movement_date DESC", "m.seq DESC");

    // Page first, then each row's running balance (in business-date order) via an
    // index-only range sum: cost grows with the page size, not with the ledger.
    const [{ rows }, count] = await Promise.all([
      pool.query<{
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
        color: string | null;
        roll_ref: string | null;
        reason: string | null;
        inward_id: string | null;
        inward_number: number | null;
        invoice_ref: string | null;
        supplier: string | null;
        created_by_name: string | null;
        created_at: Date;
      }>(
        `WITH page AS (
           SELECT m.*, f.code AS fabric_code, f.name AS fabric_name, f.unit AS fabric_unit,
                  u.name AS created_by_name, row_number() OVER (${order}) AS position
           FROM fabric_movements m ${joins} ${filter} ${order} ${pageOf(query)}
         )
         SELECT p.id, p.fabric_id, p.fabric_code, p.fabric_name, p.fabric_unit,
                p.movement_date::text AS movement_date, p.type, p.qty_in::float8 AS qty_in, p.qty_out::float8 AS qty_out,
                (SELECT sum(b.qty_in - b.qty_out) FROM fabric_movements b
                  WHERE b.fabric_id = p.fabric_id AND (b.movement_date, b.seq) <= (p.movement_date, p.seq))::float8 AS balance,
                p.color, p.roll_ref, p.reason, p.inward_id, i.number AS inward_number,
                i.invoice_ref, i.supplier, p.created_by_name, p.created_at
         FROM page p
         LEFT JOIN fabric_inwards i ON i.id = p.inward_id
         ORDER BY p.position`,
        params,
      ),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM fabric_movements m ${joins} ${filter}`, params),
    ]);

    return {
      total: count.rows[0]!.total,
      movements: rows.map((row) => ({
        id: row.id,
        fabric: { id: row.fabric_id, code: row.fabric_code, name: row.fabric_name, unit: row.fabric_unit },
        date: row.movement_date,
        type: row.type,
        qtyIn: row.qty_in,
        qtyOut: row.qty_out,
        balance: row.balance,
        color: row.color,
        rollRef: row.roll_ref,
        reason: row.reason,
        inward:
          row.inward_id && row.inward_number !== null
            ? { id: row.inward_id, number: row.inward_number, invoiceRef: row.invoice_ref, supplier: row.supplier }
            : null,
        createdBy: row.created_by_name,
        createdAt: row.created_at,
      })),
    };
  },

  /** Opening (before `from`), in and out within the range, for one fabric. */
  async ledgerSummary(
    fabricId: string,
    range: { from?: string | undefined; to?: string | undefined },
  ): Promise<{ opening: number; totalIn: number; totalOut: number; closing: number }> {
    const { rows } = await pool.query<{ opening: number; total_in: number; total_out: number }>(
      `SELECT COALESCE(sum(qty_in - qty_out) FILTER (WHERE movement_date < $2), 0)::float8 AS opening,
              COALESCE(sum(qty_in) FILTER (WHERE $2::date IS NULL OR movement_date >= $2), 0)::float8 AS total_in,
              COALESCE(sum(qty_out) FILTER (WHERE $2::date IS NULL OR movement_date >= $2), 0)::float8 AS total_out
       FROM fabric_movements WHERE fabric_id = $1 AND ($3::date IS NULL OR movement_date <= $3)`,
      [fabricId, range.from ?? null, range.to ?? null],
    );
    const { opening, total_in: totalIn, total_out: totalOut } = rows[0]!;
    return { opening, totalIn, totalOut, closing: opening + totalIn - totalOut };
  },
};

export const inwardRepository = {
  /** Filters shared by the page and the export: toolbar search, fabric picker, column filters. */
  filterClauses(query: InwardListQuery, params: unknown[]): string[] {
    const clauses = columnFilters(INWARD_COLUMNS, query, params);
    if (query.search) {
      // Free text hits the trigram index on search_text; fabric name/code is resolved
      // against the small fabrics table first and matched by id; "FI-12" finds number 12.
      params.push(contains(query.search), inwardNumberOf(query.search));
      const [pattern, number] = [`$${params.length - 1}`, `$${params.length}`];
      clauses.push(`(i.search_text LIKE ${pattern} OR i.number = ${number}::int
        OR i.fabric_id IN (SELECT id FROM fabrics WHERE lower(name || ' ' || code) LIKE ${pattern}))`);
    }
    if (query.fabricId) {
      params.push(query.fabricId);
      clauses.push(`i.fabric_id = $${params.length}`);
    }
    return clauses;
  },

  async list(
    query: InwardListQuery,
  ): Promise<{ inwards: InwardDto[]; total: number; totalAmount: number; totalQuantity: Record<string, number> }> {
    const params: unknown[] = [];
    const filter = where(this.filterClauses(query, params));
    const order = orderBy(INWARD_COLUMNS, query, "i.inward_date DESC", "i.number DESC");
    const [{ rows }, summary] = await Promise.all([
      pool.query<InwardRow>(
        `SELECT ${INWARD_SELECT} FROM fabric_inwards i ${INWARD_JOINS} ${filter} ${order} ${pageOf(query)}`,
        params,
      ),
      // Totals cover posted purchases only: a reversed purchase no longer counts.
      pool.query<{ unit: string; count: number; quantity: number; amount: number }>(
        `SELECT f.unit, count(*)::int AS count,
                COALESCE(sum(i.quantity) FILTER (WHERE i.reversed_at IS NULL), 0)::float8 AS quantity,
                COALESCE(sum(i.amount) FILTER (WHERE i.reversed_at IS NULL), 0)::float8 AS amount
         FROM fabric_inwards i JOIN fabrics f ON f.id = i.fabric_id ${filter} GROUP BY f.unit`,
        params,
      ),
    ]);
    return {
      inwards: rows.map(toInward),
      total: summary.rows.reduce((sum, row) => sum + row.count, 0),
      totalAmount: summary.rows.reduce((sum, row) => sum + row.amount, 0),
      totalQuantity: Object.fromEntries(summary.rows.map((row) => [row.unit, row.quantity])),
    };
  },

  async findById(db: Queryable, id: string, lock = false): Promise<InwardDto | null> {
    const { rows } = await db.query<InwardRow>(
      `SELECT ${INWARD_SELECT} FROM fabric_inwards i ${INWARD_JOINS}
       WHERE i.id = $1 ${lock ? "FOR UPDATE OF i" : ""}`,
      [id],
    );
    return rows[0] ? toInward(rows[0]) : null;
  },

  async create(db: Queryable, input: CreateInwardInput, createdBy: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fabric_inwards (fabric_id, inward_date, quantity, rate, supplier, invoice_ref, color, roll_ref, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        input.fabricId,
        input.inwardDate,
        input.quantity,
        input.rate,
        input.supplier,
        input.invoiceRef,
        input.color,
        input.rollRef,
        input.notes,
        createdBy,
      ],
    );
    return rows[0]!.id;
  },

  async markReversed(db: Queryable, id: string, reversedBy: string, reason: string): Promise<void> {
    await db.query(
      "UPDATE fabric_inwards SET reversed_at = now(), reversed_by = $2, reversal_reason = $3 WHERE id = $1",
      [id, reversedBy, reason],
    );
  },

  /** Distinct suppliers, most used first, for the purchase form's suggestions. */
  async suppliers(): Promise<string[]> {
    const { rows } = await pool.query<{ supplier: string }>(
      `SELECT supplier FROM fabric_inwards WHERE supplier IS NOT NULL
       GROUP BY supplier ORDER BY count(*) DESC, supplier LIMIT 50`,
    );
    return rows.map((row) => row.supplier);
  },
};
