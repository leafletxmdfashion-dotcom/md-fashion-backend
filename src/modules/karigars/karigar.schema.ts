import { z } from "zod";

import { columnQueryFields, type ColumnQuery, type ColumnSpecs } from "../../lib/list-query";
import { personLoginSchema } from "../users/user.schema";

/**
 * What a person works as: the system's job roles (Owner, Admin and Viewer are login roles, not jobs), so a
 * person's category and the login role they usually get line up. Keep in sync with md_frontend
 * production.types.ts and karigars_category_check.
 */
export const KARIGAR_CATEGORIES = [
  "KARIGAR",
  "CUTTING_MASTER",
  "STITCHING_SUPERVISOR",
  "PACKING_STAFF",
  "GODOWN_STAFF",
  "STORE_KEEPER",
  "MANAGER",
  "ACCOUNTANT",
  "STAFF",
  "OTHER",
] as const;

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
  phone: optionalText(20).refine((value) => value === null || /^\+?[\d\s()-]{7,}$/.test(value), {
    message: "Enter a phone number, digits only.",
  }),
  category: z.enum(KARIGAR_CATEGORIES, { error: "Choose a category." }),
  payMode: z.enum(PAY_MODES, { error: "Choose how they are paid." }),
  payRate: z
    .number({ error: "Enter the rate." })
    .min(0, "Rate cannot be negative.")
    .max(9_999_999, "Rate is too large.")
    .multipleOf(0.01, "Use at most 2 decimals.")
    // Left out (or ignored, without See prices & costs) keeps the current rate; a new person gets 0.
    .optional(),
  active: z.boolean().default(true),
  /** The login this person uses to see their own ledger; left out keeps the current one. */
  userId: z.uuid("Choose a login.").nullish(),
  /** A new login for this person, created with the record (needs users.manage). */
  login: personLoginSchema.optional(),
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
