import { randomUUID } from "node:crypto";

import { prisma, Prisma, type Db } from "../../db/prisma";
import { AppError, ErrorCode } from "../../lib/errors";
import { columnFilters, contains, orderBy, page, where } from "../../lib/list-query";
import { parseScaled, type ColourInput, type MarkerInput } from "./cutting.calc";
import { BATCH_COLUMNS, LOT_COLUMNS, type BatchListQuery, type CuttingDraft, type LotListQuery } from "./cutting.schema";

// Reads of one batch or lot go through Prisma Client; paged lists with column
// filters are typed raw SQL like the fabric lists. Weights leave the database as
// exact decimal strings, never floats.

type Decimal = Prisma.Decimal;

export const cutNumber = (number: number) => `CUT-${String(number).padStart(4, "0")}`;

/** Exact decimal text of a NUMERIC, or null. */
export function dec(value: Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed();
}

export function fieldError(path: string, message: string): AppError {
  return new AppError(400, ErrorCode.VALIDATION_ERROR, message, { [path]: [message] });
}

const BATCH_INCLUDE = {
  lot: { include: { fabric: { select: { id: true, code: true, name: true, unit: true } } } },
  cuttingMaster: { select: { id: true, name: true, payMode: true, payRate: true, active: true } },
  sizes: { orderBy: { position: "asc" } },
  colours: {
    orderBy: { position: "asc" },
    include: { rolls: { orderBy: { position: "asc" } } },
  },
  outputs: { orderBy: [{ colourName: "asc" }, { position: "asc" }] },
  createdBy: { select: { name: true } },
  finalizedBy: { select: { name: true } },
  reversedBy: { select: { name: true } },
} satisfies Prisma.CuttingBatchInclude;

export type BatchRecord = Prisma.CuttingBatchGetPayload<{ include: typeof BATCH_INCLUDE }>;

// One joined query: the database is a long round trip away, so a batch never loads relation by relation.
export async function loadBatch(db: Db, id: string): Promise<BatchRecord | null> {
  return db.cuttingBatch.findUnique({ where: { id }, include: BATCH_INCLUDE, relationLoadStrategy: "join" });
}

/** Calculation inputs from a stored batch, in stored colour and roll order. */
export interface CalcInputs {
  marker: MarkerInput;
  colours: ColourInput[];
}

export function calcInputsOf(batch: BatchRecord): CalcInputs {
  return {
    marker: {
      widthM: dec(batch.widthM),
      lengthM: dec(batch.lengthM),
      gsm: dec(batch.gsm),
      measuredPalaKg: dec(batch.measuredPalaKg),
      // SAFETY: the column's CHECK constraint allows only these two values.
      weightSource: batch.weightSource as MarkerInput["weightSource"],
      repetitionsPerLayer: batch.repetitionsPerLayer,
      sizes: batch.sizes.map((size) => ({
        label: size.label,
        piecesPerPala: size.piecesPerPala,
        pieceWeightG: dec(size.pieceWeightG),
      })),
    },
    colours: batch.colours.map((colour) => ({
      name: colour.name,
      rolls: colour.rolls.map((roll) => ({
        thaan: roll.thaan,
        issuedKg: roll.issuedKg.toFixed(),
        returnedKg: roll.returnedKg.toFixed(),
        confirmedLayers: roll.confirmedLayers,
      })),
    })),
  };
}

/** Calculation inputs from a submitted draft. */
export function draftInputsOf(draft: CuttingDraft): CalcInputs {
  return {
    marker: { ...draft.marker, sizes: draft.sizes },
    colours: draft.colours.map((colour) => ({
      name: colour.name,
      rolls: colour.rolls.map((roll) => ({
        thaan: roll.thaan,
        issuedKg: roll.issuedKg,
        returnedKg: roll.returnedKg,
        confirmedLayers: roll.confirmedLayers,
      })),
    })),
  };
}

const sameKg = (a: string, b: string) => parseScaled(a, 6) === parseScaled(b, 6);

/**
 * Writes a draft over a batch. Issued Thaan are already out of the store, so they
 * must stay, under the same colour, number and weight; only their return and
 * confirmed layers can change. Everything not yet issued is rewritten.
 */
