// Splits a team's earning over its members, in exact paisa (BigInt). The three
// methods of the spec: equal, configured percentages totalling exactly 100%, or
// direct amounts totalling exactly the team earning. Rounding never loses or
// invents a paisa: the leftover of a division goes to members in the order given
// (the issue snapshot lists them by name, as the issue sheet shows them).

export type SplitMethod = "EQUAL" | "PERCENT" | "AMOUNT";

export interface SplitMember {
  karigarId: string;
  /** Hundredths of a percent (33.33% → 3333); PERCENT only. */
  shareHundredths?: number | null;
  /** Paisa; AMOUNT only. */
  amountPaisa?: bigint | null;
}

export type SplitResult = { ok: true; amounts: Map<string, bigint> } | { ok: false; message: string };

/** Rupees with up to 2 decimals → paisa, exactly (string arithmetic, no float rounding). */
export function toPaisa(rupees: number | string): bigint {
  const [whole = "0", fraction = ""] = String(rupees).split(".");

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

export function paisaText(paisa: bigint): string {
  const sign = paisa < 0n ? "-" : "";
  const magnitude = paisa < 0n ? -paisa : paisa;

  return `${sign}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

export function splitEarning(totalPaisa: bigint, method: SplitMethod, members: SplitMember[]): SplitResult {
  if (members.length === 0) return { ok: false, message: "The team has no members to pay." };

  const amounts = new Map<string, bigint>();

  if (method === "AMOUNT") {
    let sum = 0n;

    for (const member of members) {
      const amount = member.amountPaisa ?? 0n;

      sum += amount;
      amounts.set(member.karigarId, amount);
    }

    return sum === totalPaisa
      ? { ok: true, amounts }
      : { ok: false, message: `Amounts add up to Rs ${paisaText(sum)}; the team earned Rs ${paisaText(totalPaisa)}.` };
  }

  const weights =
    method === "EQUAL" ? members.map(() => 1n) : members.map((member) => BigInt(member.shareHundredths ?? 0));

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);

  if (method === "PERCENT" && totalWeight !== 10_000n) {
    return { ok: false, message: `Shares add up to ${paisaText(totalWeight)}%; they must make exactly 100%.` };
  }

  let given = 0n;

  members.forEach((member, index) => {
    const amount = (totalPaisa * weights[index]!) / totalWeight;

    given += amount;
    amounts.set(member.karigarId, amount);
  });

  // Hand out the leftover paisa one by one, to members who have a share.
  for (let index = 0; given < totalPaisa; index = (index + 1) % members.length) {
    if (weights[index]! === 0n) continue;

    const id = members[index]!.karigarId;

    amounts.set(id, amounts.get(id)! + 1n);
    given += 1n;
  }

  return { ok: true, amounts };
}
