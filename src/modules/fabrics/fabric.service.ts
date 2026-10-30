import { isUniqueViolation, prisma, transaction, type Db } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { recordAudit } from "../audit/audit.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { fabricRepository, inwardRepository, type FabricDto, type InwardDto } from "./fabric.repository";
import type {
  AdjustmentInput,
  CreateInwardInput,
  FabricListQuery,
  InwardListQuery,
  MovementListQuery,
  UpdateFabricInput,
} from "./fabric.schema";

function fieldError(field: string, message: string): AppError {
  return new AppError(400, ErrorCode.VALIDATION_ERROR, message, { [field]: [message] });
}

const formatQty = (quantity: number, unit: string) =>
  `${quantity.toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${unit === "KG" ? "kg" : "m"}`;

function audit(actor: AuthContext, meta: ClientMeta) {
  return { actorUserId: actor.user.id, sessionId: actor.sessionId, meta };
}

/**
 * The purchase's fabric by name (ignoring case), locked for the stock write; created
 * with a generated code when new. A reorder level or description sent with the
 * purchase becomes the fabric's; one left out keeps the fabric's own.
 */
async function resolveFabric(tx: Db, actor: AuthContext, input: CreateInwardInput, meta: ClientMeta): Promise<string> {
  let found = await fabricRepository.lockByName(tx, input.fabricName);
  if (!found) {
    const created = await fabricRepository.create(tx, input, actor.user.id);
    if (created) {
      await recordAudit(tx, {
        type: "FABRIC_CREATED",
        ...audit(actor, meta),
        metadata: { fabricId: created.id, code: created.code },
      });
      return created.id;
    }
    // Another purchase created this name a moment ago; add to that fabric.
    found = (await fabricRepository.lockByName(tx, input.fabricName))!;
  }

  const fabric = found;
  if (fabric.unit !== input.unit) {
    const unit = fabric.unit === "KG" ? "kilograms" : "metres";
    throw fieldError("unit", `${fabric.name} is bought in ${unit}. Use the same unit, or a new fabric name.`);
  }

  const details = {
    lowStockThreshold: input.lowStockThreshold === undefined ? fabric.lowStockThreshold : input.lowStockThreshold,
    description: input.description === undefined ? fabric.description : input.description,
  };
  const changed = (["lowStockThreshold", "description"] as const).filter((field) => details[field] !== fabric[field]);
  if (changed.length > 0) {
    await fabricRepository.updateDetails(tx, fabric.id, details);
    await recordAudit(tx, {
      type: "FABRIC_UPDATED",
      ...audit(actor, meta),
      metadata: { fabricId: fabric.id, fields: changed },
    });
  }
  return fabric.id;
}

