import { z } from "zod";

import { businessDate } from "../../lib/business-date";
import { columnQueryFields, type ColumnQuery, type ColumnSpecs } from "../../lib/list-query";

export const MOVEMENT_TYPES = [
  "PACKED_IN",
  "PACKING_REVERSAL",
  "DISPATCH",
  "DISPATCH_REVERSAL",
  "ADJUST_IN",
  "ADJUST_OUT",
] as const;

export const MOVEMENT_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "m.movement_date" },
  item: { type: "text", sql: "a.search_text", sortSql: "a.name" },
  size: { type: "text", sql: "lower(m.size_label)", sortSql: "m.size_label" },
  type: { type: "enum", sql: "m.type", values: MOVEMENT_TYPES },
  quantity: { type: "number", sql: "(m.qty_in + m.qty_out)" },
};

export const DISPATCH_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "d.dispatch_date" },
  number: { type: "number", sql: "d.number" },
  party: { type: "text", sql: "lower(d.party)", sortSql: "d.party" },
  pieces: { type: "number", sql: "d.pieces" },
  status: { type: "enum", sql: "d.status", values: ["POSTED", "REVERSED"] },
};

export const LOT_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "l.production_date" },
  lot: { type: "text", sql: "l.search_text", sortSql: "l.lot_key" },
  item: { type: "text", sql: "lower(l.article_name)", sortSql: "l.article_name" },
  cut: { type: "number", sql: "x.cut" },
  good: { type: "number", sql: "x.good" },
  packed: { type: "number", sql: "x.packed" },
  toPack: { type: "number", sql: "(x.good - x.packed)" },
  stage: {
    type: "enum",
    sql: `CASE WHEN x.unissued + x.wip + x.rework > 0 THEN 'production'
               WHEN x.good > x.packed THEN 'packing' ELSE 'done' END`,
    values: ["production", "packing", "done"],
  },
};

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .nullish()
    .transform((value) => value || null);

const reason = z.string().trim().min(3, "Give a reason (at least 3 characters).").max(500);

const quantity = z
  .number({ error: "Enter the pieces." })
  .int("Use whole pieces.")
  .min(0, "Cannot be negative.")
  .max(1_000_000, "Too many pieces.");

export const dispatchSchema = z
  .strictObject({
    dispatchDate: businessDate,
    party: z.string().trim().min(1, "Enter who the goods go to.").max(100, "Keep the name under 100 characters."),
    challan: text(40),
    notes: text(500),
    lines: z
      .array(
        z.strictObject({
          articleId: z.uuid("Choose the item."),
          sizeLabel: z.string().trim().min(1, "Choose the size.").max(20),
          quantity,
        }),
      )
      .max(300)
      .transform((lines) => lines.filter((line) => line.quantity > 0))
      .refine((lines) => lines.length > 0, "Enter the pieces to dispatch."),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();

    input.lines.forEach((line, index) => {
      const key = `${line.articleId}|${line.sizeLabel}`;

      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["lines", index, "quantity"], message: "Listed twice." });

      seen.add(key);
    });
  });

export const adjustSchema = z.strictObject({
  date: businessDate,
  articleId: z.uuid("Choose the item."),
  sizeLabel: z.string().trim().min(1, "Enter the size.").max(20),
  counted: quantity,
  reason,
});

export const reverseSchema = z.strictObject({ reason });

const listPage = {
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const stockQuerySchema = z.object({
  ...listPage,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  articleId: z.uuid().optional(),
  inStock: z.enum(["true", "false"]).optional(),
});

export const movementListQuerySchema = z.object({
  ...listPage,
  articleId: z.uuid().optional(),
  ...columnQueryFields(MOVEMENT_COLUMNS),
});

export const dispatchListQuerySchema = z.object({ ...listPage, ...columnQueryFields(DISPATCH_COLUMNS) });

export const lotListQuerySchema = z.object({
  ...listPage,
  articleId: z.uuid().optional(),
  ...columnQueryFields(LOT_COLUMNS),
});

export const idParamsSchema = z.object({ id: z.uuid() });

export type DispatchInput = z.infer<typeof dispatchSchema>;

export type AdjustInput = z.infer<typeof adjustSchema>;

export type StockQuery = z.infer<typeof stockQuerySchema>;

export type MovementListQuery = z.infer<typeof movementListQuerySchema> & ColumnQuery;

export type DispatchListQuery = z.infer<typeof dispatchListQuerySchema> & ColumnQuery;

export type FinishedLotQuery = z.infer<typeof lotListQuerySchema> & ColumnQuery;