export async function writeDraft(tx: Prisma.TransactionClient, batch: BatchRecord | null, batchId: string, draft: CuttingDraft) {
  const colours = batch?.colours ?? [];
  const existingRolls = new Map(colours.flatMap((colour) => colour.rolls.map((roll) => [roll.id, roll] as const)));
  const existingColours = new Map(colours.map((colour) => [colour.id, colour] as const));
  const keptColours = new Set(colours.filter((colour) => colour.rolls.some((roll) => roll.status !== "DRAFT")).map((c) => c.id));
  const seenRolls = new Set<string>();

  draft.colours.forEach((colour, colourIndex) => {
    const path = `colours.${colourIndex}`;
    const existing = colour.id ? existingColours.get(colour.id) : undefined;

    if (colour.id && !existing) throw fieldError(`${path}.name`, "This colour is no longer part of the batch. Reload and try again.");

    if (existing && keptColours.has(existing.id) && existing.name !== colour.name) {
      throw fieldError(`${path}.name`, `Fabric has been issued for ${existing.name}, so it cannot be renamed.`);
    }

    colour.rolls.forEach((roll, rollIndex) => {
      const rollPath = `${path}.rolls.${rollIndex}`;
      const stored = roll.id ? existingRolls.get(roll.id) : undefined;

      if (roll.id && !stored) throw fieldError(`${rollPath}.thaan`, "This Thaan is no longer part of the batch. Reload and try again.");

      if (!stored) return;

      seenRolls.add(stored.id);

      if (stored.status === "DRAFT") return;

      if (stored.colourId !== colour.id || stored.thaan !== roll.thaan || !sameKg(stored.issuedKg.toFixed(), roll.issuedKg)) {
        throw fieldError(
          `${rollPath}.issuedKg`,
          `Thaan ${stored.thaan} has been issued (${stored.issuedKg.toFixed()} kg); its colour, number and weight are fixed. Record a return instead.`,
        );
      }
    });
  });

  for (const roll of existingRolls.values()) {
    if (roll.status !== "DRAFT" && !seenRolls.has(roll.id)) {
      throw fieldError("colours", `Thaan ${roll.thaan} has been issued and cannot be removed. Record it as returned instead.`);
    }
  }

  // Rewrite everything that is still a draft. Deleting first keeps the
  // per-batch unique names free for the rewritten rows.
  if (batch) {
    await tx.cuttingSize.deleteMany({ where: { batchId } });
    await tx.cuttingRoll.deleteMany({ where: { batchId, status: "DRAFT" } });
    await tx.cuttingColour.deleteMany({ where: { batchId, id: { notIn: [...keptColours] } } });
  }

  await tx.cuttingSize.createMany({
    data: draft.sizes.map((size, position) => ({
      batchId,
      position,
      label: size.label,
      piecesPerPala: size.piecesPerPala,
      pieceWeightG: size.pieceWeightG,
    })),
  });

  // Bulk writes so a save costs the same few round trips however many colours and Thaan it has.
  const entries = draft.colours.map((colour, position) => ({
    colour,
    position,
    id: colour.id && keptColours.has(colour.id) ? colour.id : (colour.id ?? randomUUID()),
    kept: Boolean(colour.id && keptColours.has(colour.id)),
  }));

  const created = entries.filter((entry) => !entry.kept);

  if (created.length > 0) {
    await tx.cuttingColour.createMany({
      data: created.map(({ colour, position, id }) => ({ id, batchId, position, name: colour.name })),
    });
  }

  const positions = entries.flatMap(({ kept, id, position }) => (kept ? [Prisma.sql`(${id}::uuid, ${position}::int)`] : []));

  if (positions.length > 0) {
    await tx.$executeRaw`
      UPDATE cutting_colours c SET position = v.position
      FROM (VALUES ${Prisma.join(positions)}) AS v (id, position) WHERE c.id = v.id`;
  }

  const rolls = entries.flatMap(({ colour, id: colourId }) =>
    colour.rolls.map((roll, position) => ({ roll, position, colourId, stored: roll.id ? existingRolls.get(roll.id) : undefined })),
  );

  const issued = rolls.flatMap(({ roll, position, stored }) =>
    stored && stored.status !== "DRAFT"
      ? [Prisma.sql`(${stored.id}::uuid, ${position}::int, ${roll.returnedKg}::numeric, ${roll.confirmedLayers}::int)`]
      : [],
  );

  if (issued.length > 0) {
    // Issued Thaan keep colour, number and weight; only the return and layers change.
    await tx.$executeRaw`
      UPDATE cutting_rolls r SET position = v.position, returned_kg = v.returned, confirmed_layers = v.layers
      FROM (VALUES ${Prisma.join(issued)}) AS v (id, position, returned, layers) WHERE r.id = v.id`;
  }

  const fresh = rolls.filter(({ stored }) => !stored || stored.status === "DRAFT");

  if (fresh.length > 0) {
    await tx.cuttingRoll.createMany({
      data: fresh.map(({ roll, position, colourId }) => ({
        id: roll.id ?? randomUUID(),
        batchId,
        colourId,
        position,
        thaan: roll.thaan,
        issuedKg: roll.issuedKg,
        returnedKg: roll.returnedKg,
        confirmedLayers: roll.confirmedLayers,
      })),
    });
  }
}

