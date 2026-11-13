import { z } from "zod";

import { businessDate } from "../../lib/business-date";
import { columnQueryFields, type ColumnQuery, type ColumnSpecs } from "../../lib/list-query";
import { KARIGAR_CATEGORIES } from "../karigars/karigar.schema";

/** Entries recorded by hand. Earnings come from cutting, stitching, rework and packing. */
export const MANUAL_TYPES = ["PAYMENT", "ADVANCE", "EXPENSE", "CREDIT", "RECOVERY"] as const;

export type ManualType = (typeof MANUAL_TYPES)[number];

/** What an entry does to the balance: + the business owes the person more, − less (or the person owes). */
export const SIGN: Record<ManualType, 1 | -1> = { PAYMENT: -1, ADVANCE: -1, EXPENSE: -1, CREDIT: 1, RECOVERY: 1 };

export const LABEL: Record<string, string> = {
  EARNING: "Earning",
  EARNING_REVERSAL: "Earning reversed",
  PAYMENT: "Payment",
  ADVANCE: "Advance / loan",
  EXPENSE: "Expense",
  CREDIT: "Credit",
  RECOVERY: "Money received back",
  ENTRY_REVERSAL: "Reversal",
};

/** Kinds an entry is counted under: a reversal counts under what it reverses. */
export const KINDS = ["EARNING", "PAYMENT", "ADVANCE", "EXPENSE", "CREDIT", "RECOVERY"] as const;

export const LEDGER_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "x.entry_date" },
  kind: { type: "enum", sql: "x.kind", values: KINDS },
  amount: { type: "number", sql: "x.amount" },
  person: { type: "text", sql: "k.search_text", sortSql: "k.name" },
  method: { type: "enum", sql: "x.method", values: ["CASH", "BANK", "WALLET"] },
};

export const PEOPLE_COLUMNS: ColumnSpecs = {
  name: { type: "text", sql: "k.search_text", sortSql: "k.name" },
  category: { type: "enum", sql: "k.category", values: KARIGAR_CATEGORIES },
  balance: { type: "number", sql: "COALESCE(t.balance, 0)" },
  earned: { type: "number", sql: "COALESCE(t.earned, 0)" },
  paid: { type: "number", sql: "COALESCE(t.paid, 0)" },
  last: { type: "date", sql: "t.last_date" },
};

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .nullish()
    .transform((value) => value || null);

export const entrySchema = z.strictObject({
  karigarId: z.uuid("Choose the person."),
  type: z.enum(MANUAL_TYPES, { error: "Choose what this is." }),
  amount: z
    .number({ error: "Enter the amount." })
    .positive("Enter an amount above zero.")
    .max(99_999_999, "Amount is too large.")
    .multipleOf(0.01, "Use at most 2 decimals (paisa)."),
  entryDate: businessDate,
  method: z
    .enum(["CASH", "BANK", "WALLET"])
    .nullish()
    .transform((value) => value ?? null),
  category: text(40),
  reference: text(60),
  note: text(300),
});

export const reverseSchema = z.strictObject({
  reason: z.string().trim().min(3, "Give a reason (at least 3 characters).").max(300),
});

const listPage = {
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const ledgerQuerySchema = z.object({
  ...listPage,
  karigarId: z.uuid().optional(),
  ...columnQueryFields(LEDGER_COLUMNS),
});

export const peopleQuerySchema = z.object({
  ...listPage,
  balance: z.enum(["owed", "owing", "settled"]).optional(),
  active: z.enum(["true", "false"]).optional(),
  ...columnQueryFields(PEOPLE_COLUMNS),
});

export const idParamsSchema = z.object({ id: z.uuid() });

export type EntryInput = z.infer<typeof entrySchema>;

export type LedgerQuery = z.infer<typeof ledgerQuerySchema> & ColumnQuery;

export type PeopleQuery = z.infer<typeof peopleQuerySchema> & ColumnQuery;
