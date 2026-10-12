import { z } from "zod";

// Per-column filtering and sorting for list endpoints. Each list declares its columns
// once; the query string can only reference those keys, and every SQL fragment comes
// from the declaration, never from the request. Values always travel as parameters.
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
  /** Indexed condition ANDed in front of a text filter (e.g. a trigram haystack). */
  prefilter?: string;
  sortable?: boolean;
  filterable?: boolean;
}

export type ColumnSpecs = Record<string, ColumnSpec>;

/** Parsed column params: zod validates them, but their keys are dynamic, so they are typed loosely. */
export type ColumnQuery = { sort?: string | undefined; dir: "asc" | "desc" } & Record<string, unknown>;

const MAX = 999_999_999_999;

/** Zod shape for the filter and sort params a column set accepts. */
export function columnQueryShape(columns: ColumnSpecs) {
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

/**
 * SQL conditions for the active column filters. Appends values to `params` and
 * references them by position, so callers can mix in their own conditions.
 */
export function columnFilters(columns: ColumnSpecs, query: Record<string, unknown>, params: unknown[]): string[] {
  const clauses: string[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  for (const [key, column] of Object.entries(columns)) {
    if (column.filterable === false) continue;
    if (column.type === "text" && typeof query[key] === "string" && query[key]) {
      const ref = add(contains(query[key]));
      const match = `${column.sql} LIKE ${ref}`;
      clauses.push(column.prefilter ? `(${column.prefilter.replaceAll("$?", ref)} AND ${match})` : match);
    }
    if (column.type === "enum" && Array.isArray(query[key]) && query[key].length > 0) {
      clauses.push(`${column.sql} = ANY(${add(query[key])}::text[])`);
    }
    const [low, high] = column.type === "date" ? ["From", "To"] : ["Min", "Max"];
    if (column.type === "number" || column.type === "date") {
      const cast = column.type === "date" ? "::date" : "::numeric";
      if (query[`${key}${low}`] !== undefined) clauses.push(`${column.sql} >= ${add(query[`${key}${low}`])}${cast}`);
      if (query[`${key}${high}`] !== undefined) clauses.push(`${column.sql} <= ${add(query[`${key}${high}`])}${cast}`);
    }
  }
  return clauses;
}

/** ORDER BY for the requested column, falling back to the list's default; `tiebreak` keeps paging stable. */
export function orderBy(columns: ColumnSpecs, query: ColumnQuery, fallback: string, tiebreak: string): string {
  const column = query.sort ? columns[query.sort] : undefined;
  if (!column) return `ORDER BY ${fallback}, ${tiebreak}`;
  const dir = query.dir === "desc" ? "DESC" : "ASC";
  return `ORDER BY ${column.sortSql ?? column.sql} ${dir} NULLS LAST, ${tiebreak}`;
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
