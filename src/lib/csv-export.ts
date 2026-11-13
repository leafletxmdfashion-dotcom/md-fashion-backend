import type { Request, Response } from "express";
import { z } from "zod";

import { factoryToday } from "./business-date";
import { AppError, ErrorCode } from "./errors";
import { toCsv } from "./list-query";

// Every list's "Export" runs here: the same query as the list (same filters, sort and
// permission rules), all matching rows rather than one page, built into CSV on the server.

/**
 * Most rows one export returns. One query fetches up to EXPORT_MAX + 1 rows, so the file is a
 * single consistent snapshot; more than EXPORT_MAX is refused (never silently cut short).
 * ponytail: built in memory; stream with a cursor if exports ever need to be larger.
 */
export const EXPORT_MAX = 50_000;

/** Byte-order mark, so spreadsheet apps read the file as UTF-8. */
export const BOM = String.fromCharCode(0xfeff);

export type Cell = string | number | boolean | Date | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => Cell;
}

/** `?ids=a,b` limits the export to rows the user selected (still within the current filters). */
const idsSchema = z
  .string()
  .optional()
  .transform((raw) => (raw ? raw.split(",").filter(Boolean) : undefined))
  .pipe(z.array(z.uuid()).max(1_000, "Select at most 1,000 rows to export.").optional());

export function selectedIds(req: Request): Set<string> | null {
  const ids = idsSchema.parse((req.query as Record<string, unknown>).ids);
  return ids ? new Set(ids) : null;
}

/** The list query widened to every matching row (plus one, to detect too many). */
export function allRows<Q extends object>(query: Q): Q & { page: number; pageSize: number } {
  return { ...query, page: 1, pageSize: EXPORT_MAX + 1 };
}

function cell(value: Cell): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value;
}

/**
 * Sends `rows` (already filtered and sorted by the list query) as CSV. Selected ids, when given,
 * narrow it further; `rowId` must match the id the table uses for the row.
 */
export function sendCsv<T>(
  req: Request,
  res: Response,
  name: string,
  columns: CsvColumn<T>[],
  rows: T[],
  rowId: (row: T) => string,
): void {
  if (rows.length > EXPORT_MAX) {
    throw new AppError(
      400,
      ErrorCode.BAD_REQUEST,
      `More than ${EXPORT_MAX.toLocaleString("en-IN")} rows match. Narrow the filters or dates to export.`,
    );
  }

  const ids = selectedIds(req);
  const picked = ids ? rows.filter((row) => ids.has(rowId(row))) : rows;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}${ids ? "-selected" : ""}-${factoryToday()}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Export-Rows", String(picked.length));
  // BOM so spreadsheet apps read the file as UTF-8.
  res.send(
    `${BOM}${toCsv(
      columns.map((column) => column.header),
      picked.map((row) => columns.map((column) => cell(column.value(row)))),
    )}`,
  );
}

/** "FI-0042" style document numbers, as the screens show them. */
export const docNumber = (prefix: string, number: number | null | undefined) =>
  number === null || number === undefined ? null : `${prefix}-${String(number).padStart(4, "0")}`;

/** YYYY-MM-DD for a date or timestamp. */
export const day = (value: Date | string | null | undefined) =>
  value === null || value === undefined ? null : (value instanceof Date ? value.toISOString() : value).slice(0, 10);
