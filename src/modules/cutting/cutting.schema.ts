import { z } from "zod";

import { businessDate } from "../../lib/business-date";
import { columnQueryFields, type ColumnQuery, type ColumnSpecs } from "../../lib/list-query";
import { parseScaled } from "./cutting.calc";

export const LOT_STATUSES = ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"] as const;

export const BATCH_STATUSES = ["DRAFT", "ISSUED", "FINALIZED", "REVERSED"] as const;

export const LOT_COLUMNS: ColumnSpecs = {
  lot: { type: "text", sql: "l.search_text", sortSql: "l.lot_key" },
  date: { type: "date", sql: "l.production_date" },
  article: { type: "text", sql: "lower(l.article_code || ' ' || l.article_name)", sortSql: "l.article_name" },
  fabric: { type: "text", sql: "f.search_text", sortSql: "f.name" },
  target: { type: "number", sql: "l.target_quantity" },
  cut: { type: "number", sql: "COALESCE(o.accepted, 0)" },
  status: { type: "enum", sql: "l.status", values: LOT_STATUSES },
};

export const BATCH_COLUMNS: ColumnSpecs = {
  number: { type: "number", sql: "b.number" },
  date: { type: "date", sql: "b.cutting_date" },
  lot: { type: "text", sql: "l.search_text", sortSql: "l.lot_key" },
  master: { type: "text", sql: "lower(COALESCE(k.name, ''))", sortSql: "k.name" },
  pala: { type: "number", sql: "b.total_pala" },
  pieces: { type: "number", sql: "b.total_accepted_pieces" },
  issued: { type: "number", sql: "COALESCE(b.total_issued_kg, r.issued, 0)" },
  wastage: { type: "number", sql: "b.total_wastage_kg" },
  status: { type: "enum", sql: "b.status", values: BATCH_STATUSES },
};

/** A non-negative decimal sent as a number or a string, kept as its exact text. */
const decimal = (places: number, max: number, label: string) =>
  z
    .union([z.number(), z.string()], { error: `Enter ${label}.` })
    .transform((value) => String(value).trim())
    .refine((text) => parseScaled(text, places) !== null, `Enter ${label} with at most ${places} decimals.`)
    .refine((text) => Number(text) <= max, `${label[0]!.toUpperCase()}${label.slice(1)} is too large.`);

const positiveDecimal = (places: number, max: number, label: string) =>
  decimal(places, max, label).refine((text) => parseScaled(text, places)! > 0n, `Enter ${label} above zero.`);

const optionalDecimal = (places: number, max: number, label: string) =>
  z
    .preprocess((value) => (value === "" ? null : value), positiveDecimal(places, max, label).nullish())
    .transform((value) => value ?? null);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .nullish()
    .transform((value) => value || null);

const label = (max: number, what: string) =>
  z.string().trim().min(1, `Enter the ${what}.`).max(max, `Keep the ${what} under ${max} characters.`);

const sizeSchema = z.strictObject({
  label: label(20, "size"),
  piecesPerPala: z.number({ error: "Enter pieces per Pala." }).int("Use whole pieces.").min(0).max(999),
  pieceWeightG: optionalDecimal(3, 100_000, "the weight in grams"),
});

export const markerSchema = z.strictObject({
  widthM: optionalDecimal(4, 100, "the width in metres"),
  lengthM: optionalDecimal(4, 1_000, "the marker length in metres"),
  gsm: optionalDecimal(2, 10_000, "the GSM"),
  measuredPalaKg: optionalDecimal(6, 10_000, "the Pala weight in kg"),
  weightSource: z.enum(["MEASURED", "CALCULATED"]).default("MEASURED"),
  repetitionsPerLayer: z
    .number({ error: "Use a whole number from 1 to 50." })
    .int("Use a whole number from 1 to 50.")
    .min(1, "Use a whole number from 1 to 50.")
    .max(50, "Use a whole number from 1 to 50.")
    .default(1),
});

/** Labels that must be unique within a list, compared case-insensitively. */
function uniqueBy<T>(
  items: T[],
  key: (item: T) => string,
  path: (index: number) => (string | number)[],
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();

  items.forEach((item, index) => {
    const value = key(item).trim().toLowerCase();

    if (seen.has(value))
      ctx.addIssue({ code: "custom", path: path(index), message: `${key(item).trim()} is listed twice.` });

    seen.add(value);
  });
}

const sizesSchema = z
  .array(sizeSchema)
  .min(1, "Add at least one size.")
  .max(30, "Use at most 30 sizes.")
  .superRefine((sizes, ctx) => {
    uniqueBy(
      sizes,
      (size) => size.label,
      (index) => [index, "label"],
      ctx,
    );

    // Single sizes may be 0 (left out of this marker), but the Pala must yield something.
    if (sizes.length > 0 && sizes.every((size) => size.piecesPerPala === 0)) {
      ctx.addIssue({ code: "custom", message: "At least one size needs pieces per Pala." });
    }
  });

// Fabric store quantities are kept to the gram, so issued and returned weights are too.
const rollSchema = z.strictObject({
  id: z.uuid().optional(),
  // Blank on a new Thaan: numbered when the draft is parsed (see numberThaan).
  thaan: z
    .string()
    .trim()
    .max(50, "Keep the Thaan number under 50 characters.")
    .nullish()
    .transform((value) => value ?? ""),
  issuedKg: positiveDecimal(3, 99_999, "the issued weight in kg"),
  // Blank means "work it out" (see calculateRoll).
  returnedKg: z
    .preprocess((value) => (value === "" ? null : value), decimal(3, 99_999, "the returned weight in kg").nullish())
    .transform((value) => value ?? null),
  confirmedLayers: z.number().int("Use a whole number.").min(0).max(100_000).nullable().default(null),
  // Optional: why the Pala differ from the estimate.
  note: z
    .string()
    .trim()
    .max(200, "Keep the note under 200 characters.")
    .nullish()
    .transform((value) => value || null),
}).refine(
  // Same rule as the calculator; the database CHECK would otherwise turn it into a 500.
  (roll) => roll.returnedKg === null || parseScaled(roll.returnedKg, 3)! <= parseScaled(roll.issuedKg, 3)!,
  { path: ["returnedKg"], message: "Returned weight cannot be more than the issued weight." },
);

