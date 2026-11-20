import { Router, type RequestHandler } from "express";
import { z } from "zod";

import { prisma, transaction, type Prisma } from "../../db/prisma";
import { factoryToday } from "../../lib/business-date";
import { actorOf, clientMeta } from "../../lib/request";
import { recordAudit } from "../audit/audit.service";
import { requireAuth } from "../auth/auth.middleware";
import { requirePermission } from "../permissions/permission.middleware";
import type { AuthContext, ClientMeta } from "../sessions/session.types";

// Business settings: one row (app_settings). Company details print on reports, the lot pattern
// suggests the next lot number, the default reorder level applies to new fabrics, and the
// approval rules decide whether corrections go through Approvals.

type Db = Prisma.TransactionClient | typeof prisma;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .nullish()
    .transform((value) => value || null);

export const settingsSchema = z.strictObject({
  companyName: z.string().trim().min(1, "Enter the company name.").max(120, "Keep this under 120 characters."),
  address: text(300),
  phone: text(40),
  defaultReorderLevel: z
    .number()
    .min(0, "Cannot be negative.")
    .max(999_999_999, "Too large.")
    .nullish()
    .transform((value) => value ?? null),
  lotNumberPattern: z
    .string()
    .trim()
    .min(1, "Enter a pattern, e.g. LOT-{seq}.")
    .max(30, "Keep this under 30 characters.")
    .refine((value) => value.includes("{seq}"), "Include {seq}, the running number.")
    .refine((value) => !/\{(?!seq\}|year\})/.test(value), "Only {seq} and {year} can be used."),
  approveAdjustments: z.boolean(),
  approveReversals: z.boolean(),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

const INCLUDE = { updatedBy: { select: { name: true } } } as const;

/** Used if the row is missing (a fresh database before anyone saves); reading never writes. */
const DEFAULTS = {
  companyName: "My company",
  address: null,
  phone: null,
  defaultReorderLevel: null,
  lotNumberPattern: "LOT-{seq}",
  approveAdjustments: false,
  approveReversals: false,
  updatedBy: null,
  updatedAt: new Date(0),
};

/** The settings row, or the defaults. A pure read: safe inside any transaction, in parallel. */
export async function getSettings(db: Db = prisma) {
  const row = await db.appSettings.findUnique({ where: { id: true }, include: INCLUDE });

  if (!row) return DEFAULTS;

  return {
    companyName: row.companyName,
    address: row.address,
    phone: row.phone,
    defaultReorderLevel: row.defaultReorderLevel === null ? null : row.defaultReorderLevel.toNumber(),
    lotNumberPattern: row.lotNumberPattern,
    approveAdjustments: row.approveAdjustments,
    approveReversals: row.approveReversals,
    updatedBy: row.updatedBy?.name ?? null,
    updatedAt: row.updatedAt,
  };
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The next lot number the pattern suggests: the highest running number already used with that
 * pattern (this year, if it has {year}) plus one, zero-padded like the numbers already there.
 * Lot numbers are still typed; this only pre-fills the field.
 */
export async function nextLotNumber(pattern: string, db: Db = prisma): Promise<string> {
  const year = factoryToday().slice(0, 4);
  const [before = "", after = ""] = pattern.replaceAll("{year}", year).split("{seq}");
  const regex = `^${escapeRegex(before)}([0-9]+)${escapeRegex(after)}$`;
  const rows = await db.$queryRaw<{ lot_number: string }[]>`
    SELECT lot_number FROM production_lots WHERE lot_number ~* ${regex}`;
  const matcher = new RegExp(regex, "i");
  let highest = 0;
  let width = 1;

  for (const row of rows) {
    const digits = matcher.exec(row.lot_number)?.[1];

    if (!digits) continue;

    highest = Math.max(highest, Number(digits));

    if (digits.startsWith("0")) width = Math.max(width, digits.length);
  }

  return `${before}${String(highest + 1).padStart(width, "0")}${after}`;
}

async function saveSettings(actor: AuthContext, input: SettingsInput, meta: ClientMeta) {
  return transaction(async (tx) => {
    const before = await getSettings(tx);
    const data = { ...input, updatedById: actor.user.id, updatedAt: new Date() };

    await tx.appSettings.upsert({ where: { id: true }, update: data, create: { id: true, ...data } });

    const changed = (Object.keys(input) as (keyof SettingsInput)[]).filter((key) => before[key] !== input[key]);

    if (changed.length > 0) {
      await recordAudit(tx, {
        type: "SETTINGS_SAVED",
        actorUserId: actor.user.id,
        sessionId: actor.sessionId,
        meta,
        // Audit metadata holds plain values: the fields changed and each new value as text.
        metadata: { changed, ...Object.fromEntries(changed.map((key) => [key, String(input[key] ?? "")])) },
      });
    }

    return getSettings(tx);
  });
}

export function settingsRoutes(): Router {
  const router = Router();

  router.use(requireAuth);

  // Every signed-in person reads them: forms use the defaults, reports print the company header.
  router.get("/", (async (_req, res) => {
    res.json({ success: true, data: { settings: await getSettings() } });
  }) satisfies RequestHandler);

  // ?pattern= previews a pattern before it is saved (the Settings page shows "Next lot: …").
  router.get("/next-lot-number", (async (req, res) => {
    const preview = settingsSchema.shape.lotNumberPattern.safeParse(req.query.pattern);
    const pattern = preview.success ? preview.data : (await getSettings()).lotNumberPattern;

    res.json({ success: true, data: { lotNumber: await nextLotNumber(pattern) } });
  }) satisfies RequestHandler);

  router.put("/", requirePermission("settings.manage"), (async (req, res) => {
    const settings = await saveSettings(actorOf(req), settingsSchema.parse(req.body), clientMeta(req));

    res.json({ success: true, data: { settings } });
  }) satisfies RequestHandler);

  return router;
}
