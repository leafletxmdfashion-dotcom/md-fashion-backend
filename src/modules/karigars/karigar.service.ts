import { prisma, Prisma, transaction } from "../../db/prisma";
import { errors } from "../../lib/errors";
import { columnFilters, contains, orderBy, page, where } from "../../lib/list-query";
import { recordAudit } from "../audit/audit.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { KARIGAR_COLUMNS, type KarigarInput, type KarigarListQuery } from "./karigar.schema";

export interface KarigarDto {
  id: string;
  number: number;
  name: string;
  phone: string | null;
  category: string;
  payMode: string;
  /** Null without costing.view or karigar.manage (who sets rates). */
  payRate: number | null;
  /** Lifetime earnings are payroll data: null without costing.view. */
  earned: number | null;
  active: boolean;
  notes: string | null;
  createdAt: Date;
}

export interface KarigarOptionDto {
  id: string;
  number: number;
  name: string;
  category: string;
  payMode: string;
}

interface KarigarRow {
  id: string;
  number: number;
  name: string;
  phone: string | null;
  category: string;
  pay_mode: string;
  pay_rate: number;
  earned: number;
  active: boolean;
  notes: string | null;
  created_at: Date;
}

const SELECT = Prisma.raw(`
  k.id, k.number, k.name, k.phone, k.category, k.pay_mode, k.pay_rate::float8 AS pay_rate,
  COALESCE(e.earned, 0)::float8 AS earned, k.active, k.notes, k.created_at`);

const FROM = Prisma.raw(`
  FROM karigars k
  LEFT JOIN (SELECT karigar_id, sum(amount) AS earned FROM karigar_ledger GROUP BY karigar_id) e
    ON e.karigar_id = k.id`);

/** Which pay figures the caller may see. */
export interface PayVisibility {
  rate: boolean;
  earned: boolean;
}

function toKarigar(row: KarigarRow, pay: PayVisibility): KarigarDto {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    phone: row.phone,
    category: row.category,
    payMode: row.pay_mode,
    payRate: pay.rate ? row.pay_rate : null,
    earned: pay.earned ? row.earned : null,
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

async function findById(id: string, pay: PayVisibility): Promise<KarigarDto | null> {
  const [row] = await prisma.$queryRaw<KarigarRow[]>`SELECT ${SELECT} ${FROM} WHERE k.id = ${id}::uuid`;

  return row ? toKarigar(row, pay) : null;
}

function audit(actor: AuthContext, meta: ClientMeta) {
  return { actorUserId: actor.user.id, sessionId: actor.sessionId, meta };
}

export const karigarService = {
  async list(query: KarigarListQuery, pay: PayVisibility): Promise<{ karigars: KarigarDto[]; total: number }> {
    const clauses = columnFilters(KARIGAR_COLUMNS, query);

    if (query.search) clauses.push(Prisma.sql`k.search_text LIKE ${contains(query.search)}`);

    // Rates and earnings must not leak through filters or sort order either.
    if (
      (!pay.rate && (query.payRateMin ?? query.payRateMax) !== undefined) ||
      (!pay.earned && (query.earnedMin ?? query.earnedMax) !== undefined)
    ) {
      throw errors.forbidden();
    }

    const filter = where(clauses);
    const hiddenSort = (query.sort === "payRate" && !pay.rate) || (query.sort === "earned" && !pay.earned);
    const order = orderBy(KARIGAR_COLUMNS, hiddenSort ? { ...query, sort: undefined } : query, "k.active DESC, k.name", "k.id");

    const [rows, [count]] = await Promise.all([
      prisma.$queryRaw<KarigarRow[]>`SELECT ${SELECT} ${FROM} ${filter} ${order} ${page(query)}`,
      prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${FROM} ${filter}`,
    ]);

    return { karigars: rows.map((row) => toKarigar(row, pay)), total: count!.total };
  },

  /** Active workers for pickers, e.g. choosing a cutting master. */
  async options(category: string | undefined): Promise<KarigarOptionDto[]> {
    return prisma.karigar.findMany({
      where: category ? { active: true, category } : { active: true },
      select: { id: true, number: true, name: true, category: true, payMode: true },
      orderBy: [{ name: "asc" }, { number: "asc" }],
    });
  },

  async get(id: string, pay: PayVisibility): Promise<KarigarDto> {
    const karigar = await findById(id, pay);

    if (!karigar) throw errors.notFound("Karigar");

    return karigar;
  },

  async create(actor: AuthContext, input: KarigarInput, meta: ClientMeta, pay: PayVisibility): Promise<KarigarDto> {
    const id = await transaction(async (tx) => {
      const { id } = await tx.karigar.create({ data: { ...input, createdById: actor.user.id }, select: { id: true } });

      await recordAudit(tx, { type: "KARIGAR_CREATED", ...audit(actor, meta), metadata: { karigarId: id } });

      return id;
    });

    return (await findById(id, pay))!;
  },

  async update(
    actor: AuthContext,
    id: string,
    input: KarigarInput,
    meta: ClientMeta,
    pay: PayVisibility,
  ): Promise<KarigarDto> {
    await transaction(async (tx) => {
      const existing = await tx.karigar.findUnique({ where: { id }, select: { id: true } });

      if (!existing) throw errors.notFound("Karigar");

      // Past earnings keep the rate snapshotted on their ledger rows; only future jobs use the new rate.
      await tx.karigar.update({ where: { id }, data: input });
      await recordAudit(tx, {
        type: "KARIGAR_UPDATED",
        ...audit(actor, meta),
        metadata: { karigarId: id, payMode: input.payMode, active: input.active },
      });
    });

    return (await findById(id, pay))!;
  },
};
