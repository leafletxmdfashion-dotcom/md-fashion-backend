import { prisma, Prisma, transaction } from "../../db/prisma";
import { factoryToday } from "../../lib/business-date";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { columnFilters, contains, orderBy, page, where } from "../../lib/list-query";
import { recordAudit } from "../audit/audit.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { paisaText, splitEarning, toPaisa } from "../stitching/stitching.split";
import { ENTRY_COLUMNS, LINE_COLUMNS, type EntryListQuery, type LineListQuery, type PackInput } from "./packing.schema";

// Packing: Good pieces from stitching (receipt Good + recovered rework) wait to be packed
// with no transfer step. A packing team packs them, per size, at a typed rate per piece:
// the earning is split equally into the members' ledgers, packing labour is booked on the
// lot and the pieces go into the godown, all in one transaction. Entries from before teams
// name one packer. Corrections are reversals. Lock order: lot, team, entry, godown stock.

type Tx = Prisma.TransactionClient;

export const packingNumber = (number: number) => `PK-${String(number).padStart(4, "0")}`;

const pcs = (count: number) => `${count.toLocaleString("en-IN")} piece${count === 1 ? "" : "s"}`;

function fieldError(path: string, message: string): AppError {
  return new AppError(400, ErrorCode.VALIDATION_ERROR, message, { [path]: [message] });
}

function audit(actor: AuthContext, meta: ClientMeta) {
  return { actorUserId: actor.user.id, sessionId: actor.sessionId, meta };
}

/** "PK-12", "pk12" or "12" → 12, so entry numbers are searchable. */
function numberOf(text: string): number | null {
  const match = /^(?:pk-?)?0*(\d{1,9})$/i.exec(text.trim());

  return match ? Number(match[1]) : null;
}

export interface SizeBalance {
  lot_id: string;
  size: string;
  good: number;
  packed: number;
  position: number;
}

/**
 * Good and packed pieces per lot and size. Good = posted receipt Good + recovered rework;
 * packed = posted packing. One lot when lotId is given.
 */
export function packingBalance(db: Tx | typeof prisma, lotId?: string) {
  const lot = (column: string) => (lotId ? Prisma.sql`AND ${Prisma.raw(column)} = ${lotId}::uuid` : Prisma.empty);

  return db.$queryRaw<SizeBalance[]>`
    WITH moves AS (
      SELECT r.lot_id, rl.size_label AS size, rl.good AS good, 0 AS packed
      FROM stitching_receipt_lines rl JOIN stitching_receipts r ON r.id = rl.receipt_id AND r.status = 'POSTED'
      WHERE rl.good > 0 ${lot("r.lot_id")}
      UNION ALL
      SELECT lot_id, size_label, recovered, 0 FROM rework_items
      WHERE recovered > 0 AND status <> 'CANCELLED' ${lot("lot_id")}
      UNION ALL
      SELECT e.lot_id, pl.size_label, 0, pl.quantity
      FROM packing_lines pl JOIN packing_entries e ON e.id = pl.entry_id AND e.status = 'POSTED'
      WHERE true ${lot("e.lot_id")}
    )
    SELECT m.lot_id, m.size, sum(m.good)::int AS good, sum(m.packed)::int AS packed,
           COALESCE((SELECT min(o.position) FROM cutting_outputs o WHERE o.lot_id = m.lot_id AND o.size_label = m.size), 999)::int AS position
    FROM moves m GROUP BY m.lot_id, m.size`;
}

const bySizeOrder = (a: SizeBalance, b: SizeBalance) => a.position - b.position || a.size.localeCompare(b.size);

async function lockLot(tx: Tx, lotId: string) {
  const [lot] = await tx.$queryRaw<
    { id: string; lot_number: string; article_id: string; article_name: string; status: string }[]
  >`
    SELECT id, lot_number, article_id, article_name, status FROM production_lots WHERE id = ${lotId}::uuid FOR UPDATE`;

  if (!lot) throw fieldError("lotId", "Choose a lot.");

  return lot;
}

