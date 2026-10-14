import { prisma, Prisma, transaction } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { articleService } from "../articles/article.service";
import { recordAudit } from "../audit/audit.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import {
  CALCULATION_VERSION,
  calculateBatch,
  costOf,
  cuttingEarning,
  formatKg,
  parseScaled,
  toDecimal,
  WASTAGE_TYPE,
  type BatchResult,
  type Issue,
  type MarkerResult,
  type PayMode,
  type RollResult,
  type Totals,
} from "./cutting.calc";
import {
  calcInputsOf,
  cutNumber,
  dec,
  draftInputsOf,
  fieldError,
  IN_CUTTING_KG,
  listBatches,
  listLots,
  loadBatch,
  productionSummary,
  writeDraft,
  type BatchRecord,
} from "./cutting.repository";
import type { CreateLotInput, CuttingDraft, LotListQuery, UpdateLotInput } from "./cutting.schema";

type Tx = Prisma.TransactionClient;

interface LockedLot {
  id: string;
  lot_number: string;
  status: string;
  fabric_id: string;
  article_id: string;
  target_quantity: number | null;
}

const kg = (micro: bigint) => toDecimal(micro, 6);

function audit(actor: AuthContext, meta: ClientMeta) {
  return { actorUserId: actor.user.id, sessionId: actor.sessionId, meta };
}

/** Calculation issues as a 400 whose details map each field path to its messages. */
function validationError(issues: Issue[]): AppError {
  const details: Record<string, string[]> = {};

  for (const issue of issues) (details[issue.path] ??= []).push(issue.message);

  return new AppError(400, ErrorCode.VALIDATION_ERROR, issues[0]!.message, details);
}

// Lock order everywhere: lot, then batch, then fabric. Writes to one lot are serialized.
async function lockLot(tx: Tx, lotId: string): Promise<LockedLot> {
  const [lot] = await tx.$queryRaw<LockedLot[]>`
    SELECT id, lot_number, status, fabric_id, article_id, target_quantity
    FROM production_lots WHERE id = ${lotId}::uuid FOR UPDATE`;

  if (!lot) throw errors.notFound("Production lot");

  return lot;
}

function assertLotOpen(lot: LockedLot): void {
  if (lot.status === "COMPLETED") throw errors.conflict(`${lot.lot_number} is completed. Reopen it to change its cutting.`);

  if (lot.status === "CANCELLED") throw errors.conflict(`${lot.lot_number} is cancelled.`);
}

/** Locks a batch and its lot in one statement, then loads the batch in one more. */
async function lockBatch(tx: Tx, batchId: string): Promise<{ lot: LockedLot; batch: BatchRecord }> {
  const [lot] = await tx.$queryRaw<LockedLot[]>`
    SELECT l.id, l.lot_number, l.status, l.fabric_id, l.article_id, l.target_quantity
    FROM cutting_batches b JOIN production_lots l ON l.id = b.lot_id
    WHERE b.id = ${batchId}::uuid
    FOR UPDATE OF l, b`;

  if (!lot) throw errors.notFound("Cutting batch");

  return { lot, batch: (await loadBatch(tx, batchId))! };
}

/**
 * Store stock of the lot's fabric, locked so concurrent issues cannot both take the
 * last kilograms. The stock row is locked too: a waiting reader then re-reads its
 * latest balance instead of the one from before the other issue committed.
 */
async function lockFabric(tx: Tx, fabricId: string) {
  const [fabric] = await tx.$queryRaw<{ name: string; unit: string; balance: string; rate: string | null }[]>`
    SELECT f.name, f.unit, s.balance::text AS balance,
           round(s.purchased_amount / nullif(s.purchased_qty, 0), 4)::text AS rate
    FROM fabrics f JOIN fabric_stock s ON s.fabric_id = f.id
    WHERE f.id = ${fabricId}::uuid FOR UPDATE OF f, s`;

  if (!fabric) throw fieldError("fabricId", "Choose a fabric.");

  return { ...fabric, balance: parseScaled(fabric.balance, 6)! };
}

async function assertMaster(tx: Tx, masterId: string | null, required: boolean): Promise<void> {
  if (!masterId) {
    if (required) throw fieldError("cuttingMasterId", "Choose the cutting master.");

    return;
  }

  const master = await tx.karigar.findUnique({ where: { id: masterId }, select: { active: true } });

  if (!master?.active) throw fieldError("cuttingMasterId", "Choose an active cutting master.");
}

function assertKg(unit: string): void {
  if (unit !== "KG") throw fieldError("fabricId", "Cutting is weighed in kg. Choose a fabric measured in kg.");
}

/** Batch columns from a draft, including the Pala weights it resolves to. */
function batchFields(draft: CuttingDraft) {
  const { marker } = calculateBatch({ ...draft.marker, sizes: draft.sizes }, []);

  return {
    cuttingMasterId: draft.cuttingMasterId,
    cuttingDate: new Date(draft.cuttingDate),
    notes: draft.notes,
    widthM: draft.marker.widthM,
    lengthM: draft.marker.lengthM,
    gsm: draft.marker.gsm,
    measuredPalaKg: draft.marker.measuredPalaKg,
    weightSource: draft.marker.weightSource,
    repetitionsPerLayer: draft.marker.repetitionsPerLayer,
    calculatedPalaKg: marker.calculatedPalaKg === null ? null : kg(marker.calculatedPalaKg),
    activePalaKg: marker.activePalaKg === null ? null : kg(marker.activePalaKg),
  };
}

