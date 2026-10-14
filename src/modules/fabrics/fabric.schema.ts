import { z } from "zod";

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

const quantity = z
  .number({ error: "Enter a quantity." })
  .positive("Quantity must be more than zero.")
  .max(999_999_999, "Quantity is too large.");

// Allows one day of slack so a client a timezone ahead of the server can still post "today".
const businessDate = z.iso
  .date("Enter a valid date.")
  .refine(
    (value) => value <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    "Date cannot be in the future.",
  );

const fabricFields = {
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{0,23}$/, "Use up to 24 letters, numbers or dashes."),
  name: z.string().trim().min(1, "Name is required.").max(100, "Keep the name under 100 characters."),
  unit: z.enum(FABRIC_UNITS, { error: "Choose a unit." }),
  lowStockThreshold: z.number().min(0, "Threshold cannot be negative.").max(999_999_999).nullish().default(null),
  description: optionalText(500),
};

export const createFabricSchema = z.strictObject(fabricFields);

export const updateFabricSchema = z.strictObject(fabricFields);

export const createInwardSchema = z.strictObject({
  fabricId: z.uuid("Choose a fabric."),
  inwardDate: businessDate,
  quantity,
  rate: z.number({ error: "Enter a rate." }).min(0, "Rate cannot be negative.").max(99_999_999, "Rate is too large."),
  supplier: optionalText(100),
  invoiceRef: optionalText(50),
  notes: optionalText(500),
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

export type CreateFabricInput = z.infer<typeof createFabricSchema>;
export type UpdateFabricInput = z.infer<typeof updateFabricSchema>;
export type CreateInwardInput = z.infer<typeof createInwardSchema>;
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;
export type FabricListQuery = z.infer<typeof fabricListQuerySchema> & ColumnQuery;
export type InwardListQuery = z.infer<typeof inwardListQuerySchema> & ColumnQuery;
export type MovementListQuery = z.infer<typeof movementListQuerySchema> & ColumnQuery;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
