import { z } from "zod";

// Search, column filters, sort and paging for lists the server builds whole in memory
// (aggregates such as stock by item or pieces by packer). Same query-string contract as the
// SQL lists in list-query.ts, so the frontend table sends one shape everywhere:
//   text <key>=needle · enum <key>=A,B · number <key>Min/<key>Max · date <key>From/<key>To
//   search=… · sort=<key>&dir=asc|desc · page & pageSize (left out: every matching row)
// ponytail: O(rows × columns) per request; fine for the few thousand rows these lists hold.

type Value = string | number | null | undefined;

export interface RowSpec<T> {
  type: "text" | "number" | "date" | "enum";
  value: (row: T) => Value;
  /** What sorting compares, when it differs from the filtered value (e.g. role rank). */
  sortValue?: (row: T) => Value;
  /** Allowed enum values; left out, any short token is accepted (e.g. role keys). */
  values?: readonly string[];
  sortable?: boolean;
  filterable?: boolean;
}

export type RowSpecs<T> = Record<string, RowSpec<T>>;

const MAX = 999_999_999_999;

/** Zod shape for search, the columns' filters, sort and optional paging. */
export function rowQueryFields<T>(specs: RowSpecs<T>) {
  const shape: Record<string, z.ZodType> = {
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(100_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    dir: z.enum(["asc", "desc"]).default("asc"),
  };
  const sortable = Object.entries(specs)
    .filter(([, spec]) => spec.sortable !== false)
    .map(([key]) => key);
  if (sortable.length) shape.sort = z.enum(sortable as [string, ...string[]]).optional();

  for (const [key, spec] of Object.entries(specs)) {
    if (spec.filterable === false) continue;
    if (spec.type === "text") shape[key] = z.string().trim().max(100).optional();
    if (spec.type === "enum") {
      const item = spec.values ? z.enum(spec.values as [string, ...string[]]) : z.string().regex(/^[\w-]{1,40}$/);
      shape[key] = z
        .string()
        .optional()
        .transform((raw) => (raw ? raw.split(",").filter(Boolean) : undefined))
        .pipe(z.array(item).max(50).optional());
    }
    if (spec.type === "number") {
      shape[`${key}Min`] = z.coerce.number().min(-MAX).max(MAX).optional();
      shape[`${key}Max`] = z.coerce.number().min(-MAX).max(MAX).optional();
    }
    if (spec.type === "date") {
      shape[`${key}From`] = z.iso.date().optional();
      shape[`${key}To`] = z.iso.date().optional();
    }
  }
  return shape;
}

export type RowQuery = Record<string, unknown> & {
  search?: string | undefined;
  page?: number | undefined;
  pageSize: number;
  sort?: string | undefined;
  dir: "asc" | "desc";
};

function matches<T>(row: T, specs: RowSpecs<T>, query: RowQuery): boolean {
  return Object.entries(specs).every(([key, spec]) => {
    if (spec.filterable === false) return true;
    const value = spec.value(row);

    switch (spec.type) {
      case "text": {
        const wanted = query[key];
        return (
          typeof wanted !== "string" ||
          !wanted ||
          String(value ?? "")
            .toLowerCase()
            .includes(wanted.toLowerCase())
        );
      }
      case "enum": {
        const picked = query[key];
        return !Array.isArray(picked) || picked.length === 0 || picked.includes(String(value ?? ""));
      }
      case "number": {
        const min = query[`${key}Min`] as number | undefined;
        const max = query[`${key}Max`] as number | undefined;
        if (min === undefined && max === undefined) return true;
        const number = value === null || value === undefined || value === "" ? NaN : Number(value);
        return !Number.isNaN(number) && (min === undefined || number >= min) && (max === undefined || number <= max);
      }
      case "date": {
        const from = query[`${key}From`] as string | undefined;
        const to = query[`${key}To`] as string | undefined;
        if (!from && !to) return true;
        const date = String(value ?? "").slice(0, 10);
        return Boolean(date) && (!from || date >= from) && (!to || date <= to);
      }
    }
  });
}

/**
 * Applies the query to rows already in their default order. `haystack` is what the free-text
 * search looks in. Returns every matching row (for totals and export) and the requested page.
 */
export function queryRows<T>(rows: T[], specs: RowSpecs<T>, query: RowQuery, haystack: (row: T) => string) {
  const needle = query.search?.toLowerCase();
  let matching = rows.filter(
    (row) => (!needle || haystack(row).toLowerCase().includes(needle)) && matches(row, specs, query),
  );

  const spec = query.sort ? specs[query.sort] : undefined;
  if (spec) {
    const direction = query.dir === "desc" ? -1 : 1;
    // Stable: ties keep the default order.
    matching = matching
      .map((row, index) => ({ row, index, value: (spec.sortValue ?? spec.value)(row) }))
      .sort((a, b) => {
        const empty = (v: Value) => v === null || v === undefined || v === "";
        if (empty(a.value) || empty(b.value))
          return empty(a.value) === empty(b.value) ? a.index - b.index : empty(a.value) ? 1 : -1;
        const order =
          typeof a.value === "number" && typeof b.value === "number"
            ? a.value - b.value
            : String(a.value).localeCompare(String(b.value), "en", { numeric: true, sensitivity: "base" });
        return order * direction || a.index - b.index;
      })
      .map((entry) => entry.row);
  }

  const pageRows = query.page
    ? matching.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
    : matching;

  return { matching, page: pageRows, total: matching.length };
}