async function saveDefaultsIf(tx: Tx, draft: CuttingDraft, articleId: string): Promise<void> {
  if (draft.saveAsDefault) await articleService.saveDefaults(tx, articleId, { ...draft.marker, sizes: draft.sizes });
}

const today = () => new Date(new Date().toISOString().slice(0, 10));

/** Average rate per kg (4 decimals) of an amount spread over a quantity. */
function ratePerKg(paisa: bigint, micro: bigint): string {
  return micro === 0n ? "0" : toDecimal((paisa * 10n ** 8n * 2n + micro) / (micro * 2n), 4);
}

/**
 * Moves every not-yet-issued Thaan of a batch from the fabric store into cutting:
 * a CUTTING_ISSUE on the fabric ledger and an ISSUE on the cutting ledger, with the
 * fabric's average purchase rate snapshotted for costing. Returns how many were issued.
 */
async function issueRolls(
  tx: Tx,
  actor: AuthContext,
  lot: LockedLot,
  batch: BatchRecord,
): Promise<{ count: number; rate: string | null }> {
  const pending = batch.colours.flatMap((colour) =>
    colour.rolls.flatMap((roll) => (roll.status === "DRAFT" ? [{ roll, colour }] : [])),
  );

  if (pending.length === 0) return { count: 0, rate: null };

  const fabric = await lockFabric(tx, lot.fabric_id);

  assertKg(fabric.unit);

  const needed = pending.reduce((sum, { roll }) => sum + parseScaled(roll.issuedKg.toFixed(), 6)!, 0n);

  if (needed > fabric.balance) {
    throw fieldError(
      "colours",
      `Only ${formatKg(fabric.balance)} kg of ${fabric.name} is in the store; issuing these Thaan needs ${formatKg(needed)} kg.`,
    );
  }

  const reference = `${cutNumber(batch.number)} · ${lot.lot_number}`;

  // Bulk writes: three statements however many Thaan are issued.
  await tx.fabricMovement.createMany({
    data: pending.map(({ roll, colour }) => ({
      fabricId: lot.fabric_id,
      movementDate: batch.cuttingDate,
      type: "CUTTING_ISSUE",
      qtyOut: roll.issuedKg.toFixed(),
      reason: `Issued to cutting ${reference} · ${colour.name} · Thaan ${roll.thaan}`,
      cuttingBatchId: batch.id,
      createdById: actor.user.id,
    })),
  });
  await tx.cuttingMovement.createMany({
    data: pending.map(({ roll, colour }) => ({
      batchId: batch.id,
      lotId: lot.id,
      fabricId: lot.fabric_id,
      rollId: roll.id,
      colour: colour.name,
      thaan: roll.thaan,
      movementDate: batch.cuttingDate,
      type: "ISSUE",
      fromState: "STORE",
      toState: "CUTTING",
      quantity: roll.issuedKg.toFixed(),
      createdById: actor.user.id,
    })),
  });
  await tx.cuttingRoll.updateMany({
    where: { id: { in: pending.map(({ roll }) => roll.id) } },
    data: { status: "ISSUED", issuedAt: new Date(), fabricRate: fabric.rate },
  });

  await tx.cuttingBatch.update({ where: { id: batch.id }, data: { status: "ISSUED" } });

  if (lot.status === "DRAFT") await tx.productionLot.update({ where: { id: lot.id }, data: { status: "ACTIVE" } });

  return { count: pending.length, rate: fabric.rate };
}

function serializeTotals(totals: Totals) {
  return {
    issuedKg: kg(totals.issuedKg),
    returnedKg: kg(totals.returnedKg),
    consumedKg: kg(totals.consumedKg),
    wastageKg: kg(totals.wastageKg),
    estimatedPala: totals.estimatedPala,
    confirmedPala: totals.confirmedPala,
    plannedPieces: totals.plannedPieces,
    acceptedPieces: totals.acceptedPieces,
  };
}

function serializeRoll(roll: RollResult) {
  return {
    issuedKg: kg(roll.issuedKg),
    returnedKg: kg(roll.returnedKg),
    netKg: kg(roll.netKg),
    estimatedPala: roll.estimatedPala,
    estimatedLayers: roll.estimatedLayers,
    confirmedLayers: roll.confirmedLayers,
    confirmedPala: roll.confirmedPala,
    consumedKg: kg(roll.consumedKg),
    wastageKg: kg(roll.wastageKg),
    pieces: roll.pieces,
  };
}

function serializeMarker(marker: MarkerResult) {
  const optional = (value: bigint | null) => (value === null ? null : kg(value));

  return {
    calculatedPalaKg: optional(marker.calculatedPalaKg),
    measuredPalaKg: optional(marker.measuredPalaKg),
    activePalaKg: optional(marker.activePalaKg),
    differenceKg: optional(marker.differenceKg),
    piecesPerPala: marker.piecesPerPala,
    netPalaKg: optional(marker.netPalaKg),
    scrapPerPalaKg: optional(marker.scrapPerPalaKg),
  };
}

function serializeResult(result: BatchResult) {
  return {
    marker: serializeMarker(result.marker),
    colours: result.colours.map((colour) => ({
      name: colour.name,
      rolls: colour.rolls.map(serializeRoll),
      totals: serializeTotals(colour.totals),
      sizes: colour.sizes,
    })),
    totals: serializeTotals(result.totals),
    issues: result.issues,
    warnings: result.warnings,
  };
}

