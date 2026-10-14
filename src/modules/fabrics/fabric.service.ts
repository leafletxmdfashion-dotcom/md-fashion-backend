import { isUniqueViolation, prisma, transaction } from "../../db/prisma";
import { AppError, ErrorCode, errors } from "../../lib/errors";
import { recordAudit } from "../audit/audit.service";
import type { AuthContext, ClientMeta } from "../sessions/session.types";
import { fabricRepository, inwardRepository, type FabricDto, type InwardDto } from "./fabric.repository";
import type {
  AdjustmentInput,
  CreateFabricInput,
  CreateInwardInput,
  FabricListQuery,
  InwardListQuery,
  MovementListQuery,
  UpdateFabricInput,
} from "./fabric.schema";

function fieldError(field: string, message: string): AppError {
  return new AppError(400, ErrorCode.VALIDATION_ERROR, message, { [field]: [message] });
}

const duplicateCode = () =>
  new AppError(409, ErrorCode.CONFLICT, "Another fabric already uses this code.", {
    code: ["Another fabric already uses this code."],
  });

const formatQty = (quantity: number, unit: string) =>
  `${quantity.toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${unit === "KG" ? "kg" : "m"}`;

function audit(actor: AuthContext, meta: ClientMeta) {
  return { actorUserId: actor.user.id, sessionId: actor.sessionId, meta };
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

  async create(actor: AuthContext, input: CreateFabricInput, meta: ClientMeta): Promise<FabricDto> {
    try {
      return await transaction(async (tx) => {
        const id = await fabricRepository.create(tx, input, actor.user.id);
        await recordAudit(tx, {
          type: "FABRIC_CREATED",
          ...audit(actor, meta),
          metadata: { fabricId: id, code: input.code },
        });
        return (await fabricRepository.findById(tx, id))!;
      });
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateCode() : error;
    }
  },

  async update(actor: AuthContext, id: string, input: UpdateFabricInput, meta: ClientMeta): Promise<FabricDto> {
    try {
      return await transaction(async (tx) => {
        const current = await fabricRepository.lock(tx, id);
        if (!current) throw errors.notFound("Fabric");
        const before = (await fabricRepository.findById(tx, id))!;
        // Posted quantities are in the old unit; changing it would silently rescale history.
        if (input.unit !== current.unit && before.movementCount > 0) {
          throw fieldError("unit", "The unit cannot change once stock has been posted for this fabric.");
        }
        await fabricRepository.update(tx, id, input);
        const fields = (["code", "name", "unit", "lowStockThreshold", "description"] as const).filter(
          (field) => input[field] !== before[field],
        );
        await recordAudit(tx, { type: "FABRIC_UPDATED", ...audit(actor, meta), metadata: { fabricId: id, fields } });
        return (await fabricRepository.findById(tx, id))!;
      });
    } catch (error) {
      throw isUniqueViolation(error) ? duplicateCode() : error;
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
      const fabric = await fabricRepository.lock(tx, input.fabricId);
      if (!fabric) throw fieldError("fabricId", "Choose a fabric.");

      const id = await inwardRepository.create(tx, input, actor.user.id);
      await fabricRepository.addMovement(tx, {
        fabricId: input.fabricId,
        date: input.inwardDate,
        type: "PURCHASE_IN",
        quantity: input.quantity,
        inwardId: id,
        createdBy: actor.user.id,
      });
      await recordAudit(tx, {
        type: "FABRIC_INWARD_POSTED",
        ...audit(actor, meta),
        metadata: { inwardId: id, fabricId: input.fabricId, quantity: input.quantity, rate: input.rate },
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
