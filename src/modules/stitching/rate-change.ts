import { factoryToday } from "../../lib/business-date";
import { prisma, type Prisma } from "../../db/prisma";
import type { AuthContext } from "../sessions/session.types";
import { paisaText, splitEarning, toPaisa, type SplitMember, type SplitMethod } from "./stitching.split";

// A rate per piece that changes after work was paid. The pay already posted stays as it is; the
// difference for the pieces already paid is posted on top (more pay as EARNING, less as
// EARNING_REVERSAL) with source RATE_CHANGE and the rate_changes row as its id, plus a matching
// labour cost on the lot. Shared by stitching issues and packing entries.

type Tx = Prisma.TransactionClient;

export interface RateDifference {
  sourceType: "STITCHING_ISSUE" | "PACKING_ENTRY";
  /** The stitching issue or packing entry. */
  sourceId: string;
  lotId: string;
  oldRate: string | null;
  newRate: string;
  /** Pieces already paid that the difference applies to. */
  pieces: number;
  /** Who shares the difference, and how (the issue's or entry's own split). */
  members: SplitMember[];
  method: Exclude<SplitMethod, "AMOUNT">;
  costKind: "STITCHING_LABOUR" | "PACKING_LABOUR";
  /** e.g. "SI-0012 · LOT-45"; the rates and pieces are added. */
  label: string;
  reason: string | null;
}

/**
 * Records the change and posts the difference: pieces × (new − old), split like the original pay.
 * Returns the signed total in paisa (0 when nothing was paid yet, or the rate was blank before).
 */
export async function postRateDifference(tx: Tx, actor: AuthContext, change: RateDifference): Promise<bigint> {
  const step = change.oldRate === null ? 0n : toPaisa(change.newRate) - toPaisa(change.oldRate);
  const total = BigInt(change.pieces) * step;
  const row = await tx.rateChange.create({
    data: {
      sourceType: change.sourceType,
      sourceId: change.sourceId,
      lotId: change.lotId,
      oldRate: change.oldRate,
      newRate: change.newRate,
      pieces: change.pieces,
      // A rate set from blank records the pay it released (posted by the caller per document).
      amount: paisaText(change.oldRate === null ? BigInt(change.pieces) * toPaisa(change.newRate) : total),
      reason: change.reason,
      createdById: actor.user.id,
    },
    select: { id: true },
  });

  if (total === 0n) return 0n;

  // The split works on a positive amount; a cut in pay is the same split, negated.
  const magnitude = total < 0n ? -total : total;
  const split = splitEarning(magnitude, change.method, change.members);

  // SAFETY: the members and method are the ones the original pay was split with, which succeeded.
  if (!split.ok) throw new Error(split.message);

  const date = new Date(factoryToday());
  const sign = total < 0n ? -1n : 1n;
  const rateText = paisaText(step);
  const description =
    `Rate change ${change.label} · Rs ${change.oldRate} → Rs ${change.newRate} · ${change.pieces} pcs` +
    (change.reason ? ` · ${change.reason}` : "");

  await tx.karigarLedgerEntry.createMany({
    data: [...split.amounts]
      .filter(([, amount]) => amount > 0n)
      .map(([karigarId, amount]) => ({
        karigarId,
        entryDate: date,
        type: sign > 0n ? "EARNING" : "EARNING_REVERSAL",
        payMode: "PER_PIECE",
        quantity: change.pieces,
        rate: rateText,
        amount: paisaText(amount * sign),
        sourceType: "RATE_CHANGE",
        sourceId: row.id,
        description: description.slice(0, 500),
        createdById: actor.user.id,
      })),
  });
  await tx.lotCost.create({
    data: {
      lotId: change.lotId,
      sourceId: row.id,
      kind: change.costKind,
      entryDate: date,
      quantity: change.pieces,
      rate: rateText,
      amount: paisaText(total),
      createdById: actor.user.id,
    },
  });

  return total;
}

/** Every rate set or change on an issue or packing entry, oldest first (money: costing.view only). */
export async function rateHistory(sourceType: RateDifference["sourceType"], sourceId: string) {
  const rows = await prisma.rateChange.findMany({
    where: { sourceType, sourceId },
    orderBy: { number: "asc" },
    include: { createdBy: { select: { name: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    oldRate: row.oldRate?.toFixed(2) ?? null,
    newRate: row.newRate.toFixed(2),
    pieces: row.pieces,
    amount: row.amount.toFixed(2),
    reason: row.reason,
    by: row.createdBy.name,
    at: row.createdAt,
  }));
}