/** Who packed an entry: its packing team, or (older entries) one person. */
function packedBy(row: { team_id: string | null; team_name: string | null; packer_id: string | null; packer_name: string | null }) {
  return row.team_id
    ? { kind: "TEAM" as const, id: row.team_id, name: row.team_name ?? "" }
    : { kind: "PERSON" as const, id: row.packer_id ?? "", name: row.packer_name ?? "" };
}

/** Entries a person packed alone or as a member of the packing team. */
const byPerson = (id: string) =>
  Prisma.sql`(e.packer_id = ${id}::uuid OR EXISTS (
    SELECT 1 FROM packing_entry_members pm WHERE pm.entry_id = e.id AND pm.karigar_id = ${id}::uuid))`;

const ENTRY_INCLUDE = {
  lot: { select: { id: true, lotNumber: true, articleId: true, articleName: true, articleCode: true } },
  lines: { orderBy: { position: "asc" } },
  members: { orderBy: { karigarName: "asc" } },
  createdBy: { select: { name: true } },
  reversedBy: { select: { name: true } },
} satisfies Prisma.PackingEntryInclude;

export const packingService = {
  /** Lots with Good pieces still to pack, per size. */
  async queue(search: string | undefined) {
    const balances = await packingBalance(prisma);
    const lotIds = [...new Set(balances.map((row) => row.lot_id))];

    const lots = lotIds.length
      ? await prisma.productionLot.findMany({
          where: {
            id: { in: lotIds },
            ...(search ? { searchText: { contains: search.toLowerCase() } } : {}),
          },
          select: { id: true, lotNumber: true, articleName: true, articleCode: true, productionDate: true },
          orderBy: [{ productionDate: "desc" }, { lotNumber: "asc" }],
        })
      : [];

    const rows = lots
      .map((lot) => {
        const sizes = balances
          .filter((row) => row.lot_id === lot.id)
          .sort(bySizeOrder)
          .map((row) => ({ size: row.size, good: row.good, packed: row.packed, waiting: row.good - row.packed }));

        return {
          lot: { id: lot.id, lotNumber: lot.lotNumber, articleName: lot.articleName, articleCode: lot.articleCode },
          sizes,
          good: sizes.reduce((sum, size) => sum + size.good, 0),
          packed: sizes.reduce((sum, size) => sum + size.packed, 0),
          waiting: sizes.reduce((sum, size) => sum + size.waiting, 0),
        };
      })
      .filter((row) => row.waiting > 0);

    return {
      lots: rows,
      totals: {
        good: rows.reduce((sum, row) => sum + row.good, 0),
        packed: rows.reduce((sum, row) => sum + row.packed, 0),
        waiting: rows.reduce((sum, row) => sum + row.waiting, 0),
      },
    };
  },

  async summary(showMoney: boolean) {
    const today = factoryToday();

    const [balances, [packed]] = await Promise.all([
      packingBalance(prisma),
      prisma.$queryRaw<
        {
          today: number;
          month: number;
          total: number;
          entries_today: number;
          packers_today: number;
          earning_month: string;
        }[]
      >`
        SELECT COALESCE(sum(pieces) FILTER (WHERE pack_date = ${today}::date), 0)::int AS today,
               COALESCE(sum(pieces) FILTER (WHERE pack_date >= date_trunc('month', ${today}::date)), 0)::int AS month,
               COALESCE(sum(pieces), 0)::int AS total,
               count(*) FILTER (WHERE pack_date = ${today}::date)::int AS entries_today,
               count(DISTINCT COALESCE(team_id, packer_id)) FILTER (WHERE pack_date = ${today}::date)::int AS packers_today,
               COALESCE(sum(earning) FILTER (WHERE pack_date >= date_trunc('month', ${today}::date)), 0)::text AS earning_month
        FROM packing_entries WHERE status = 'POSTED'`,
    ]);

    return {
      waiting: balances.reduce((sum, row) => sum + Math.max(0, row.good - row.packed), 0),
      packedToday: packed!.today,
      packedThisMonth: packed!.month,
      packedTotal: packed!.total,
      entriesToday: packed!.entries_today,
      packersToday: packed!.packers_today,
      earningThisMonth: showMoney ? Number(packed!.earning_month).toFixed(2) : null,
    };
  },

  async listEntries(query: EntryListQuery, showMoney: boolean) {
    const clauses = columnFilters(ENTRY_COLUMNS, query);

    if (query.search) {
      const pattern = contains(query.search);

      clauses.push(Prisma.sql`(l.search_text LIKE ${pattern} OR lower(COALESCE(e.team_name, e.packer_name)) LIKE ${pattern}
        OR e.number = ${numberOf(query.search)}::int)`);
    }

    if (query.lotId) clauses.push(Prisma.sql`e.lot_id = ${query.lotId}::uuid`);

    if (query.packerId) clauses.push(byPerson(query.packerId));

    if (query.teamId) clauses.push(Prisma.sql`e.team_id = ${query.teamId}::uuid`);

    const filter = where(clauses);
    const from = Prisma.sql`FROM packing_entries e JOIN production_lots l ON l.id = e.lot_id`;

    const [rows, [summary]] = await Promise.all([
      prisma.$queryRaw<
        {
          id: string;
          number: number;
          pack_date: string;
          status: string;
          lot_id: string;
          lot_number: string;
          article_name: string;
          packer_id: string | null;
          packer_name: string | null;
          team_id: string | null;
          team_name: string | null;
          pieces: number;
          rate: string;
          earning: string;
          sizes: string;
        }[]
      >`
        SELECT e.id, e.number, e.pack_date::text AS pack_date, e.status, l.id AS lot_id, l.lot_number, l.article_name,
               e.packer_id, e.packer_name, e.team_id, e.team_name, e.pieces, e.rate::text AS rate, e.earning::text AS earning,
               (SELECT string_agg(pl.size_label || ' ' || pl.quantity, ' · ' ORDER BY pl.position)
                FROM packing_lines pl WHERE pl.entry_id = e.id) AS sizes
        ${from} ${filter} ${orderBy(ENTRY_COLUMNS, query, "e.pack_date DESC", "e.number DESC")} ${page(query)}`,
      prisma.$queryRaw<{ total: number; posted: number; pieces: number; earning: string }[]>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE e.status = 'POSTED')::int AS posted,
               COALESCE(sum(e.pieces) FILTER (WHERE e.status = 'POSTED'), 0)::int AS pieces,
               COALESCE(sum(e.earning) FILTER (WHERE e.status = 'POSTED'), 0)::text AS earning
        ${from} ${filter}`,
    ]);

    return {
      entries: rows.map((row) => ({
        id: row.id,
        number: row.number,
        date: row.pack_date,
        status: row.status,
        lot: { id: row.lot_id, lotNumber: row.lot_number, articleName: row.article_name },
        packedBy: packedBy(row),
        pieces: row.pieces,
        sizes: row.sizes,
        rate: showMoney ? Number(row.rate).toFixed(2) : null,
        earning: showMoney ? Number(row.earning).toFixed(2) : null,
      })),
      total: summary!.total,
      summary: {
        entries: summary!.posted,
        pieces: summary!.pieces,
        earning: showMoney ? Number(summary!.earning).toFixed(2) : null,
      },
    };
  },

  /** Every packed size line: who packed which item, how many of which size, when. */
  async listLines(query: LineListQuery) {
    const clauses = [Prisma.sql`e.status = 'POSTED'`, ...columnFilters(LINE_COLUMNS, query)];

    if (query.search) {
      const pattern = contains(query.search);

      clauses.push(Prisma.sql`(l.search_text LIKE ${pattern} OR lower(COALESCE(e.team_name, e.packer_name)) LIKE ${pattern}
        OR lower(pl.size_label) = ${query.search.toLowerCase()})`);
    }

    if (query.lotId) clauses.push(Prisma.sql`e.lot_id = ${query.lotId}::uuid`);

    if (query.packerId) clauses.push(byPerson(query.packerId));

    if (query.teamId) clauses.push(Prisma.sql`e.team_id = ${query.teamId}::uuid`);

    const filter = where(clauses);
    const from = Prisma.sql`
      FROM packing_lines pl JOIN packing_entries e ON e.id = pl.entry_id JOIN production_lots l ON l.id = e.lot_id`;

    const [rows, [summary]] = await Promise.all([
      prisma.$queryRaw<
        {
          id: string;
          pack_date: string;
          number: number;
          entry_id: string;
          packer_id: string | null;
          packer_name: string | null;
          team_id: string | null;
          team_name: string | null;
          lot_id: string;
          lot_number: string;
          article_name: string;
          size_label: string;
          quantity: number;
        }[]
      >`
        SELECT pl.id, e.pack_date::text AS pack_date, e.number, e.id AS entry_id, e.packer_id, e.packer_name,
               e.team_id, e.team_name,
               l.id AS lot_id, l.lot_number, l.article_name, pl.size_label, pl.quantity
        ${from} ${filter} ${orderBy(LINE_COLUMNS, query, "e.pack_date DESC, e.number DESC", "pl.position")} ${page(query)}`,
      prisma.$queryRaw<{ total: number; pieces: number }[]>`
        SELECT count(*)::int AS total, COALESCE(sum(pl.quantity), 0)::int AS pieces ${from} ${filter}`,
    ]);

    return {
      lines: rows.map((row) => ({
        id: row.id,
        date: row.pack_date,
        entry: { id: row.entry_id, number: row.number },
        packedBy: packedBy(row),
        lot: { id: row.lot_id, lotNumber: row.lot_number },
        articleName: row.article_name,
        sizeLabel: row.size_label,
        quantity: row.quantity,
      })),
      total: summary!.total,
      pieces: summary!.pieces,
    };
  },

  /**
   * Per packing team (and, for entries from before teams, per person): entries, pieces,
   * items and pay in a date range (all time by default).
   */
  async staff(range: { dateFrom?: string | undefined; dateTo?: string | undefined }, showMoney: boolean) {
    const clauses = [Prisma.sql`e.status = 'POSTED'`];

    if (range.dateFrom) clauses.push(Prisma.sql`e.pack_date >= ${range.dateFrom}::date`);

    if (range.dateTo) clauses.push(Prisma.sql`e.pack_date <= ${range.dateTo}::date`);

    const rows = await prisma.$queryRaw<
      {
        id: string;
        kind: "TEAM" | "PERSON";
        code: string;
        name: string;
        members: string | null;
        entries: number;
        pieces: number;
        lots: number;
        items: string;
        first_date: string;
        last_date: string;
        earned: string;
      }[]
    >`
      SELECT COALESCE(e.team_id, e.packer_id) AS id,
             CASE WHEN e.team_id IS NULL THEN 'PERSON' ELSE 'TEAM' END AS kind,
             COALESCE(max(t.code), 'K-' || lpad(max(k.number)::text, 3, '0')) AS code,
             COALESCE(max(t.name), max(k.name)) AS name,
             (SELECT string_agg(kk.name, ', ' ORDER BY kk.name) FROM jogadi_members jm JOIN karigars kk ON kk.id = jm.karigar_id
              WHERE jm.team_id = e.team_id AND jm.left_at IS NULL) AS members,
             count(*)::int AS entries, sum(e.pieces)::int AS pieces,
             count(DISTINCT e.lot_id)::int AS lots,
             string_agg(DISTINCT l.article_name, ', ') AS items,
             min(e.pack_date)::text AS first_date, max(e.pack_date)::text AS last_date,
             sum(e.earning)::text AS earned
      FROM packing_entries e
      JOIN production_lots l ON l.id = e.lot_id
      LEFT JOIN jogadi_teams t ON t.id = e.team_id
      LEFT JOIN karigars k ON k.id = e.packer_id
      ${where(clauses)}
      GROUP BY e.team_id, e.packer_id ORDER BY sum(e.pieces) DESC, 4`;

    return {
      staff: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        code: row.code,
        name: row.name,
        members: row.members,
        entries: row.entries,
        pieces: row.pieces,
        lots: row.lots,
        items: row.items,
        firstDate: row.first_date,
        lastDate: row.last_date,
        earned: showMoney ? Number(row.earned).toFixed(2) : null,
      })),
    };
  },

  /**
   * The rate per piece last used to pack this lot's item (the same team's first), to prefill
   * the form. Null for people who may not see money.
   */
  async lastRate(query: { lotId: string; teamId?: string | undefined }, showMoney: boolean) {
    if (!showMoney) return null;

    const [row] = await prisma.$queryRaw<{ rate: string }[]>`
      SELECT e.rate::text AS rate FROM packing_entries e JOIN production_lots l ON l.id = e.lot_id
      WHERE e.status = 'POSTED' AND l.article_id = (SELECT article_id FROM production_lots WHERE id = ${query.lotId}::uuid)
      ORDER BY (e.team_id IS NOT DISTINCT FROM ${query.teamId ?? null}::uuid) DESC, e.created_at DESC LIMIT 1`;

    return row ? Number(row.rate).toFixed(2) : null;
  },

  async getEntry(id: string, showMoney: boolean) {
    const entry = await prisma.packingEntry.findUnique({
      where: { id },
      include: ENTRY_INCLUDE,
      relationLoadStrategy: "join",
    });

    if (!entry) throw errors.notFound("Packing entry");

    const members = entry.members.map((member) => ({ karigarId: member.karigarId, name: member.karigarName }));
    const shares = showMoney && members.length > 0 ? equalShares(entry.earning.toFixed(2), members) : null;

    return {
      id: entry.id,
      number: entry.number,
      status: entry.status,
      date: entry.packDate.toISOString().slice(0, 10),
      lot: { id: entry.lot.id, lotNumber: entry.lot.lotNumber, articleName: entry.lot.articleName },
      packedBy: packedBy({
        team_id: entry.teamId,
        team_name: entry.teamName,
        packer_id: entry.packerId,
        packer_name: entry.packerName,
      }),
      /** The team as it was when packed, each with their equal share of the pay (money only). */
      members: members.map((member) => ({ ...member, earning: shares?.get(member.karigarId) ?? null })),
      pieces: entry.pieces,
      rate: showMoney ? entry.rate.toFixed(2) : null,
      earning: showMoney ? entry.earning.toFixed(2) : null,
      notes: entry.notes,
      lines: entry.lines.map((line) => ({ sizeLabel: line.sizeLabel, quantity: line.quantity })),
      createdBy: entry.createdBy.name,
      createdAt: entry.createdAt,
      reversal: entry.reversedAt
        ? { at: entry.reversedAt, by: entry.reversedBy?.name ?? null, reason: entry.reversalReason }
        : null,
    };
  },

  async pack(actor: AuthContext, input: PackInput, meta: ClientMeta) {
    const id = await transaction(async (tx) => {
      const lot = await lockLot(tx, input.lotId);

      if (lot.status === "CANCELLED") throw fieldError("lotId", `${lot.lot_number} is cancelled.`);

      // Locks the team so its members cannot change while the earning is split over them.
      const [team] = await tx.$queryRaw<{ id: string; name: string; kind: string; active: boolean }[]>`
        SELECT id, name, kind, active FROM jogadi_teams WHERE id = ${input.teamId}::uuid FOR SHARE`;

      if (!team || team.kind !== "PACKING" || !team.active) {
        throw fieldError("teamId", "Choose an active packing team.");
      }

      // By name, as the entry shows them: the leftover paisa of an equal split goes in this order.
      const members = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT k.id, k.name FROM jogadi_members m JOIN karigars k ON k.id = m.karigar_id
        WHERE m.team_id = ${team.id}::uuid AND m.left_at IS NULL ORDER BY k.name, k.number`;

      if (members.length === 0) {
        throw fieldError("teamId", `${team.name} has no members. Add them in Teams.`);
      }

      const balances = await packingBalance(tx, lot.id);
      const waitingOf = new Map(balances.map((row) => [row.size, row.good - row.packed]));

      input.lines.forEach((line, index) => {
        const waiting = waitingOf.get(line.sizeLabel) ?? 0;

        if (line.quantity > waiting) {
          throw fieldError(
            `lines.${index}.quantity`,
            waiting <= 0
              ? `No ${line.sizeLabel} pieces of ${lot.lot_number} are waiting to be packed.`
              : `Only ${pcs(waiting)} of ${line.sizeLabel} are waiting to be packed.`,
          );
        }
      });

      const position = new Map(balances.map((row) => [row.size, row.position]));
      const lines = [...input.lines].sort(
        (a, b) => (position.get(a.sizeLabel) ?? 999) - (position.get(b.sizeLabel) ?? 999),
      );
      const pieces = lines.reduce((sum, line) => sum + line.quantity, 0);
      const earning = BigInt(pieces) * toPaisa(input.rate);
      const split = splitEarning(
        earning,
        "EQUAL",
        members.map((member) => ({ karigarId: member.id })),
      );

      // SAFETY: an equal split over at least one member always succeeds.
      if (!split.ok) throw errors.conflict(split.message);

      const date = new Date(input.packDate);

      const entry = await tx.packingEntry.create({
        data: {
          lotId: lot.id,
          teamId: team.id,
          teamName: team.name,
          packDate: date,
          pieces,
          rate: input.rate,
          earning: paisaText(earning),
          notes: input.notes,
          createdById: actor.user.id,
          lines: {
            createMany: {
              data: lines.map((line, index) => ({
                sizeLabel: line.sizeLabel,
                position: index,
                quantity: line.quantity,
              })),
            },
          },
          members: {
            createMany: { data: members.map((member) => ({ karigarId: member.id, karigarName: member.name })) },
          },
        },
        select: { id: true, number: true },
      });

      const description = `Packing ${packingNumber(entry.number)} · ${lot.lot_number} · ${pcs(pieces)} · ${team.name}`;
      const paid = members.filter((member) => split.amounts.get(member.id)! > 0n);

      if (paid.length > 0) {
        await tx.karigarLedgerEntry.createMany({
          data: paid.map((member) => ({
            karigarId: member.id,
            entryDate: date,
            type: "EARNING",
            payMode: "PER_PIECE",
            quantity: pieces,
            rate: input.rate,
            amount: paisaText(split.amounts.get(member.id)!),
            sourceType: "PACKING",
            sourceId: entry.id,
            description,
            createdById: actor.user.id,
          })),
        });
      }

      if (earning > 0n) {
        await tx.lotCost.create({
          data: {
            lotId: lot.id,
            sourceId: entry.id,
            kind: "PACKING_LABOUR",
            entryDate: date,
            quantity: pieces,
            rate: input.rate,
            amount: paisaText(earning),
            createdById: actor.user.id,
          },
        });
      }

      await tx.godownMovement.createMany({
        data: lines.map((line) => ({
          articleId: lot.article_id,
          sizeLabel: line.sizeLabel,
          movementDate: date,
          type: "PACKED_IN",
          qtyIn: line.quantity,
          lotId: lot.id,
          packingEntryId: entry.id,
          createdById: actor.user.id,
        })),
      });

      await recordAudit(tx, {
        type: "PACKING_POSTED",
        ...audit(actor, meta),
        metadata: { entryId: entry.id, lotId: lot.id, teamId: team.id, members: members.length, pieces },
      });

      return entry.id;
    });

    return this.getEntry(id, actor.user.permissions.has("costing.view"));
  },

  /** Undoes a packing entry whose pieces are still in the godown: every member's pay is reversed. */
  async reverse(actor: AuthContext, id: string, reason: string, meta: ClientMeta) {
    const found = await prisma.packingEntry.findUnique({ where: { id }, select: { lotId: true } });

    if (!found) throw errors.notFound("Packing entry");

    await transaction(async (tx) => {
      const lot = await lockLot(tx, found.lotId);
      const [entry] = await tx.$queryRaw<{ number: number; status: string }[]>`
        SELECT number, status FROM packing_entries WHERE id = ${id}::uuid FOR UPDATE`;

      if (!entry) throw errors.notFound("Packing entry");

      if (entry.status === "REVERSED")
        throw errors.conflict(`${packingNumber(entry.number)} has already been reversed.`);

      const lines = await tx.packingLine.findMany({ where: { entryId: id }, orderBy: { position: "asc" } });

      const stock = await tx.$queryRaw<{ size_label: string; balance: number }[]>`
        SELECT size_label, balance FROM godown_stock
        WHERE article_id = ${lot.article_id}::uuid AND size_label IN (${Prisma.join(lines.map((line) => line.sizeLabel))})
        FOR UPDATE`;

      for (const line of lines) {
        const balance = stock.find((row) => row.size_label === line.sizeLabel)?.balance ?? 0;

        if (balance < line.quantity) {
          throw errors.conflict(
            `Only ${pcs(balance)} of ${lot.article_name} ${line.sizeLabel} are left in the godown; the rest has gone out. Reverse the dispatch first.`,
          );
        }
      }

      const date = new Date(factoryToday());

      await tx.godownMovement.createMany({
        data: lines.map((line) => ({
          articleId: lot.article_id,
          sizeLabel: line.sizeLabel,
          movementDate: date,
          type: "PACKING_REVERSAL",
          qtyOut: line.quantity,
          lotId: lot.id,
          packingEntryId: id,
          reason,
          createdById: actor.user.id,
        })),
      });

      const [earnings, costs] = await Promise.all([
        tx.karigarLedgerEntry.findMany({ where: { sourceType: "PACKING", sourceId: id, type: "EARNING" } }),
        tx.lotCost.findMany({ where: { sourceId: id, kind: "PACKING_LABOUR", reversalOfId: null } }),
      ]);

      if (earnings.length > 0) {
        await tx.karigarLedgerEntry.createMany({
          data: earnings.map((earning) => ({
            karigarId: earning.karigarId,
            entryDate: date,
            type: "EARNING_REVERSAL",
            payMode: earning.payMode,
            quantity: earning.quantity.negated(),
            rate: earning.rate,
            amount: earning.amount.negated(),
            sourceType: "PACKING",
            sourceId: id,
            description: `${earning.description} · reversed: ${reason}`.slice(0, 500),
            createdById: actor.user.id,
          })),
        });
      }

      if (costs.length > 0) {
        await tx.lotCost.createMany({
          data: costs.map((cost) => ({
            lotId: cost.lotId,
            sourceId: id,
            kind: cost.kind,
            entryDate: date,
            quantity: cost.quantity.negated(),
            rate: cost.rate,
            amount: cost.amount.negated(),
            reversalOfId: cost.id,
            createdById: actor.user.id,
          })),
        });
      }

      await tx.packingEntry.update({
        where: { id },
        data: { status: "REVERSED", reversedAt: new Date(), reversedById: actor.user.id, reversalReason: reason },
      });
      await recordAudit(tx, { type: "PACKING_REVERSED", ...audit(actor, meta), metadata: { entryId: id, reason } });
    });

    return this.getEntry(id, actor.user.permissions.has("costing.view"));
  },
};

/** Each member's equal share of an entry's pay, as posted (same split as at packing). */
function equalShares(earning: string, members: { karigarId: string }[]): Map<string, string> {
  const split = splitEarning(toPaisa(earning), "EQUAL", members);

  return new Map(split.ok ? [...split.amounts].map(([id, paisa]) => [id, paisaText(paisa)]) : []);
}
