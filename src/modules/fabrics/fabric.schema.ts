import { z } from "zod";

import { businessDate } from "../../lib/business-date";
import { columnQueryFields, type ColumnQuery } from "../../lib/list-query";
import { FABRIC_COLUMNS, INWARD_COLUMNS, MOVEMENT_COLUMNS, MOVEMENT_TYPES } from "./fabric.columns";

export { MOVEMENT_TYPES };
export const FABRIC_UNITS = ["KG", "METER"] as const;

/** Blank strings become null so optional columns stay NULL rather than ''. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .nullish()
    .transform((value) => value || null);

const reason = z
  .string()
  .trim()
  .min(3, "Give a reason (at least 3 characters).")
  .max(500, "Keep the reason under 500 characters.");

/** True when `value` has at most `places` decimals, allowing for float noise (0.1 + 0.2). */
const hasPlaces = (value: number, places: number) => {
  const scaled = value * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};

// Columns are numeric(12,3) quantity, numeric(12,2) rate, numeric(14,2) amount: values are
// rejected rather than rounded on insert, so what the user confirms is what is stored.
const quantity = z
  .number({ error: "Enter a quantity." })
  .positive("Quantity must be more than zero.")
  .max(999_999_999, "Quantity is too large.")
  .refine((value) => hasPlaces(value, 3), "Use at most 3 decimals for quantity.");

const MAX_AMOUNT = 999_999_999_999.99;

// Inner spaces are collapsed so "Cotton  Jersey" is the same fabric as "Cotton Jersey".
const fabricName = z
  .string({ error: "Enter the fabric name." })
  .trim()
  .min(1, "Enter the fabric name.")
  .max(100, "Keep the name under 100 characters.")
  .transform((value) => value.replace(/\s+/g, " "));

/**
 * A purchase names its fabric. An existing name (any case) adds to that fabric, and
 * its reorder level and description are updated when sent; a new name creates the
 * fabric with a generated code.
 */
export const createInwardSchema = z.strictObject({
  fabricName,
  unit: z.enum(FABRIC_UNITS, { error: "Choose a unit." }),
  // Left out: an existing fabric keeps its own. Null clears it.
  lowStockThreshold: z.number().min(0, "Reorder level cannot be negative.").max(999_999_999).nullish(),
  description: z
    .string()
    .trim()
    .max(500, "Keep this under 500 characters.")
    .nullish()
    .transform((value) => (value === undefined ? undefined : value || null)),
  inwardDate: businessDate,
  quantity,
  rate: z
    .number({ error: "Enter a rate." })
    .min(0, "Rate cannot be negative.")
    .max(99_999_999, "Rate is too large.")
    .refine((value) => hasPlaces(value, 2), "Use at most 2 decimals for rate."),
  supplier: optionalText(100),
  invoiceRef: optionalText(50),
  notes: optionalText(500),
}).refine((input) => input.quantity * input.rate <= MAX_AMOUNT, {
  path: ["rate"],
  message: "Amount (quantity × rate) is too large.",
});

/** Fixing a fabric's details. The code is generated and never edited. */
export const updateFabricSchema = z.strictObject({
  name: fabricName,
  unit: z.enum(FABRIC_UNITS, { error: "Choose a unit." }),
  lowStockThreshold: z.number().min(0, "Reorder level cannot be negative.").max(999_999_999).nullish().default(null),
  description: optionalText(500),
});

export const reverseInwardSchema = z.strictObject({ reason });

export const adjustmentSchema = z.strictObject({
  direction: z.enum(["IN", "OUT"], { error: "Choose increase or reduce." }),
  quantity,
  reason,
});

export const idParamsSchema = z.object({ id: z.uuid() });

const page = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
const search = { search: z.string().trim().max(100).optional() };

// Unless the status column is filtered, the master shows active fabrics only.
export const fabricListQuerySchema = z.object({
  ...search,
  stock: z.enum(["low", "out"]).optional(),
  ...columnQueryFields(FABRIC_COLUMNS),
  ...page,
});

export const inwardListQuerySchema = z.object({
  ...search,
  fabricId: z.uuid().optional(),
  ...columnQueryFields(INWARD_COLUMNS),
  ...page,
});

export const movementListQuerySchema = z.object({
  ...search,
  fabricId: z.uuid().optional(),
  ...columnQueryFields(MOVEMENT_COLUMNS),
  ...page,
});

export type UpdateFabricInput = z.infer<typeof updateFabricSchema>;
export type CreateInwardInput = z.infer<typeof createInwardSchema>;
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;
export type FabricListQuery = z.infer<typeof fabricListQuerySchema> & ColumnQuery;
export type InwardListQuery = z.infer<typeof inwardListQuerySchema> & ColumnQuery;
export type MovementListQuery = z.infer<typeof movementListQuerySchema> & ColumnQuery;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
