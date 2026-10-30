import { z } from "zod";

import { businessDate } from "../../lib/business-date";
import { columnQueryFields, type ColumnQuery, type ColumnSpecs } from "../../lib/list-query";

export const SPLIT_METHODS = ["EQUAL", "PERCENT", "AMOUNT"] as const;

export type SplitMethod = (typeof SPLIT_METHODS)[number];

/** Reasons offered for rejected pieces; "Other" asks for a note. */
export const REJECT_REASONS = [
  "Stain or dirt",
  "Hole or tear",
  "Wrong stitching",
  "Shade difference",
  "Wrong measurement",
  "Fabric defect",
  "Other",
] as const;

/** A reason from the list, or "Other: <what was wrong>", as the receive and rework dialogs send it. */
const listedReason = z
  .string()
  .trim()
  .max(200, "Keep the reason under 200 characters.")
  .nullish()
  .transform((value) => value || null)
  .refine((value) => value === null || value !== "Other", "Say what was wrong.")
  .refine(
    (value) =>
      value === null ||
      (REJECT_REASONS as readonly string[]).includes(value) ||
      /^Other:\s*\S/.test(value),
    "Choose a reason from the list.",
  );

export const ISSUE_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "i.issue_date" },
  number: { type: "number", sql: "i.number" },
  lot: { type: "text", sql: "lp.search_text", sortSql: "lp.lot_key" },
  team: { type: "text", sql: "lower(i.team_name)", sortSql: "i.team_name" },
  operation: { type: "text", sql: "lower(i.operation)", sortSql: "i.operation" },
  issued: { type: "number", sql: "t.issued" },
  wip: { type: "number", sql: "(t.issued - t.received)" },
  status: {
    type: "enum",
    sql: "CASE WHEN i.status = 'REVERSED' THEN 'reversed' WHEN t.issued > t.received THEN 'open' ELSE 'done' END",
    values: ["open", "done", "reversed"],
  },
};

export const REWORK_COLUMNS: ColumnSpecs = {
  number: { type: "number", sql: "r.number" },
  date: { type: "date", sql: "r.created_at::date" },
  lot: { type: "text", sql: "lp.search_text", sortSql: "lp.lot_key" },
  team: { type: "text", sql: "lower(i.team_name)", sortSql: "i.team_name" },
  pending: { type: "number", sql: "(r.quantity - r.recovered - r.failed)" },
  status: {
    type: "enum",
    sql: "r.status",
    values: ["PENDING", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED"],
  },
};

export const REJECT_COLUMNS: ColumnSpecs = {
  date: { type: "date", sql: "x.date" },
  lot: { type: "text", sql: "lower(x.lot_number || ' ' || x.article_name)", sortSql: "x.lot_number" },
  reason: { type: "text", sql: "lower(x.reason)", sortSql: "x.reason" },
  quantity: { type: "number", sql: "x.quantity" },
};

const notes = z
  .string()
  .trim()
  .max(500, "Keep notes under 500 characters.")
  .nullish()
  .transform((value) => value || null);

const reason = z.string().trim().min(3, "Give a reason (at least 3 characters).").max(500);

const pieces = (label: string) =>
  z
    .number({ error: `Enter ${label}.` })
    .int("Use whole pieces.")
    .min(0, "Cannot be negative.")
    .max(1_000_000, "Too many pieces.");

const issueLines = z
  .array(
    z.strictObject({
      colour: z.string().trim().min(1).max(50),
      sizeLabel: z.string().trim().min(1).max(20),
      quantity: pieces("the pieces").min(1, "Issue at least 1 piece."),
    }),
  )
  .min(1, "Enter how many pieces this team gets.")
  .max(300);

/**
 * Cut pieces of one lot, issued for one kind of work at one rate to one team, or
 * divided between several. Each team gets its own issue (SI-number); all are posted
 * together or not at all.
 */
export const issueSchema = z
  .strictObject({
    lotId: z.uuid("Choose a lot."),
    operation: z.string().trim().min(1, "Enter the work, e.g. Full stitching.").max(60, "Keep it under 60 characters."),
    rate: z
      .number({ error: "Enter the rate per piece." })
      .min(0, "Rate cannot be negative.")
      .max(99_999, "Rate is too large.")
      .multipleOf(0.01, "Use at most 2 decimals."),
    issueDate: businessDate,
    notes,
    teams: z
      .array(z.strictObject({ teamId: z.uuid("Choose a Jogadi team."), lines: issueLines }))
      .min(1, "Choose a Jogadi team.")
      .max(10, "Divide between at most 10 teams."),
  })
  .superRefine((issue, ctx) => {
    const teams = new Set<string>();

    issue.teams.forEach((team, teamIndex) => {
      if (teams.has(team.teamId)) {
        ctx.addIssue({ code: "custom", path: ["teams", teamIndex, "teamId"], message: "This team is chosen twice." });
      }

      teams.add(team.teamId);

      const seen = new Set<string>();

      team.lines.forEach((line, index) => {
        const key = JSON.stringify([line.colour, line.sizeLabel]);

        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["teams", teamIndex, "lines", index, "quantity"],
            message: "Listed twice.",
          });
        }

        seen.add(key);
      });
    });
  });

