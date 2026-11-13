import { randomUUID } from "node:crypto";

import { prisma, Prisma, transaction } from "../../db/prisma";
import { factoryToday } from "../../lib/business-date";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { columnFilters, contains, orderBy, page, where } from "../../lib/list-query";
import { recordAudit } from "../audit/audit.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { paisaText, toPaisa } from "../stitching/stitching.split";
import {
  LABEL,
  LEDGER_COLUMNS,
  MANUAL_TYPES,
  PEOPLE_COLUMNS,
  SIGN,
  type EntryInput,
  type LedgerQuery,
  type PeopleQuery,
} from "./payments.schema";

// Payments: every staff member's and karigar's account in one ledger (karigar_ledger).
// Earnings are posted by production documents; payments, advances, expenses, credits and
// money received back are recorded here. The balance is the sum of the ledger:
// positive = the business owes the person, negative = the person owes the business.
// Nothing is edited or deleted; a wrong manual entry gets a linked reversal row.

function fieldError(path: string, message: string): AppError {
  return new AppError(400, ErrorCode.VALIDATION_ERROR, message, { [path]: [message] });
}

function audit(actor: AuthContext, meta: ClientMeta) {
  return { actorUserId: actor.user.id, sessionId: actor.sessionId, meta };
}

const money = (value: string | number | null | undefined) => Number(value ?? 0).toFixed(2);

/** Ledger rows with the kind they count under (a reversal counts under what it reverses). */
const ENTRIES = (karigarId?: string) => Prisma.sql`
  SELECT l.id, l.seq, l.karigar_id, l.entry_date, l.type, l.amount, l.description, l.method, l.category, l.reference,
         l.source_type, l.source_id, l.created_by, l.created_at,
         CASE WHEN l.type IN ('EARNING', 'EARNING_REVERSAL') THEN 'EARNING'
              WHEN l.type = 'ENTRY_REVERSAL' THEN o.type ELSE l.type END AS kind
  FROM karigar_ledger l
  LEFT JOIN karigar_ledger o ON l.type = 'ENTRY_REVERSAL' AND o.source_type = 'MANUAL'
       AND o.source_id = l.source_id AND o.karigar_id = l.karigar_id AND o.type <> 'ENTRY_REVERSAL'
  ${karigarId ? Prisma.sql`WHERE l.karigar_id = ${karigarId}::uuid` : Prisma.empty}`;

/** Per person: balance and what it is made of. */
const TOTALS = (karigarId?: string) => Prisma.sql`
  SELECT e.karigar_id, sum(e.amount) AS balance,
         COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'EARNING'), 0) AS earned,
         COALESCE(-sum(e.amount) FILTER (WHERE e.kind = 'PAYMENT'), 0) AS paid,
         COALESCE(-sum(e.amount) FILTER (WHERE e.kind = 'ADVANCE'), 0) AS advances,
         COALESCE(-sum(e.amount) FILTER (WHERE e.kind = 'EXPENSE'), 0) AS expenses,
         COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'CREDIT'), 0) AS credits,
         COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'RECOVERY'), 0) AS recovered,
         max(e.entry_date) AS last_date
  FROM (${ENTRIES(karigarId)}) e GROUP BY e.karigar_id`;

interface TotalsRow {
  balance: string | null;
  earned: string | null;
  paid: string | null;
  advances: string | null;
  expenses: string | null;
  credits: string | null;
  recovered: string | null;
  last_date: string | null;
}

function totalsOf(row: TotalsRow | undefined) {
  return {
    earned: money(row?.earned),
    paid: money(row?.paid),
    advances: money(row?.advances),
    expenses: money(row?.expenses),
    credits: money(row?.credits),
    recovered: money(row?.recovered),
    balance: money(row?.balance),
    lastDate: row?.last_date ?? null,
  };
}

const BALANCE_FILTER = {
  owed: Prisma.sql`COALESCE(t.balance, 0) > 0`,
  owing: Prisma.sql`COALESCE(t.balance, 0) < 0`,
  settled: Prisma.sql`COALESCE(t.balance, 0) = 0`,
};

