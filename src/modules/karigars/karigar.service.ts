import { prisma, Prisma, transaction } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { columnFilters, contains, orderBy, page, where } from "../../lib/list-query";
import { recordAudit } from "../audit/audit.service";
import { canManageUser } from "../permissions/permission.service";
import { sessionService } from "../sessions/session.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { invitationService, type CreatedLogin, type PreparedLogin } from "../users/invitation.service";
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
  /** The login linked to this person, if any. */
  user: { id: string; name: string; email: string | null; phone: string | null } | null;
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
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  user_phone: string | null;
  created_at: Date;
}

const SELECT = Prisma.raw(`
  k.id, k.number, k.name, k.phone, k.category, k.pay_mode, k.pay_rate::float8 AS pay_rate,
  COALESCE(e.earned, 0)::float8 AS earned, k.active, k.notes, u.id AS user_id, u.name AS user_name,
  u.email AS user_email, u.phone AS user_phone, k.created_at`);

const FROM = Prisma.raw(`
  FROM karigars k
  LEFT JOIN (SELECT karigar_id, sum(amount) AS earned FROM karigar_ledger
             WHERE type IN ('EARNING', 'EARNING_REVERSAL') GROUP BY karigar_id) e
    ON e.karigar_id = k.id
  LEFT JOIN users u ON u.id = k.user_id`);

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
    user: row.user_id
      ? { id: row.user_id, name: row.user_name!, email: row.user_email, phone: row.user_phone }
      : null,
    createdAt: row.created_at,
  };
}

async function findById(id: string, pay: PayVisibility): Promise<KarigarDto | null> {
  const [row] = await prisma.$queryRaw<KarigarRow[]>`SELECT ${SELECT} ${FROM} WHERE k.id = ${id}::uuid`;

  return row ? toKarigar(row, pay) : null;
}

/** Columns to write; an absent userId leaves the link as it is. The new-login request is not a column. */
function dataOf({ userId, login: _login, ...rest }: KarigarInput) {
  return userId === undefined ? rest : { ...rest, userId };
}

/** A person saved together with the login made for them (if one was). */
export interface KarigarSaved {
  karigar: KarigarDto;
  /** Includes the one-time invitation link for INVITE, to share when there is no email. */
  login: CreatedLogin | null;
}

/** Role, hierarchy and password checks for a new login, before the transaction (Argon2 is slow). */
async function prepareLogin(actor: AuthContext, input: KarigarInput): Promise<PreparedLogin | null> {
  if (!input.login) return null;

  if (input.userId) {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Link an existing login or create a new one, not both.", {
      userId: ["Link an existing login or create a new one, not both."],
    });
  }

  return invitationService.prepare(actor, { ...input.login, name: input.name });
}

/**
 * A login may be linked to one person, by someone who manages users (it shows that login the
 * person's ledger). Leaving userId out keeps the current link.
 */
async function checkLogin(
  tx: Prisma.TransactionClient,
  actor: AuthContext,
  current: string | null,
  next: string | null | undefined,
): Promise<void> {
  if (next === undefined || next === current) return;

  if (!actor.user.permissions.has("users.manage")) {
    throw new AppError(403, ErrorCode.AUTH_FORBIDDEN, "Linking a login needs permission to manage users.");
  }

  if (next === null) return;

  const user = await tx.user.findUnique({
    where: { id: next },
    select: {
      name: true,
      role: { select: { key: true, name: true, rank: true } },
      karigar: { select: { name: true } },
    },
  });

  if (!user) throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Choose a login.", { userId: ["Choose a login."] });

  // Only logins the actor may manage (below their rank, or any for the owner) can be linked.
  if (!canManageUser(actor.user, user.role)) throw errors.forbidden();

  if (user.karigar) throw errors.conflict(`${user.name}'s login is already linked to ${user.karigar.name}.`);
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
    const order = orderBy(
      KARIGAR_COLUMNS,
      hiddenSort ? { ...query, sort: undefined } : query,
      "k.active DESC, k.name",
      "k.id",
    );

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

  async create(actor: AuthContext, input: KarigarInput, meta: ClientMeta, pay: PayVisibility): Promise<KarigarSaved> {
    const prepared = await prepareLogin(actor, input);

    const { id, login } = await transaction(async (tx) => {
      await checkLogin(tx, actor, null, input.userId);

      // The person and their login are created together, or neither is.
      const login = prepared ? await invitationService.createInTx(tx, actor, prepared, meta) : null;
      const data = { ...dataOf(input), ...(login ? { userId: login.userId } : {}), createdById: actor.user.id };
      const { id } = await tx.karigar.create({ data, select: { id: true } });

      await recordAudit(tx, {
        type: "KARIGAR_CREATED",
        ...audit(actor, meta),
        metadata: { karigarId: id, ...(login ? { loginUserId: login.userId, loginMode: login.mode } : {}) },
      });

      return { id, login };
    });

    // The linked person is part of the signed-in user (their own ledger); drop cached sessions.
    if (login || input.userId !== undefined) sessionService.forgetCached();
    if (login && prepared) await invitationService.notify(login, prepared.input);

    return { karigar: (await findById(id, pay))!, login };
  },

  async update(
    actor: AuthContext,
    id: string,
    input: KarigarInput,
    meta: ClientMeta,
    pay: PayVisibility,
  ): Promise<KarigarSaved> {
    const prepared = await prepareLogin(actor, input);

    const login = await transaction(async (tx) => {
      const [existing] = await tx.$queryRaw<{ id: string; user_id: string | null }[]>`
        SELECT id, user_id FROM karigars WHERE id = ${id}::uuid FOR UPDATE`;

      if (!existing) throw errors.notFound("Karigar");

      if (prepared && existing.user_id) throw errors.conflict("This person already has a login.");

      await checkLogin(tx, actor, existing.user_id, input.userId);

      const login = prepared ? await invitationService.createInTx(tx, actor, prepared, meta) : null;

      // Past earnings keep the rate snapshotted on their ledger rows; only future jobs use the new rate.
      await tx.karigar.update({
        where: { id },
        data: { ...dataOf(input), ...(login ? { userId: login.userId } : {}) },
      });
      await recordAudit(tx, {
        type: "KARIGAR_UPDATED",
        ...audit(actor, meta),
        metadata: {
          karigarId: id,
          payMode: input.payMode,
          active: input.active,
          ...(login ? { loginUserId: login.userId, loginMode: login.mode } : {}),
        },
      });

      return login;
    });

    // The linked person is part of the signed-in user (their own ledger); drop cached sessions.
    if (login || input.userId !== undefined) sessionService.forgetCached();
    if (login && prepared) await invitationService.notify(login, prepared.input);

    return { karigar: (await findById(id, pay))!, login };
  },
};
