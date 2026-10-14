import { z } from "zod";

import { columnQueryFields, type ColumnQuery, type ColumnSpecs } from "../../lib/list-query";
import { markerDefaultsSchema } from "../cutting/cutting.schema";

export const ARTICLE_COLUMNS: ColumnSpecs = {
  article: { type: "text", sql: "a.search_text", sortSql: "a.name" },
  fabric: { type: "text", sql: "lower(COALESCE(f.name, '') || ' ' || COALESCE(f.code, ''))", sortSql: "f.name" },
  lots: { type: "number", sql: "COALESCE(l.lots, 0)" },
  status: {
    type: "enum",
    sql: "CASE WHEN a.active THEN 'active' ELSE 'inactive' END",
    values: ["active", "inactive"],
  },
};

export const articleCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,23}$/, "Use up to 24 letters, numbers or dashes.");

export const articleSchema = z.strictObject({
  name: z.string().trim().min(1, "Name is required.").max(100, "Keep the name under 100 characters."),
  /** Left empty, the next ART-0001 style code is assigned. */
  code: articleCode.nullish().transform((value) => value || null),
  defaultFabricId: z.uuid("Choose a fabric.").nullable().default(null),
  defaultMarker: markerDefaultsSchema.nullable().default(null),
  active: z.boolean().default(true),
});

export const articleListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  ...columnQueryFields(ARTICLE_COLUMNS),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const sizeTemplateSchema = z.strictObject({
  name: z.string().trim().min(1, "Name is required.").max(50, "Keep the name under 50 characters."),
  sizes: z
    .array(z.string().trim().min(1, "Enter the size.").max(20, "Keep sizes under 20 characters."))
    .min(1, "Add at least one size.")
    .max(20, "Use at most 20 sizes.")
    .superRefine((sizes, ctx) => {
      const seen = new Set<string>();

      sizes.forEach((size, index) => {
        if (seen.has(size.toLowerCase())) ctx.addIssue({ code: "custom", path: [index], message: `${size} is listed twice.` });

        seen.add(size.toLowerCase());
      });
    }),
});

export type ArticleInput = z.infer<typeof articleSchema>;

export type ArticleListQuery = z.infer<typeof articleListQuerySchema> & ColumnQuery;

export type SizeTemplateInput = z.infer<typeof sizeTemplateSchema>;