const EMPTY_LEDGER = { entries: [], total: 0, summary: { credit: "0.00", debit: "0.00", net: "0.00" } };

async function ledger(query: LedgerQuery) {
  const clauses = columnFilters(LEDGER_COLUMNS, query);

  if (query.search) {
    const pattern = contains(query.search);

    clauses.push(Prisma.sql`(lower(x.description || ' ' || COALESCE(x.category, '') || ' ' || COALESCE(x.reference, ''))
      LIKE ${pattern} OR k.search_text LIKE ${pattern})`);
  }

  const filter = where(clauses);
  // The running balance is taken over each person's whole ledger, before any filter.
  const from = Prisma.sql`
    FROM (SELECT e.*, sum(e.amount) OVER (PARTITION BY e.karigar_id ORDER BY e.entry_date, e.seq) AS running
          FROM (${ENTRIES(query.karigarId)}) e) x
    JOIN karigars k ON k.id = x.karigar_id
    JOIN users u ON u.id = x.created_by`;

  const [rows, [summary]] = await Promise.all([
    prisma.$queryRaw<
      {
        id: string;
        entry_date: string;
        type: string;
        kind: string;
        amount: string;
        running: string;
        description: string;
        method: string | null;
        category: string | null;
        reference: string | null;
        source_type: string;
        reversed: boolean;
        karigar_id: string;
        karigar_number: number;
        karigar_name: string;
        created_by: string;
        created_at: Date;
      }[]
    >`
      SELECT x.id, x.entry_date::text AS entry_date, x.type, x.kind, x.amount::text AS amount, x.running::text AS running,
             x.description, x.method, x.category, x.reference, x.source_type,
             (x.source_type = 'MANUAL' AND x.type <> 'ENTRY_REVERSAL' AND EXISTS (
               SELECT 1 FROM karigar_ledger r WHERE r.type = 'ENTRY_REVERSAL' AND r.source_type = 'MANUAL'
                 AND r.source_id = x.source_id AND r.karigar_id = x.karigar_id)) AS reversed,
             k.id AS karigar_id, k.number AS karigar_number, k.name AS karigar_name, u.name AS created_by, x.created_at
      ${from} ${filter} ${orderBy(LEDGER_COLUMNS, query, "x.entry_date DESC", "x.seq DESC")} ${page(query)}`,
    prisma.$queryRaw<{ total: number; credit: string; debit: string }[]>`
      SELECT count(*)::int AS total, COALESCE(sum(x.amount) FILTER (WHERE x.amount > 0), 0)::text AS credit,
             COALESCE(-sum(x.amount) FILTER (WHERE x.amount < 0), 0)::text AS debit
      ${from} ${filter}`,
  ]);

  return {
    entries: rows.map((row) => ({
      id: row.id,
      date: row.entry_date,
      type: row.type,
      kind: row.kind,
      label: LABEL[row.type] ?? row.type,
      amount: money(row.amount),
      balance: money(row.running),
      description: row.description,
      method: row.method,
      category: row.category,
      reference: row.reference,
      sourceType: row.source_type,
      reversible: row.source_type === "MANUAL" && row.type !== "ENTRY_REVERSAL" && !row.reversed,
      reversed: row.reversed,
      karigar: { id: row.karigar_id, number: row.karigar_number, name: row.karigar_name },
      createdBy: row.created_by,
      createdAt: row.created_at,
    })),
    total: summary!.total,
    summary: {
      credit: money(summary!.credit),
      debit: money(summary!.debit),
      net: (Number(summary!.credit) - Number(summary!.debit)).toFixed(2),
    },
  };
}