function toBatchDto(batch: BatchRecord, showCost: boolean) {
  const posted = batch.finalizedAt !== null;

  return {
    id: batch.id,
    number: batch.number,
    status: batch.status,
    cuttingDate: batch.cuttingDate.toISOString().slice(0, 10),
    notes: batch.notes,
    lot: {
      id: batch.lot.id,
      lotNumber: batch.lot.lotNumber,
      status: batch.lot.status,
      targetQuantity: batch.lot.targetQuantity,
      article: { id: batch.lot.articleId, code: batch.lot.articleCode, name: batch.lot.articleName },
      fabric: batch.lot.fabric,
    },
    cuttingMaster: batch.cuttingMaster
      ? { id: batch.cuttingMaster.id, name: batch.cuttingMaster.name, payMode: batch.cuttingMaster.payMode }
      : null,
    marker: {
      widthM: dec(batch.widthM),
      lengthM: dec(batch.lengthM),
      gsm: dec(batch.gsm),
      measuredPalaKg: dec(batch.measuredPalaKg),
      weightSource: batch.weightSource,
      repetitionsPerLayer: batch.repetitionsPerLayer,
      calculatedPalaKg: dec(batch.calculatedPalaKg),
      activePalaKg: dec(batch.activePalaKg),
    },
    sizes: batch.sizes.map((size) => ({
      label: size.label,
      piecesPerPala: size.piecesPerPala,
      pieceWeightG: dec(size.pieceWeightG),
    })),
    colours: batch.colours.map((colour) => ({
      id: colour.id,
      name: colour.name,
      rolls: colour.rolls.map((roll) => ({
        id: roll.id,
        thaan: roll.thaan,
        issuedKg: roll.issuedKg.toFixed(),
        returnedKg: roll.returnedKg.toFixed(),
        confirmedLayers: roll.confirmedLayers,
        status: roll.status,
        estimatedPala: roll.estimatedPala,
        confirmedPala: roll.confirmedPala,
        consumedKg: dec(roll.consumedKg),
        wastageKg: dec(roll.wastageKg),
      })),
      rejects: colour.rejects.map((reject) => ({
        sizeLabel: reject.sizeLabel,
        quantity: reject.quantity,
        reason: reject.reason,
      })),
    })),
    posted: posted
      ? {
          calculationVersion: batch.calculationVersion,
          issuedKg: dec(batch.totalIssuedKg),
          returnedKg: dec(batch.totalReturnedKg),
          consumedKg: dec(batch.totalConsumedKg),
          wastageKg: dec(batch.totalWastageKg),
          pala: batch.totalPala,
          plannedPieces: batch.totalPlannedPieces,
          acceptedPieces: batch.totalAcceptedPieces,
          finalizedAt: batch.finalizedAt,
          finalizedBy: batch.finalizedBy?.name ?? null,
        }
      : null,
    costs: posted && showCost ? { fabricCost: dec(batch.fabricCost), earningAmount: dec(batch.earningAmount) } : null,
    outputs: batch.outputs.map((output) => ({
      colourName: output.colourName,
      sizeLabel: output.sizeLabel,
      planned: output.plannedQuantity,
      rejected: output.rejectedQuantity,
      accepted: output.acceptedQuantity,
      available: output.availableForStitching,
      rejectReason: output.rejectReason,
    })),
    reversal: batch.reversedAt
      ? { at: batch.reversedAt, by: batch.reversedBy?.name ?? null, reason: batch.reversalReason }
      : null,
    createdBy: batch.createdBy.name,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

export type BatchDto = ReturnType<typeof toBatchDto>;

async function batchDto(id: string, showCost: boolean): Promise<BatchDto> {
  const batch = await loadBatch(prisma, id);

  if (!batch) throw errors.notFound("Cutting batch");

  return toBatchDto(batch, showCost);
}

/** Creates a draft batch under a lot and writes its marker, sizes, colours and Thaan. */
async function createBatch(
  tx: Tx,
  actor: AuthContext,
  lot: { id: string; article_id: string },
  draft: CuttingDraft,
  meta: ClientMeta,
): Promise<string> {
  await assertMaster(tx, draft.cuttingMasterId, false);

  const { id } = await tx.cuttingBatch.create({
    data: { lotId: lot.id, createdById: actor.user.id, ...batchFields(draft) },
    select: { id: true },
  });

  await writeDraft(tx, null, id, draft);
  await saveDefaultsIf(tx, draft, lot.article_id);
  await recordAudit(tx, { type: "CUTTING_DRAFT_SAVED", ...audit(actor, meta), metadata: { batchId: id, lotId: lot.id } });

  return id;
}

async function lotDetail(id: string, showCost: boolean) {
  const lot = await prisma.productionLot.findUnique({
    where: { id },
    include: {
      fabric: { select: { id: true, code: true, name: true, unit: true, stock: { select: { balance: true } } } },
      createdBy: { select: { name: true } },
    },
  });

  if (!lot) throw errors.notFound("Production lot");

  const [batches, outputs, [held], history, costs] = await Promise.all([
    listBatches({ lotId: id, page: 1, pageSize: 100, dir: "desc", sort: "number" }),
    prisma.$queryRaw<{ colour: string; size: string; planned: number; rejected: number; accepted: number; available: number }[]>`
      SELECT o.colour_name AS colour, o.size_label AS size, sum(o.planned_quantity)::int AS planned,
             sum(o.rejected_quantity)::int AS rejected, sum(o.accepted_quantity)::int AS accepted,
             sum(o.available_for_stitching)::int AS available
      FROM cutting_outputs o JOIN cutting_batches b ON b.id = o.batch_id AND b.status = 'FINALIZED'
      WHERE o.lot_id = ${id}::uuid
      GROUP BY o.colour_name, o.size_label
      ORDER BY min(b.number), o.colour_name, min(o.position)`,
    prisma.$queryRaw<{ held: string }[]>`SELECT ${IN_CUTTING_KG}::text AS held FROM cutting_movements m WHERE m.lot_id = ${id}::uuid`,
    prisma.cuttingMovement.findMany({
      where: { lotId: id },
      orderBy: { seq: "desc" },
      take: 500,
      include: { batch: { select: { number: true } }, createdBy: { select: { name: true } } },
    }),
    showCost
      ? prisma.lotCost.findMany({ where: { lotId: id }, orderBy: { seq: "asc" }, include: { batch: { select: { number: true } } } })
      : null,
  ]);

  const accepted = outputs.reduce((sum, row) => sum + row.accepted, 0);
  const costTotal = costs?.reduce((sum, cost) => sum.plus(cost.amount), new Prisma.Decimal(0));

  return {
    id: lot.id,
    lotNumber: lot.lotNumber,
    status: lot.status,
    productionDate: lot.productionDate.toISOString().slice(0, 10),
    targetQuantity: lot.targetQuantity,
    notes: lot.notes,
    article: { id: lot.articleId, code: lot.articleCode, name: lot.articleName },
    fabric: {
      id: lot.fabric.id,
      code: lot.fabric.code,
      name: lot.fabric.name,
      unit: lot.fabric.unit,
      balanceKg: lot.fabric.stock?.balance.toFixed() ?? "0",
    },
    createdBy: lot.createdBy.name,
    createdAt: lot.createdAt,
    batches: batches.batches,
    output: {
      rows: outputs,
      planned: outputs.reduce((sum, row) => sum + row.planned, 0),
      rejected: outputs.reduce((sum, row) => sum + row.rejected, 0),
      accepted,
      available: outputs.reduce((sum, row) => sum + row.available, 0),
    },
    inCuttingKg: held!.held,
    costs:
      costs && costTotal
        ? {
            entries: costs.map((cost) => ({
              id: cost.id,
              kind: cost.kind,
              batchNumber: cost.batch.number,
              date: cost.entryDate.toISOString().slice(0, 10),
              quantity: cost.quantity.toFixed(),
              rate: cost.rate.toFixed(),
              amount: cost.amount.toFixed(2),
              reversal: cost.reversalOfId !== null,
            })),
            total: costTotal.toFixed(2),
            // Provisional: cutting costs over accepted cut pieces, before stitching and packing.
            perPiece: accepted > 0 ? costTotal.dividedBy(accepted).toFixed(2) : null,
          }
        : null,
    history: history.map((movement) => ({
      id: movement.id,
      date: movement.movementDate.toISOString().slice(0, 10),
      type: movement.type,
      fromState: movement.fromState,
      toState: movement.toState,
      quantityKg: movement.quantity.toFixed(),
      colour: movement.colour,
      thaan: movement.thaan,
      batchId: movement.batchId,
      batchNumber: movement.batch.number,
      wastageType: movement.wastageType,
      reversal: movement.reversalOfId !== null,
      reason: movement.reason,
      by: movement.createdBy.name,
      at: movement.createdAt,
    })),
  };
}

export type LotDetailDto = Awaited<ReturnType<typeof lotDetail>>;

export const lotService = {
  async list(query: LotListQuery) {
    const [page, summary] = await Promise.all([listLots(query), productionSummary()]);

    return { ...page, summary };
  },

  get: lotDetail,

  /**
   * Cutting under an operator-typed lot number, in one transaction. An open lot with
   * that number (ignoring case and spaces) takes the new cutting, provided item and
   * fabric match; otherwise the lot is created with an inline or existing article.
   */
  async create(actor: AuthContext, input: CreateLotInput, meta: ClientMeta, showCost: boolean) {
    const { lotId, batchId } = await transaction(async (tx) => {
      // Two operators typing the same new lot number at once get one lot, not a unique-key error.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('production_lots.number'))`;

      const [existing] = await tx.$queryRaw<LockedLot[]>`
        SELECT id, lot_number, status, fabric_id, article_id, target_quantity
        FROM production_lots WHERE lot_key = lower(btrim(${input.lotNumber})) FOR UPDATE`;

      if (existing) {
        if (existing.status !== "DRAFT" && existing.status !== "ACTIVE") {
          throw fieldError("lotNumber", `${existing.lot_number} is ${existing.status.toLowerCase()}. Use another lot number.`);
        }

        if (existing.fabric_id !== input.fabricId) {
          throw fieldError("fabricId", `${existing.lot_number} is cut from another fabric.`);
        }

        const [same] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM articles
          WHERE id = ${existing.article_id}::uuid
            AND (id::text = ${"id" in input.article ? input.article.id : ""}
                 OR name_key = lower(regexp_replace(${"name" in input.article ? input.article.name : ""}, '[^[:alnum:]]+', '', 'g')))`;

        if (!same) throw fieldError("article", `${existing.lot_number} is for another item.`);

        if (input.targetQuantity !== null && input.targetQuantity !== existing.target_quantity) {
          await tx.productionLot.update({ where: { id: existing.id }, data: { targetQuantity: input.targetQuantity } });
        }

        const batchId = input.cutting ? await createBatch(tx, actor, existing, input.cutting, meta) : null;

        return { lotId: existing.id, batchId };
      }

      const fabric = await tx.fabric.findUnique({ where: { id: input.fabricId }, select: { unit: true } });

      if (!fabric) throw fieldError("fabricId", "Choose a fabric.");

      assertKg(fabric.unit);

      const article = await articleService.resolve(tx, actor, input.article, input.fabricId, meta);

      const lot = await tx.productionLot.create({
        data: {
          lotNumber: input.lotNumber,
          articleId: article.id,
          articleCode: article.code,
          articleName: article.name,
          fabricId: input.fabricId,
          productionDate: new Date(input.productionDate),
          targetQuantity: input.targetQuantity,
          notes: input.notes,
          createdById: actor.user.id,
        },
        select: { id: true },
      });

      await recordAudit(tx, {
        type: "LOT_CREATED",
        ...audit(actor, meta),
        metadata: { lotId: lot.id, lotNumber: input.lotNumber, articleId: article.id },
      });

      const batchId = input.cutting
        ? await createBatch(tx, actor, { id: lot.id, article_id: article.id }, input.cutting, meta)
        : null;

      return { lotId: lot.id, batchId };
    });

    return { lot: await lotDetail(lotId, showCost), batch: batchId ? await batchDto(batchId, showCost) : null };
  },

  async update(actor: AuthContext, id: string, input: UpdateLotInput, meta: ClientMeta, showCost: boolean) {
    await transaction(async (tx) => {
      const lot = await lockLot(tx, id);
      const batches = await tx.cuttingBatch.groupBy({ by: ["status"], where: { lotId: id }, _count: true });

      const count = (...statuses: string[]) =>
        batches.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count, 0);

      const data: Prisma.ProductionLotUncheckedUpdateInput = {};

      if (input.status === "CANCELLED") {
        assertLotOpen(lot);

        if (count("ISSUED", "FINALIZED") > 0) {
          throw errors.conflict(`${lot.lot_number} has fabric issued or cut. Reverse its cutting before cancelling.`);
        }
      } else if (input.status === "COMPLETED") {
        if (lot.status !== "ACTIVE") throw errors.conflict("Only an active lot can be completed.");

        if (count("DRAFT", "ISSUED") > 0) throw errors.conflict("Finalize or delete the open cutting batches first.");
      } else if (input.status === "ACTIVE") {
        if (lot.status !== "COMPLETED") throw errors.conflict("Only a completed lot can be reopened.");
      } else {
        assertLotOpen(lot);
      }

      if (input.status) data.status = input.status;

      if (input.fabricId !== undefined && input.fabricId !== lot.fabric_id) {
        if (count("ISSUED", "FINALIZED", "REVERSED") > 0) {
          throw fieldError("fabricId", "Fabric has already been issued for this lot, so its fabric cannot change.");
        }

        const fabric = await tx.fabric.findUnique({ where: { id: input.fabricId }, select: { unit: true } });

        if (!fabric) throw fieldError("fabricId", "Choose a fabric.");

        assertKg(fabric.unit);
        data.fabricId = input.fabricId;
      }

      if (input.productionDate !== undefined) data.productionDate = new Date(input.productionDate);

      if (input.targetQuantity !== undefined) data.targetQuantity = input.targetQuantity;

      if (input.notes !== undefined) data.notes = input.notes;

      await tx.productionLot.update({ where: { id }, data });
      await recordAudit(tx, {
        type: "LOT_UPDATED",
        ...audit(actor, meta),
        metadata: { lotId: id, fields: Object.keys(data) },
      });
    });

    return lotDetail(id, showCost);
  },
};

export const cuttingService = {
  list: listBatches,

  get: batchDto,

  async create(actor: AuthContext, lotId: string, draft: CuttingDraft, meta: ClientMeta, showCost: boolean) {
    const id = await transaction(async (tx) => {
      const lot = await lockLot(tx, lotId);

      assertLotOpen(lot);

      return createBatch(tx, actor, lot, draft, meta);
    });

    return batchDto(id, showCost);
  },

  /** Saves the editable state of an open batch (draft or issued). */
  async save(actor: AuthContext, id: string, draft: CuttingDraft, meta: ClientMeta, showCost: boolean) {
    await transaction(async (tx) => {
      const { lot, batch } = await lockBatch(tx, id);

      if (batch.status === "FINALIZED" || batch.status === "REVERSED") {
        throw errors.conflict(`${cutNumber(batch.number)} is ${batch.status.toLowerCase()}; it can no longer be edited.`);
      }

      assertLotOpen(lot);
      await assertMaster(tx, draft.cuttingMasterId, batch.status === "ISSUED");
      await tx.cuttingBatch.update({ where: { id }, data: batchFields(draft) });
      await writeDraft(tx, batch, id, draft);
      await saveDefaultsIf(tx, draft, lot.article_id);
      await recordAudit(tx, { type: "CUTTING_DRAFT_SAVED", ...audit(actor, meta), metadata: { batchId: id, lotId: lot.id } });
    });

    return batchDto(id, showCost);
  },

  async remove(actor: AuthContext, id: string, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      const { lot, batch } = await lockBatch(tx, id);

      if (batch.status !== "DRAFT") {
        throw errors.conflict(`${cutNumber(batch.number)} has fabric issued, so it cannot be deleted.`);
      }

      await tx.cuttingBatch.delete({ where: { id } });
      await recordAudit(tx, { type: "CUTTING_DRAFT_DELETED", ...audit(actor, meta), metadata: { batchId: id, lotId: lot.id } });
    });
  },

  /** Recalculates a submitted draft and checks the store can cover what it would issue. */
  async preview(input: { fabricId: string; batchId?: string | undefined; cutting: CuttingDraft }) {
    const inputs = draftInputsOf(input.cutting);
    const result = calculateBatch(inputs.marker, inputs.colours);

    const [fabric, issued] = await Promise.all([
      prisma.fabric.findUnique({ where: { id: input.fabricId }, select: { unit: true, stock: { select: { balance: true } } } }),
      input.batchId
        ? prisma.cuttingRoll.findMany({ where: { batchId: input.batchId, status: { not: "DRAFT" } }, select: { id: true } })
        : [],
    ]);

    if (!fabric) throw fieldError("fabricId", "Choose a fabric.");

    const alreadyIssued = new Set(issued.map((roll) => roll.id));

    const toIssue = input.cutting.colours
      .flatMap((colour) => colour.rolls)
      .reduce((sum, roll) => (roll.id && alreadyIssued.has(roll.id) ? sum : sum + parseScaled(roll.issuedKg, 6)!), 0n);

    const available = parseScaled(fabric.stock?.balance.toFixed() ?? "0", 6)!;

    return {
      result: serializeResult(result),
      stock: { unit: fabric.unit, availableKg: kg(available), toIssueKg: kg(toIssue), enough: toIssue <= available },
    };
  },

  async issue(actor: AuthContext, id: string, meta: ClientMeta, showCost: boolean) {
    await transaction(async (tx) => {
      const { lot, batch } = await lockBatch(tx, id);

      if (batch.status === "FINALIZED" || batch.status === "REVERSED") {
        throw errors.conflict(`${cutNumber(batch.number)} is already ${batch.status.toLowerCase()}.`);
      }

      assertLotOpen(lot);
      await assertMaster(tx, batch.cuttingMasterId, true);

      const { count } = await issueRolls(tx, actor, lot, batch);

      if (count === 0) throw errors.conflict(`Every Thaan in ${cutNumber(batch.number)} has already been issued.`);

      await recordAudit(tx, {
        type: "CUTTING_FABRIC_ISSUED",
        ...audit(actor, meta),
        metadata: { batchId: id, lotId: lot.id, rolls: count },
      });
    });

    return batchDto(id, showCost);
  },

  /**
   * Posts a batch in one transaction: issues any Thaan still in the store, then per
   * Thaan moves returns back to the store, consumed weight to CONSUMED and the
   * unreturned remainder to WASTAGE (AUTO_PALA_REMAINDER); writes size-wise output,
   * fabric and labour cost and the cutting master's earning, and locks the batch.
   * Everything is recalculated here from stored inputs. The batch row lock and the
   * once-only unique keys make a repeated request a conflict, never a second posting.
   */
  async finalize(actor: AuthContext, id: string, meta: ClientMeta, showCost: boolean) {
    await transaction(async (tx) => {
      const { lot, batch } = await lockBatch(tx, id);

      if (batch.status === "FINALIZED" || batch.status === "REVERSED") {
        throw errors.conflict(`${cutNumber(batch.number)} is already ${batch.status.toLowerCase()}.`);
      }

      assertLotOpen(lot);

      if (lot.target_quantity === null) {
        throw fieldError("targetQuantity", `Confirm the target quantity of ${lot.lot_number} before finalizing its cutting.`);
      }

      await assertMaster(tx, batch.cuttingMasterId, true);

      const inputs = calcInputsOf(batch);
      const result = calculateBatch(inputs.marker, inputs.colours);

      if (result.issues.length > 0) throw validationError(result.issues);

      const issued = await issueRolls(tx, actor, lot, batch);
      const master = batch.cuttingMaster!;
      const reference = `${cutNumber(batch.number)} · ${lot.lot_number}`;
      const movements: Prisma.CuttingMovementCreateManyInput[] = [];
      const returns: Prisma.FabricMovementCreateManyInput[] = [];
      const rollRows: Prisma.Sql[] = [];
      let consumedCost = 0n;
      let wastageCost = 0n;

      for (const [colourIndex, colour] of batch.colours.entries()) {
        for (const [rollIndex, roll] of colour.rolls.entries()) {
          const calc = result.colours[colourIndex]!.rolls[rollIndex]!;
          // Thaan issued just now carry the rate snapshotted by issueRolls.
          const rate = roll.fabricRate?.toFixed() ?? issued.rate ?? "0";

          const base = {
            batchId: id,
            lotId: lot.id,
            fabricId: lot.fabric_id,
            rollId: roll.id,
            colour: colour.name,
            thaan: roll.thaan,
            movementDate: batch.cuttingDate,
            createdById: actor.user.id,
          };

          if (calc.returnedKg > 0n) {
            movements.push({ ...base, type: "RETURN", fromState: "CUTTING", toState: "STORE", quantity: kg(calc.returnedKg) });
            returns.push({
              fabricId: lot.fabric_id,
              movementDate: batch.cuttingDate,
              type: "CUTTING_RETURN",
              qtyIn: kg(calc.returnedKg),
              reason: `Returned from cutting ${reference} · ${colour.name} · Thaan ${roll.thaan}`,
              cuttingBatchId: id,
              createdById: actor.user.id,
            });
          }

          if (calc.consumedKg > 0n) {
            movements.push({ ...base, type: "CONSUME", fromState: "CUTTING", toState: "CONSUMED", quantity: kg(calc.consumedKg) });
          }

          if (calc.wastageKg > 0n) {
            movements.push({
              ...base,
              type: "WASTAGE",
              fromState: "CUTTING",
              toState: "WASTAGE",
              quantity: kg(calc.wastageKg),
              wastageType: WASTAGE_TYPE,
            });
          }

          rollRows.push(
            Prisma.sql`(${roll.id}::uuid, ${calc.estimatedPala}::int, ${calc.confirmedPala}::int,
              ${calc.confirmedLayers}::int, ${kg(calc.consumedKg)}::numeric, ${kg(calc.wastageKg)}::numeric)`,
          );
          consumedCost += costOf(calc.consumedKg, rate);
          wastageCost += costOf(calc.wastageKg, rate);
        }
      }

      // A fixed handful of statements however many Thaan the batch has.
      if (movements.length > 0) await tx.cuttingMovement.createMany({ data: movements });

      if (returns.length > 0) await tx.fabricMovement.createMany({ data: returns });

      await tx.$executeRaw`
        UPDATE cutting_rolls r
        SET status = 'FINALIZED', estimated_pala = v.estimated, confirmed_pala = v.pala, confirmed_layers = v.layers,
            consumed_kg = v.consumed, wastage_kg = v.wastage
        FROM (VALUES ${Prisma.join(rollRows)}) AS v (id, estimated, pala, layers, consumed, wastage)
        WHERE r.id = v.id`;

      await tx.cuttingOutput.createMany({
        data: batch.colours.flatMap((colour, colourIndex) =>
          result.colours[colourIndex]!.sizes.map((size, position) => ({
            batchId: id,
            lotId: lot.id,
            colourId: colour.id,
            colourName: colour.name,
            sizeLabel: size.label,
            position,
            plannedQuantity: size.planned,
            rejectedQuantity: size.rejected,
            acceptedQuantity: size.accepted,
            availableForStitching: size.accepted,
            rejectReason: size.rejectReason,
          })),
        ),
      });

      // SAFETY: the column's CHECK constraint allows only the PayMode values.
      const payMode = master.payMode as PayMode;
      const payRate = master.payRate.toFixed(2);
      const pay = cuttingEarning(payMode, payRate, result.totals);
      // Salaried masters and zero rates earn nothing per job, so no ledger row.
      const earning = pay && pay.amount > 0n ? pay : null;
      const entryDate = batch.cuttingDate;

      const costs = [
        { kind: "FABRIC_CONSUMED", quantity: result.totals.consumedKg, paisa: consumedCost, rate: ratePerKg(consumedCost, result.totals.consumedKg) },
        { kind: "FABRIC_WASTAGE", quantity: result.totals.wastageKg, paisa: wastageCost, rate: ratePerKg(wastageCost, result.totals.wastageKg) },
        ...(earning ? [{ kind: "CUTTING_LABOUR", quantity: earning.quantity, paisa: earning.amount, rate: payRate }] : []),
      ];

      await tx.lotCost.createMany({
        data: costs.flatMap((cost) =>
          cost.quantity > 0n
            ? [
                {
                  lotId: lot.id,
                  batchId: id,
                  kind: cost.kind,
                  entryDate,
                  quantity: kg(cost.quantity),
                  rate: cost.rate,
                  amount: toDecimal(cost.paisa, 2),
                  createdById: actor.user.id,
                },
              ]
            : [],
        ),
      });

      if (earning) {
        await tx.karigarLedgerEntry.create({
          data: {
            karigarId: master.id,
            entryDate,
            type: "EARNING",
            payMode,
            quantity: kg(earning.quantity),
            rate: payRate,
            amount: toDecimal(earning.amount, 2),
            sourceType: "CUTTING",
            sourceId: id,
            description: `Cutting ${reference} · ${result.totals.acceptedPieces} pieces, ${result.totals.confirmedPala} Pala`,
            createdById: actor.user.id,
          },
        });
      }

      await tx.cuttingBatch.update({
        where: { id },
        data: {
          status: "FINALIZED",
          calculationVersion: CALCULATION_VERSION,
          calculatedPalaKg: result.marker.calculatedPalaKg === null ? null : kg(result.marker.calculatedPalaKg),
          activePalaKg: kg(result.marker.activePalaKg!),
          totalIssuedKg: kg(result.totals.issuedKg),
          totalReturnedKg: kg(result.totals.returnedKg),
          totalConsumedKg: kg(result.totals.consumedKg),
          totalWastageKg: kg(result.totals.wastageKg),
          totalPala: result.totals.confirmedPala,
          totalPlannedPieces: result.totals.plannedPieces,
          totalAcceptedPieces: result.totals.acceptedPieces,
          fabricCost: toDecimal(consumedCost + wastageCost, 2),
          earningAmount: earning ? toDecimal(earning.amount, 2) : null,
          finalizedById: actor.user.id,
          finalizedAt: new Date(),
        },
      });

      if (lot.status === "DRAFT") await tx.productionLot.update({ where: { id: lot.id }, data: { status: "ACTIVE" } });

      await recordAudit(tx, {
        type: "CUTTING_FINALIZED",
        ...audit(actor, meta),
        metadata: {
          batchId: id,
          lotId: lot.id,
          issuedKg: kg(result.totals.issuedKg),
          consumedKg: kg(result.totals.consumedKg),
          wastageKg: kg(result.totals.wastageKg),
          pieces: result.totals.acceptedPieces,
        },
      });
    });

    return batchDto(id, showCost);
  },

  /**
   * Undoes a finalized batch without deleting anything: linked reversal rows move
   * consumed and wasted weight back into cutting, everything still in cutting
   * returns to the store, cost and earning get negative reversals, and the cut
   * pieces stop being available. Blocked once any of them went on to stitching.
   */
  async reverse(actor: AuthContext, id: string, reason: string, meta: ClientMeta, showCost: boolean) {
    await transaction(async (tx) => {
      const { lot, batch } = await lockBatch(tx, id);

      if (batch.status === "REVERSED") throw errors.conflict(`${cutNumber(batch.number)} has already been reversed.`);

      if (batch.status !== "FINALIZED") throw errors.conflict("Only finalized cutting can be reversed.");

      if (lot.status === "COMPLETED") throw errors.conflict(`${lot.lot_number} is completed. Reopen it first.`);

      if (batch.outputs.some((output) => output.availableForStitching < output.acceptedQuantity)) {
        throw errors.conflict(
          `Cut pieces of ${cutNumber(batch.number)} have already gone to stitching. Return them from stitching first.`,
        );
      }

      const date = today();
      const reference = `${cutNumber(batch.number)} · ${lot.lot_number}`;

      const postings = await tx.cuttingMovement.findMany({
        where: { batchId: id, reversalOfId: null, type: { in: ["CONSUME", "WASTAGE"] } },
        orderBy: { seq: "asc" },
      });

      const returns = batch.colours.flatMap((colour) =>
        colour.rolls.flatMap((roll) => {
          const held = roll.issuedKg.minus(roll.returnedKg);

          return held.gt(0) ? [{ colour, roll, held }] : [];
        }),
      );

      // Bulk: reversal rows first (they point at what they undo), then everything back to the store.
      await tx.cuttingMovement.createMany({
        data: [
          ...postings.map((posting) => ({
            batchId: id,
            lotId: lot.id,
            fabricId: posting.fabricId,
            rollId: posting.rollId,
            colour: posting.colour,
            thaan: posting.thaan,
            movementDate: date,
            type: posting.type,
            fromState: posting.toState,
            toState: posting.fromState,
            quantity: posting.quantity,
            reversalOfId: posting.id,
            reason,
            createdById: actor.user.id,
          })),
          ...returns.map(({ colour, roll, held }) => ({
            batchId: id,
            lotId: lot.id,
            fabricId: lot.fabric_id,
            rollId: roll.id,
            colour: colour.name,
            thaan: roll.thaan,
            movementDate: date,
            type: "RETURN",
            fromState: "CUTTING",
            toState: "STORE",
            quantity: held,
            reason,
            createdById: actor.user.id,
          })),
        ],
      });

      if (returns.length > 0) {
        await tx.fabricMovement.createMany({
          data: returns.map(({ colour, roll, held }) => ({
            fabricId: lot.fabric_id,
            movementDate: date,
            type: "CUTTING_RETURN",
            qtyIn: held,
            reason: `Cutting ${reference} reversed · ${colour.name} · Thaan ${roll.thaan}: ${reason}`.slice(0, 500),
            cuttingBatchId: id,
            createdById: actor.user.id,
          })),
        });
      }

      await tx.cuttingRoll.updateMany({ where: { batchId: id }, data: { status: "REVERSED" } });

      const costs = await tx.lotCost.findMany({ where: { batchId: id, reversalOfId: null } });

      await tx.lotCost.createMany({
        data: costs.map((cost) => ({
          lotId: cost.lotId,
          batchId: id,
          kind: cost.kind,
          entryDate: date,
          quantity: cost.quantity.negated(),
          rate: cost.rate,
          amount: cost.amount.negated(),
          reversalOfId: cost.id,
          createdById: actor.user.id,
        })),
      });

      const earning = await tx.karigarLedgerEntry.findUnique({
        where: { sourceType_sourceId_type: { sourceType: "CUTTING", sourceId: id, type: "EARNING" } },
      });

      if (earning) {
        await tx.karigarLedgerEntry.create({
          data: {
            karigarId: earning.karigarId,
            entryDate: date,
            type: "EARNING_REVERSAL",
            payMode: earning.payMode,
            quantity: earning.quantity.negated(),
            rate: earning.rate,
            amount: earning.amount.negated(),
            sourceType: "CUTTING",
            sourceId: id,
            description: `Reversed: ${earning.description}`,
            createdById: actor.user.id,
          },
        });
      }

      await tx.cuttingOutput.updateMany({ where: { batchId: id }, data: { availableForStitching: 0 } });
      await tx.cuttingBatch.update({
        where: { id },
        data: { status: "REVERSED", reversedById: actor.user.id, reversedAt: new Date(), reversalReason: reason },
      });
      await recordAudit(tx, { type: "CUTTING_REVERSED", ...audit(actor, meta), metadata: { batchId: id, lotId: lot.id, reason } });
    });

    return batchDto(id, showCost);
  },
};
