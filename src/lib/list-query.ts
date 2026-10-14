import { z } from "zod";

import { Prisma } from "../generated/prisma/client";

// Per-column filtering and sorting for list endpoints. Each list declares its columns
// once; the query string can only reference those keys, and every SQL fragment comes
// from the declaration, never from the request. Values always travel as bound
// parameters inside Prisma.sql fragments.
//
// Query-string contract (mirrored by the frontend table):
//   text   → <key>=needle            (case-insensitive "contains")
//   enum   → <key>=A,B               (any of)
//   number → <key>Min=1&<key>Max=9   (inclusive)
//   date   → <key>From=…&<key>To=…   (inclusive, YYYY-MM-DD)
//   sort=<key>&dir=asc|desc

export interface ColumnSpec {
  type: "text" | "number" | "date" | "enum";
  /** SQL expression filtered on (text: already lower-cased). */
  sql: string;
  /** SQL expression sorted on, when it differs from `sql`. */
  sortSql?: string;
  values?: readonly string[];
  /** Trigram-indexed haystack matched with the same pattern first, to narrow rows cheaply. */
  prefilter?: string;
  sortable?: boolean;
  filterable?: boolean;
}

export type ColumnSpecs = Record<string, ColumnSpec>;

/** Parsed column params: zod validates them, but their keys are dynamic, so they are typed loosely. */
export type ColumnQuery = { sort?: string | undefined; dir: "asc" | "desc" } & Record<string, unknown>;

const MAX = 999_999_999_999;

/** Zod shape for the filter and sort params a column set accepts. */
export function columnQueryFields(columns: ColumnSpecs) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, column] of Object.entries(columns)) {
    if (column.filterable === false) continue;
    if (column.type === "text") shape[key] = z.string().trim().max(100).optional();
    if (column.type === "enum") {
      const values = column.values as [string, ...string[]];
      shape[key] = z
        .string()
        .optional()
        .transform((raw) => (raw ? raw.split(",").filter(Boolean) : undefined))
        .pipe(z.array(z.enum(values)).max(values.length).optional());
    }
    if (column.type === "number") {
      shape[`${key}Min`] = z.coerce.number().min(-MAX).max(MAX).optional();
      shape[`${key}Max`] = z.coerce.number().min(-MAX).max(MAX).optional();
    }
    if (column.type === "date") {
      shape[`${key}From`] = z.iso.date().optional();
      shape[`${key}To`] = z.iso.date().optional();
    }
  }
  const sortable = Object.entries(columns)
    .filter(([, column]) => column.sortable !== false)
    .map(([key]) => key) as [string, ...string[]];
  shape.sort = z.enum(sortable).optional();
  shape.dir = z.enum(["asc", "desc"]).default("asc");
  return shape;
}

/** Lower-cased LIKE pattern that matches the text literally anywhere. */
export function contains(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** SQL conditions for the active column filters, ready to AND with the caller's own. */
export function columnFilters(columns: ColumnSpecs, query: Record<string, unknown>): Prisma.Sql[] {
  const clauses: Prisma.Sql[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (column.filterable === false) continue;
    const sql = Prisma.raw(column.sql);
    if (column.type === "text" && typeof query[key] === "string" && query[key]) {
      const pattern = contains(query[key]);
      const match = Prisma.sql`${sql} LIKE ${pattern}`;
      clauses.push(column.prefilter ? Prisma.sql`(${Prisma.raw(column.prefilter)} LIKE ${pattern} AND ${match})` : match);
    }
    if (column.type === "enum" && Array.isArray(query[key]) && query[key].length > 0) {
      clauses.push(Prisma.sql`${sql} = ANY(${query[key]}::text[])`);
    }
    const [low, high] = column.type === "date" ? ["From", "To"] : ["Min", "Max"];
    if (column.type === "number" || column.type === "date") {
      const cast = Prisma.raw(column.type === "date" ? "::date" : "::numeric");
      const min = query[`${key}${low}`];
      const max = query[`${key}${high}`];
      if (min !== undefined) clauses.push(Prisma.sql`${sql} >= ${min}${cast}`);
      if (max !== undefined) clauses.push(Prisma.sql`${sql} <= ${max}${cast}`);
    }
  }
  return clauses;
}

/** WHERE clause from conditions; an empty list matches everything. */
export function where(clauses: Prisma.Sql[]): Prisma.Sql {
  return clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
}

/** ORDER BY for the requested column, falling back to the list's default; `tiebreak` keeps paging stable. */
export function orderBy(columns: ColumnSpecs, query: ColumnQuery, fallback: string, tiebreak: string): Prisma.Sql {
  const column = query.sort ? columns[query.sort] : undefined;
  if (!column) return Prisma.raw(`ORDER BY ${fallback}, ${tiebreak}`);
  const dir = query.dir === "desc" ? "DESC" : "ASC";
  return Prisma.raw(`ORDER BY ${column.sortSql ?? column.sql} ${dir} NULLS LAST, ${tiebreak}`);
}

/** LIMIT/OFFSET for one page. */
export function page(query: { page: number; pageSize: number }): Prisma.Sql {
  return Prisma.sql`LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
}

/** RFC 4180 CSV. Cells that a spreadsheet would run as a formula are prefixed with '. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) return "";
    let text = String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}