export const paymentsService = {
  /** Everyone with their balance and what it is made of; filters by balance state too. */
  async people(query: PeopleQuery) {
    const clauses = columnFilters(PEOPLE_COLUMNS, query);

    if (query.search) clauses.push(Prisma.sql`k.search_text LIKE ${contains(query.search)}`);

    if (query.balance) clauses.push(BALANCE_FILTER[query.balance]);

    if (query.active) clauses.push(Prisma.sql`k.active = ${query.active === "true"}`);

    const filter = where(clauses);
    const from = Prisma.sql`FROM karigars k LEFT JOIN (${TOTALS()}) t ON t.karigar_id = k.id`;
    const month = `${factoryToday().slice(0, 7)}-01`;

    const [rows, [count], [summary]] = await Promise.all([
      prisma.$queryRaw<
        (TotalsRow & {
          id: string;
          number: number;
          name: string;
          phone: string | null;
          category: string;
          active: boolean;
        })[]
      >`
        SELECT k.id, k.number, k.name, k.phone, k.category, k.active,
               t.balance::text AS balance, t.earned::text AS earned, t.paid::text AS paid, t.advances::text AS advances,
               t.expenses::text AS expenses, t.credits::text AS credits, t.recovered::text AS recovered,
               t.last_date::text AS last_date
        ${from} ${filter} ${orderBy(PEOPLE_COLUMNS, query, "k.active DESC, k.name", "k.number")} ${page(query)}`,
      prisma.$queryRaw<{ total: number; payable: string; receivable: string }[]>`
        SELECT count(*)::int AS total,
               COALESCE(sum(t.balance) FILTER (WHERE t.balance > 0), 0)::text AS payable,
               COALESCE(-sum(t.balance) FILTER (WHERE t.balance < 0), 0)::text AS receivable
        ${from} ${filter}`,
      prisma.$queryRaw<{ earned: string; paid: string; expenses: string; advances: string }[]>`
        SELECT COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'EARNING'), 0)::text AS earned,
               COALESCE(-sum(e.amount) FILTER (WHERE e.kind = 'PAYMENT'), 0)::text AS paid,
               COALESCE(-sum(e.amount) FILTER (WHERE e.kind = 'EXPENSE'), 0)::text AS expenses,
               COALESCE(-sum(e.amount) FILTER (WHERE e.kind = 'ADVANCE'), 0)::text AS advances
        FROM (${ENTRIES()}) e WHERE e.entry_date >= ${month}::date`,
    ]);

    return {
      people: rows.map((row) => ({
        id: row.id,
        number: row.number,
        name: row.name,
        phone: row.phone,
        category: row.category,
        active: row.active,
        ...totalsOf(row),
      })),
      total: count!.total,
      summary: {
        people: count!.total,
        payable: money(count!.payable),
        receivable: money(count!.receivable),
        earnedThisMonth: money(summary!.earned),
        paidThisMonth: money(summary!.paid),
        expensesThisMonth: money(summary!.expenses),
        advancesThisMonth: money(summary!.advances),
      },
    };
  },

  /** One person's account summary. */
  async person(karigarId: string) {
    const karigar = await prisma.karigar.findUnique({
      where: { id: karigarId },
      select: { id: true, number: true, name: true, phone: true, category: true, payMode: true, active: true },
    });

    if (!karigar) throw errors.notFound("Person");

    const [row] = await prisma.$queryRaw<TotalsRow[]>`
      SELECT t.balance::text AS balance, t.earned::text AS earned, t.paid::text AS paid, t.advances::text AS advances,
             t.expenses::text AS expenses, t.credits::text AS credits, t.recovered::text AS recovered,
             t.last_date::text AS last_date
      FROM (${TOTALS(karigarId)}) t`;

    return { person: karigar, summary: totalsOf(row) };
  },

  ledger,

  /** The signed-in person's own account, if their login is linked to a staff or karigar record. */
  async me(userId: string) {
    const karigar = await prisma.karigar.findUnique({ where: { userId }, select: { id: true } });

    return karigar ? this.person(karigar.id) : { person: null, summary: null };
  },

  /** The signed-in person's own ledger; any person asked for in the query is ignored. */
  async myLedger(userId: string, query: LedgerQuery) {
    const karigar = await prisma.karigar.findUnique({ where: { userId }, select: { id: true } });

    return karigar ? ledger({ ...query, karigarId: karigar.id }) : EMPTY_LEDGER;
  },

  async record(actor: AuthContext, input: EntryInput, meta: ClientMeta) {
    const karigar = await prisma.karigar.findUnique({ where: { id: input.karigarId }, select: { id: true } });

    if (!karigar) throw fieldError("karigarId", "Choose the person.");

    const amount = toPaisa(input.amount) * BigInt(SIGN[input.type]);
    const description = [LABEL[input.type], input.category, input.note].filter(Boolean).join(" · ").slice(0, 500);

    const id = await transaction(async (tx) => {
      const entry = await tx.karigarLedgerEntry.create({
        data: {
          karigarId: input.karigarId,
          entryDate: new Date(input.entryDate),
          type: input.type,
          payMode: "MANUAL",
          quantity: 0,
          rate: 0,
          amount: paisaText(amount),
          sourceType: "MANUAL",
          sourceId: randomUUID(),
          description,
          method: input.method,
          category: input.category,
          reference: input.reference,
          createdById: actor.user.id,
        },
        select: { id: true },
      });

      await recordAudit(tx, {
        type: "LEDGER_ENTRY_POSTED",
        ...audit(actor, meta),
        metadata: { entryId: entry.id, karigarId: input.karigarId, type: input.type, amount: paisaText(amount) },
      });

      return entry.id;
    });

    return this.entry(id);
  },

  async entry(id: string) {
    const entry = await prisma.karigarLedgerEntry.findUnique({
      where: { id },
      include: { karigar: { select: { id: true, number: true, name: true } }, createdBy: { select: { name: true } } },
    });

    if (!entry) throw errors.notFound("Ledger entry");

    return {
      id: entry.id,
      date: entry.entryDate.toISOString().slice(0, 10),
      type: entry.type,
      label: LABEL[entry.type] ?? entry.type,
      amount: entry.amount.toFixed(2),
      description: entry.description,
      method: entry.method,
      category: entry.category,
      reference: entry.reference,
      karigar: entry.karigar,
      createdBy: entry.createdBy.name,
      createdAt: entry.createdAt,
    };
  },

  /** Undoes a manual entry with an opposite one; earnings are reversed by their own documents. */
  async reverse(actor: AuthContext, id: string, reason: string, meta: ClientMeta) {
    const reversalId = await transaction(async (tx) => {
      const [original] = await tx.$queryRaw<
        { karigar_id: string; type: string; amount: string; source_type: string; source_id: string; description: string }[]
      >`SELECT karigar_id, type, amount::text AS amount, source_type, source_id, description
        FROM karigar_ledger WHERE id = ${id}::uuid`;

      if (!original) throw errors.notFound("Ledger entry");

      if (original.source_type !== "MANUAL" || !(MANUAL_TYPES as readonly string[]).includes(original.type)) {
        throw errors.conflict("Only payments, advances, expenses, credits and money received back are reversed here.");
      }

      // Serializes reversals of one entry; the unique (source, person, type) key is the final guard.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${original.source_id}))`;

      const done = await tx.karigarLedgerEntry.findFirst({
        where: { sourceType: "MANUAL", sourceId: original.source_id, type: "ENTRY_REVERSAL" },
        select: { id: true },
      });

      if (done) throw errors.conflict("This entry has already been reversed.");

      const reversal = await tx.karigarLedgerEntry.create({
        data: {
          karigarId: original.karigar_id,
          entryDate: new Date(factoryToday()),
          type: "ENTRY_REVERSAL",
          payMode: "MANUAL",
          quantity: 0,
          rate: 0,
          amount: new Prisma.Decimal(original.amount).negated().toFixed(2),
          sourceType: "MANUAL",
          sourceId: original.source_id,
          description: `Reversed: ${original.description} · ${reason}`.slice(0, 500),
          createdById: actor.user.id,
        },
        select: { id: true },
      });

      await recordAudit(tx, {
        type: "LEDGER_ENTRY_REVERSED",
        ...audit(actor, meta),
        metadata: { entryId: id, reversalId: reversal.id, reason },
      });

      return reversal.id;
    });

    return this.entry(reversalId);
  },
};