/** Kilograms held by cutting (issued, not yet consumed, wasted or returned), per filter. */
export const IN_CUTTING_KG = Prisma.raw(`
  COALESCE(sum(CASE WHEN m.to_state = 'CUTTING' THEN m.quantity WHEN m.from_state = 'CUTTING' THEN -m.quantity ELSE 0 END), 0)`);

interface LotRow {
  id: string;
  lot_number: string;
  production_date: string;
  status: string;
  article_code: string;
  article_name: string;
  fabric_id: string;
  fabric_code: string;
  fabric_name: string;
  target_quantity: number | null;
  cut: number;
  batches: number;
  open_batches: number;
}

export interface LotListItem {
  id: string;
  lotNumber: string;
  productionDate: string;
  status: string;
  article: { code: string; name: string };
  fabric: { id: string; code: string; name: string };
  targetQuantity: number | null;
  cutPieces: number;
  batches: number;
  openBatches: number;
}

const LOT_FROM = Prisma.raw(`
  FROM production_lots l
  JOIN fabrics f ON f.id = l.fabric_id
  LEFT JOIN (
    SELECT o.lot_id, sum(o.accepted_quantity) AS accepted
    FROM cutting_outputs o JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED'
    GROUP BY o.lot_id
  ) o ON o.lot_id = l.id
  LEFT JOIN (
    SELECT lot_id, count(*) AS batches, count(*) FILTER (WHERE status IN ('DRAFT', 'ISSUED')) AS open_batches
    FROM cutting_batches GROUP BY lot_id
  ) b ON b.lot_id = l.id`);

export async function listLots(query: LotListQuery): Promise<{ lots: LotListItem[]; total: number }> {
  const clauses = columnFilters(LOT_COLUMNS, query);

  if (query.search) clauses.push(Prisma.sql`l.search_text LIKE ${contains(query.search)}`);

  const filter = where(clauses);
  const order = orderBy(LOT_COLUMNS, query, "l.production_date DESC, l.created_at DESC", "l.id");

  const [rows, [count]] = await Promise.all([
    prisma.$queryRaw<LotRow[]>`
      SELECT l.id, l.lot_number, l.production_date::text AS production_date, l.status, l.article_code, l.article_name,
             f.id AS fabric_id, f.code AS fabric_code, f.name AS fabric_name, l.target_quantity,
             COALESCE(o.accepted, 0)::int AS cut, COALESCE(b.batches, 0)::int AS batches,
             COALESCE(b.open_batches, 0)::int AS open_batches
      ${LOT_FROM} ${filter} ${order} ${page(query)}`,
    prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${LOT_FROM} ${filter}`,
  ]);

  return {
    lots: rows.map((row) => ({
      id: row.id,
      lotNumber: row.lot_number,
      productionDate: row.production_date,
      status: row.status,
      article: { code: row.article_code, name: row.article_name },
      fabric: { id: row.fabric_id, code: row.fabric_code, name: row.fabric_name },
      targetQuantity: row.target_quantity,
      cutPieces: row.cut,
      batches: row.batches,
      openBatches: row.open_batches,
    })),
    total: count!.total,
  };
}

export interface ProductionSummary {
  lots: Record<string, number>;
  piecesThisMonth: number;
  wastageKgThisMonth: string;
  consumedKgThisMonth: string;
  inCuttingKg: string;
  openBatches: number;
}

export async function productionSummary(): Promise<ProductionSummary> {
  const [statuses, [month], [held], [open]] = await Promise.all([
    prisma.$queryRaw<{ status: string; count: number }[]>`
      SELECT status, count(*)::int AS count FROM production_lots GROUP BY status`,
    prisma.$queryRaw<{ pieces: number; wastage: string; consumed: string }[]>`
      SELECT COALESCE(sum(total_accepted_pieces), 0)::int AS pieces, COALESCE(sum(total_wastage_kg), 0)::text AS wastage,
             COALESCE(sum(total_consumed_kg), 0)::text AS consumed
      FROM cutting_batches
      WHERE status = 'FINALIZED' AND cutting_date >= date_trunc('month', current_date)`,
    prisma.$queryRaw<{ held: string }[]>`SELECT ${IN_CUTTING_KG}::text AS held FROM cutting_movements m`,
    prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM cutting_batches WHERE status IN ('DRAFT', 'ISSUED')`,
  ]);

  return {
    lots: Object.fromEntries(statuses.map((row) => [row.status, row.count])),
    piecesThisMonth: month!.pieces,
    wastageKgThisMonth: month!.wastage,
    consumedKgThisMonth: month!.consumed,
    inCuttingKg: held!.held,
    openBatches: open!.count,
  };
}