const colourSchema = z.strictObject({
  id: z.uuid().optional(),
  name: label(50, "colour"),
  // A draft may name a colour before its Thaan are entered; finalizing requires them.
  rolls: z.array(rollSchema).max(100, "Use at most 100 Thaan per colour."),
});

export const cuttingDraftSchema = z
  .strictObject({
    cuttingMasterId: z.uuid("Choose the cutting master.").nullable().default(null),
    cuttingDate: businessDate,
    notes: optionalText(500),
    marker: markerSchema,
    sizes: sizesSchema,
    colours: z.array(colourSchema).max(30, "Use at most 30 colours.").default([]),
    /** Also store this marker and ratio as the article's default. */
    saveAsDefault: z.boolean().default(false),
  })
  .superRefine((draft, ctx) => {
    uniqueBy(
      draft.colours,
      (colour) => colour.name,
      (index) => ["colours", index, "name"],
      ctx,
    );

    const rolls = draft.colours.flatMap((colour, colourIndex) =>
      colour.rolls.flatMap((roll, rollIndex) =>
        roll.thaan ? [{ thaan: roll.thaan, path: ["colours", colourIndex, "rolls", rollIndex, "thaan"] }] : [],
      ),
    );

    uniqueBy(
      rolls,
      (roll) => roll.thaan,
      (index) => rolls[index]!.path,
      ctx,
    );
  })
  .transform(numberThaan);

/**
 * Gives every unnumbered Thaan the next free number in the batch ("1", "2", …).
 * The draft always carries every Thaan of its batch, so numbers stay unique per batch.
 */
function numberThaan<T extends { colours: { rolls: { thaan: string }[] }[] }>(draft: T): T {
  const taken = new Set(draft.colours.flatMap((colour) => colour.rolls.map((roll) => roll.thaan.toLowerCase())));
  let next = 1;

  for (const roll of draft.colours.flatMap((colour) => colour.rolls)) {
    if (roll.thaan) continue;

    while (taken.has(String(next))) next += 1;

    roll.thaan = String(next);
    taken.add(roll.thaan);
  }

  return draft;
}

/** What an article remembers as its cutting defaults. */
export const markerDefaultsSchema = markerSchema.extend({ sizes: sizesSchema });

const articleRef = z.union([
  z.strictObject({ id: z.uuid("Choose an item.") }),
  z.strictObject({
    name: label(100, "item / design name"),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9-]{0,23}$/, "Use up to 24 letters, numbers or dashes.")
      .nullish()
      .transform((value) => value || null),
  }),
]);

export const createLotSchema = z.strictObject({
  /** Typed by the operator; an existing open lot with this number takes the cutting. */
  lotNumber: z.string().trim().min(1, "Enter the lot number.").max(30, "Keep the lot number under 30 characters."),
  article: articleRef,
  fabricId: z.uuid("Choose a fabric."),
  productionDate: businessDate,
  targetQuantity: z.number().int("Use whole pieces.").min(1).max(10_000_000).nullable().default(null),
  notes: optionalText(500),
  cutting: cuttingDraftSchema.optional(),
  /** Also post the new cutting in the same request: issue its fabric, or finalize it. */
  action: z.enum(["issue", "finalize"]).optional(),
}).refine((input) => !input.action || input.cutting, { path: ["action"], message: "Add the cutting to post." });

/** Issue or finalize, optionally saving the form's unsaved edits first in the same transaction. */
export const postBatchSchema = z.strictObject({ cutting: cuttingDraftSchema.optional() }).default({});

export const updateLotSchema = z.strictObject({
  fabricId: z.uuid("Choose a fabric.").optional(),
  productionDate: businessDate.optional(),
  targetQuantity: z.number().int("Use whole pieces.").min(1).max(10_000_000).nullable().optional(),
  notes: optionalText(500).optional(),
  status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED"]).optional(),
});

export const previewSchema = z.strictObject({
  fabricId: z.uuid("Choose a fabric."),
  batchId: z.uuid().optional(),
  cutting: cuttingDraftSchema,
});

export const reverseSchema = z.strictObject({
  reason: z.string().trim().min(3, "Give a reason (at least 3 characters).").max(500),
});

const listPage = {
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const lotListQuerySchema = z.object({ ...listPage, ...columnQueryFields(LOT_COLUMNS) });

export const batchListQuerySchema = z.object({
  ...listPage,
  lotId: z.uuid().optional(),
  ...columnQueryFields(BATCH_COLUMNS),
});

export const idParamsSchema = z.object({ id: z.uuid() });

export type CuttingDraft = z.infer<typeof cuttingDraftSchema>;

export type MarkerDefaults = z.infer<typeof markerDefaultsSchema>;

export type CreateLotInput = z.infer<typeof createLotSchema>;

export type UpdateLotInput = z.infer<typeof updateLotSchema>;

export type LotListQuery = z.infer<typeof lotListQuerySchema> & ColumnQuery;

export type BatchListQuery = z.infer<typeof batchListQuerySchema> & ColumnQuery;
