import { z } from "zod";

import { businessDate } from "../../lib/business-date";
import { columnQueryFields, type ColumnQuery, type ColumnSpecs } from "../../lib/list-query";

export const ENTRY_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "e.pack_date" },
  number: { type: "number", sql: "e.number" },
  lot: { type: "text", sql: "l.search_text", sortSql: "l.lot_key" },
  packer: { type: "text", sql: "lower(e.packer_name)", sortSql: "e.packer_name" },
  pieces: { type: "number", sql: "e.pieces" },
  status: { type: "enum", sql: "e.status", values: ["POSTED", "REVERSED"] },
};

export const LINE_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "e.pack_date" },
  packer: { type: "text", sql: "lower(e.packer_name)", sortSql: "e.packer_name" },
  item: { type: "text", sql: "lower(l.article_name)", sortSql: "l.article_name" },
  size: { type: "text", sql: "lower(pl.size_label)", sortSql: "pl.size_label" },
  quantity: { type: "number", sql: "pl.quantity" },
};

const notes = z
  .string()
  .trim()
  .max(500, "Keep notes under 500 characters.")
  .nullish()
  .transform((value) => value || null);

export const packSchema = z
  .strictObject({
    lotId: z.uuid("Choose a lot."),
    packerId: z.uuid("Choose who packed."),
    packDate: businessDate,
    /** Left out: the packer's own rate per piece. Setting it needs permission to see money. */
    rate: z
      .number({ error: "Enter the rate per piece." })
      .min(0, "Rate cannot be negative.")
      .max(99_999, "Rate is too large.")
      .multipleOf(0.01, "Use at most 2 decimals.")
      .optional(),
    notes,
    lines: z
      .array(
        z.strictObject({
          sizeLabel: z.string().trim().min(1, "Choose the size.").max(20),
          quantity: z
            .number({ error: "Enter the pieces." })
            .int("Use whole pieces.")
            .min(0, "Cannot be negative.")
            .max(1_000_000, "Too many pieces."),
        }),
      )
      .max(50)
      // Sizes left at zero are not part of the entry.
      .transform((lines) => lines.filter((line) => line.quantity > 0))
      .refine((lines) => lines.length > 0, "Enter the pieces packed."),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();

    input.lines.forEach((line, index) => {
      if (seen.has(line.sizeLabel)) {
        ctx.addIssue({ code: "custom", path: ["lines", index, "quantity"], message: "Listed twice." });
      }

      seen.add(line.sizeLabel);
    });
  });

export const reverseSchema = z.strictObject({
  reason: z.string().trim().min(3, "Give a reason (at least 3 characters).").max(500),
});

const listPage = {
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  lotId: z.uuid().optional(),
  packerId: z.uuid().optional(),
};

export const entryListQuerySchema = z.object({ ...listPage, ...columnQueryFields(ENTRY_COLUMNS) });

export const lineListQuerySchema = z.object({ ...listPage, ...columnQueryFields(LINE_COLUMNS) });

export const staffQuerySchema = z.object({
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
});

export const idParamsSchema = z.object({ id: z.uuid() });

export type PackInput = z.infer<typeof packSchema>;

export type EntryListQuery = z.infer<typeof entryListQuerySchema> & ColumnQuery;

export type LineListQuery = z.infer<typeof lineListQuerySchema> & ColumnQuery;