interface BatchRow {
  id: string;
  number: number;
  cutting_date: string;
  status: string;
  lot_id: string;
  lot_number: string;
  article_name: string;
  fabric_name: string;
  master: string | null;
  pala: number | null;
  pieces: number | null;
  issued: string;
  wastage: string | null;
}

export interface BatchListItem {
  id: string;
  number: number;
  cuttingDate: string;
  status: string;
  lot: { id: string; lotNumber: string; articleName: string; fabricName: string };
  cuttingMaster: string | null;
  pala: number | null;
  acceptedPieces: number | null;
  issuedKg: string;
  wastageKg: string | null;
}

const BATCH_FROM = Prisma.raw(`
  FROM cutting_batches b
  JOIN production_lots l ON l.id = b.lot_id
  JOIN fabrics f ON f.id = l.fabric_id
  LEFT JOIN karigars k ON k.id = b.cutting_master_id
  LEFT JOIN (SELECT batch_id, sum(issued_kg) AS issued FROM cutting_rolls WHERE status <> 'DRAFT' GROUP BY batch_id) r
    ON r.batch_id = b.id`);

export async function listBatches(query: BatchListQuery): Promise<{ batches: BatchListItem[]; total: number }> {
  const clauses = columnFilters(BATCH_COLUMNS, query);

  if (query.search) {
    const pattern = contains(query.search);
    const number = /^(?:cut-?)?0*(\d{1,9})$/i.exec(query.search.trim());

    clauses.push(
      Prisma.sql`(l.search_text LIKE ${pattern} OR lower(COALESCE(k.name, '')) LIKE ${pattern}
        OR b.number = ${number ? Number(number[1]) : null}::int)`,
    );
  }

  if (query.lotId) clauses.push(Prisma.sql`b.lot_id = ${query.lotId}::uuid`);

  const filter = where(clauses);
  const order = orderBy(BATCH_COLUMNS, query, "b.cutting_date DESC", "b.number DESC");

  const [rows, [count]] = await Promise.all([
    prisma.$queryRaw<BatchRow[]>`
      SELECT b.id, b.number, b.cutting_date::text AS cutting_date, b.status, l.id AS lot_id, l.lot_number,
             l.article_name, f.name AS fabric_name, k.name AS master, b.total_pala AS pala,
             b.total_accepted_pieces AS pieces, COALESCE(b.total_issued_kg, r.issued, 0)::text AS issued,
             b.total_wastage_kg::text AS wastage
      ${BATCH_FROM} ${filter} ${order} ${page(query)}`,
    prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${BATCH_FROM} ${filter}`,
  ]);

  return {
    batches: rows.map((row) => ({
      id: row.id,
      number: row.number,
      cuttingDate: row.cutting_date,
      status: row.status,
      lot: { id: row.lot_id, lotNumber: row.lot_number, articleName: row.article_name, fabricName: row.fabric_name },
      cuttingMaster: row.master,
      pala: row.pala,
      acceptedPieces: row.pieces,
      issuedKg: row.issued,
      wastageKg: row.wastage,
    })),
    total: count!.total,
  };
}