export const fabricService = {
  list(query: FabricListQuery) {
    return fabricRepository.list(query);
  },

  options() {
    return fabricRepository.options();
  },

  async get(id: string): Promise<FabricDto> {
    const fabric = await fabricRepository.findById(prisma, id);
    if (!fabric) throw errors.notFound("Fabric");
    return fabric;
  },

  /** Fixes a fabric's name, unit, reorder level or description. */
  async update(actor: AuthContext, id: string, input: UpdateFabricInput, meta: ClientMeta): Promise<FabricDto> {
    try {
      return await transaction(async (tx) => {
        if (!(await fabricRepository.lock(tx, id))) throw errors.notFound("Fabric");
        const before = (await fabricRepository.findById(tx, id))!;
        // Posted quantities are in the old unit; changing it would silently rescale history.
        if (input.unit !== before.unit && before.movementCount > 0) {
          throw fieldError("unit", "The unit cannot change once stock has been posted for this fabric.");
        }
        const fields = (["name", "unit", "lowStockThreshold", "description"] as const).filter(
          (field) => input[field] !== before[field],
        );
        if (fields.length > 0) {
          await fabricRepository.updateDetails(tx, id, input);
          await recordAudit(tx, { type: "FABRIC_UPDATED", ...audit(actor, meta), metadata: { fabricId: id, fields } });
        }
        return (await fabricRepository.findById(tx, id))!;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new AppError(409, ErrorCode.CONFLICT, "Another fabric already has this name.", {
        name: ["Another fabric already has this name."],
      });
    }
  },

  async adjust(actor: AuthContext, fabricId: string, input: AdjustmentInput, meta: ClientMeta): Promise<void> {
    await transaction(async (tx) => {
      const fabric = await fabricRepository.lock(tx, fabricId);
      if (!fabric) throw errors.notFound("Fabric");
      if (input.direction === "OUT" && input.quantity > fabric.balance) {
        throw fieldError("quantity", `Only ${formatQty(fabric.balance, fabric.unit)} is in stock.`);
      }
      await fabricRepository.addMovement(tx, {
        fabricId,
        type: input.direction === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
        quantity: input.quantity,
        reason: input.reason,
        createdBy: actor.user.id,
      });
      await recordAudit(tx, {
        type: "FABRIC_STOCK_ADJUSTED",
        ...audit(actor, meta),
        metadata: { fabricId, direction: input.direction, quantity: input.quantity, reason: input.reason },
      });
    });
  },

  listMovements(query: MovementListQuery) {
    return fabricRepository.listMovements(query);
  },

  ledgerSummary(fabricId: string, range: { from?: string | undefined; to?: string | undefined }) {
    return fabricRepository.ledgerSummary(fabricId, range);
  },
};

export const inwardService = {
  list(query: InwardListQuery) {
    return inwardRepository.list(query);
  },

  suppliers(): Promise<string[]> {
    return inwardRepository.suppliers();
  },

  async create(actor: AuthContext, input: CreateInwardInput, meta: ClientMeta): Promise<InwardDto> {
    return transaction(async (tx) => {
      const fabricId = await resolveFabric(tx, actor, input, meta);
      const id = await inwardRepository.create(tx, fabricId, input, actor.user.id);
      await fabricRepository.addMovement(tx, {
        fabricId,
        date: input.inwardDate,
        type: "PURCHASE_IN",
        quantity: input.quantity,
        inwardId: id,
        createdBy: actor.user.id,
      });
      await recordAudit(tx, {
        type: "FABRIC_INWARD_POSTED",
        ...audit(actor, meta),
        metadata: { inwardId: id, fabricId, quantity: input.quantity, rate: input.rate },
      });
      return (await inwardRepository.findById(tx, id))!;
    });
  },

  /** Posts an equal OUT movement; the purchase row stays, marked reversed. */
  async reverse(actor: AuthContext, id: string, reason: string, meta: ClientMeta): Promise<InwardDto> {
    return transaction(async (tx) => {
      const inward = await inwardRepository.findById(tx, id, true);
      if (!inward) throw errors.notFound("Purchase");
      if (inward.reversal) throw errors.conflict("This purchase has already been reversed.");

      const fabric = (await fabricRepository.lock(tx, inward.fabric.id))!;
      if (inward.quantity > fabric.balance) {
        throw errors.conflict(
          `Only ${formatQty(fabric.balance, fabric.unit)} of ${inward.fabric.name} is in stock, so this purchase of ${formatQty(inward.quantity, fabric.unit)} cannot be reversed. Adjust stock instead.`,
        );
      }
      await inwardRepository.markReversed(tx, id, actor.user.id, reason);
      await fabricRepository.addMovement(tx, {
        fabricId: inward.fabric.id,
        type: "PURCHASE_REVERSAL",
        quantity: inward.quantity,
        inwardId: id,
        reason,
        createdBy: actor.user.id,
      });
      await recordAudit(tx, {
        type: "FABRIC_INWARD_REVERSED",
        ...audit(actor, meta),
        metadata: { inwardId: id, fabricId: inward.fabric.id, quantity: inward.quantity, reason },
      });
      return (await inwardRepository.findById(tx, id))!;
    });
  },
};