export const receiptSchema = z
  .strictObject({
    receiptDate: businessDate,
    notes,
    lines: z
      .array(
        z.strictObject({
          issueLineId: z.uuid(),
          good: pieces("Good pieces"),
          rework: pieces("Rework pieces"),
          reject: pieces("Reject pieces"),
          rejectReason: listedReason,
        }),
      )
      .max(300)
      // Rows left at zero are not part of the receipt.
      .transform((lines) => lines.filter((line) => line.good + line.rework + line.reject > 0))
      .refine((lines) => lines.length > 0, "Enter the pieces received."),
    /** Left out: the split the issue was given (equal, or the team's shares). */
    split: z
      .strictObject({
        method: z.enum(SPLIT_METHODS),
        members: z
          .array(
            z.strictObject({
              karigarId: z.uuid(),
              percent: z.number().min(0).max(100).multipleOf(0.01, "Use at most 2 decimals.").nullish(),
              amount: z.number().min(0).max(99_999_999).multipleOf(0.01, "Use at most 2 decimals.").nullish(),
            }),
          )
          .default([]),
      })
      .optional(),
  })
  .superRefine((receipt, ctx) => {
    const seen = new Set<string>();

    receipt.lines.forEach((line, index) => {
      if (seen.has(line.issueLineId))
        ctx.addIssue({ code: "custom", path: ["lines", index, "good"], message: "Listed twice." });

      seen.add(line.issueLineId);

      if (line.reject > 0 && !line.rejectReason) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "rejectReason"],
          message: "Choose why the pieces were rejected.",
        });
      }
    });
  });

export const reverseSchema = z.strictObject({ reason });

export const reworkUpdateSchema = z.strictObject({
  status: z.enum(["ASSIGNED", "IN_PROGRESS"]),
  assignedToId: z
    .uuid("Choose a karigar.")
    .nullish()
    .transform((value) => value ?? null),
});

export const reworkResolveSchema = z
  .strictObject({
    resolvedOn: businessDate,
    recovered: pieces("recovered pieces"),
    failed: pieces("failed pieces"),
    failedReason: listedReason,
  })
  .superRefine((input, ctx) => {
    if (input.recovered + input.failed === 0) {
      ctx.addIssue({ code: "custom", path: ["recovered"], message: "Enter the pieces recovered or failed." });
    }

    if (input.failed > 0 && !input.failedReason) {
      ctx.addIssue({ code: "custom", path: ["failedReason"], message: "Choose why the pieces failed." });
    }
  });

const listPage = {
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const issueListQuerySchema = z.object({
  ...listPage,
  lotId: z.uuid().optional(),
  teamId: z.uuid().optional(),
  ...columnQueryFields(ISSUE_COLUMNS),
});

export const reworkListQuerySchema = z.object({
  ...listPage,
  lotId: z.uuid().optional(),
  ...columnQueryFields(REWORK_COLUMNS),
});

export const rejectListQuerySchema = z.object({
  ...listPage,
  lotId: z.uuid().optional(),
  ...columnQueryFields(REJECT_COLUMNS),
});

export const lotSearchSchema = z.object({ search: z.string().trim().max(100).optional() });

export const idParamsSchema = z.object({ id: z.uuid() });

export type IssueInput = z.infer<typeof issueSchema>;

export type ReceiptInput = z.infer<typeof receiptSchema>;

export type ReworkResolveInput = z.infer<typeof reworkResolveSchema>;

export type IssueListQuery = z.infer<typeof issueListQuerySchema> & ColumnQuery;

export type ReworkListQuery = z.infer<typeof reworkListQuerySchema> & ColumnQuery;

export type RejectListQuery = z.infer<typeof rejectListQuerySchema> & ColumnQuery;
