import { z } from "zod";

import { columnQueryFields, type ColumnQuery, type ColumnSpecs } from "../../lib/list-query";

export const KARIGAR_CATEGORIES = ["CUTTING_MASTER", "TAILOR", "HELPER", "OTHER"] as const;

export const PAY_MODES = ["PER_PIECE", "PER_PALA", "PER_KG", "FIXED_JOB", "SALARY"] as const;

export const KARIGAR_COLUMNS: ColumnSpecs = {
  name: { type: "text", sql: "k.search_text", sortSql: "k.name" },
  category: { type: "enum", sql: "k.category", values: KARIGAR_CATEGORIES },
  payMode: { type: "enum", sql: "k.pay_mode", values: PAY_MODES },
  payRate: { type: "number", sql: "k.pay_rate" },
  earned: { type: "number", sql: "COALESCE(e.earned, 0)" },
  status: {
    type: "enum",
    sql: "CASE WHEN k.active THEN 'active' ELSE 'inactive' END",
    values: ["active", "inactive"],
  },
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .nullish()
    .transform((value) => value || null);

export const karigarSchema = z.strictObject({
  name: z.string().trim().min(1, "Name is required.").max(100, "Keep the name under 100 characters."),
  phone: optionalText(20),
  category: z.enum(KARIGAR_CATEGORIES, { error: "Choose a category." }),
  payMode: z.enum(PAY_MODES, { error: "Choose how they are paid." }),
  payRate: z
    .number({ error: "Enter the rate." })
    .min(0, "Rate cannot be negative.")
    .max(9_999_999, "Rate is too large.")
    .multipleOf(0.01, "Use at most 2 decimals."),
  active: z.boolean().default(true),
  notes: optionalText(500),
});

export const karigarListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  ...columnQueryFields(KARIGAR_COLUMNS),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const karigarOptionsQuerySchema = z.object({ category: z.enum(KARIGAR_CATEGORIES).optional() });

export type KarigarInput = z.infer<typeof karigarSchema>;

export type KarigarListQuery = z.infer<typeof karigarListQuerySchema> & ColumnQuery;

export type PayMode = (typeof PAY_MODES)[number];
