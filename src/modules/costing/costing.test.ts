import { beforeEach, describe, expect, it } from "vitest";

import { karigar, post, stitchedLot, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql, type TestClient } from "../../test/helpers";

beforeEach(resetDatabase);

async function ledgerTotal(lotId: string) {
  const { rows } = await sql(
    "SELECT COALESCE(sum(amount), 0)::numeric(14, 2)::text AS t FROM lot_costs WHERE lot_id = $1",
    [lotId],
  );

  return rows[0].t as string;
}

interface Sheet {
  lot: {
    total: string;
    perPiece: string | null;
    final: boolean;
    pieces: { cut: number; good: number; packed: number };
    groups: { key: string; amount: string }[];
  };
  lines: { id: string; source: string; removable: boolean; label: string; description: string; amount: string }[];
}

async function sheet(client: TestClient, lotId: string): Promise<Sheet> {
  const res = await client.get(`/api/v1/costing/lots/${lotId}`);

  expect(res.status, JSON.stringify(res.body)).toBe(200);

  return res.body.data as Sheet;
}

const addCost = (client: TestClient, lotId: string, body: object) =>
  client.send("post", `/api/v1/costing/lots/${lotId}/costs`, { entryDate: today, ...body });

describe("costing", () => {
  it("shows a lot's automatic costs, adds and removes hand costs, and gives cost per packed piece", async () => {
    const { owner, lotId } = await stitchedLot();
    const before = await sheet(owner, lotId);

    // The sheet adds up exactly what the documents posted.
    expect(before.lot.total).toBe(await ledgerTotal(lotId));
    expect(before.lot.pieces).toMatchObject({ cut: 84, good: 81, packed: 0 });
    // Nothing packed yet: no cost per piece (not 0, no division by zero).
    expect(before.lot.perPiece).toBeNull();
    expect(before.lines.every((line) => line.source === "AUTO" && !line.removable)).toBe(true);
    expect(before.lines.some((line) => line.description.startsWith("CUT-"))).toBe(true);

    // Only the hand-added kinds, and only with what they are for.
    expect((await addCost(owner, lotId, { kind: "STITCHING_LABOUR", amount: 10, note: "Sneaky" })).status).toBe(400);
    expect((await addCost(owner, lotId, { kind: "ACCESSORIES", amount: 10 })).status).toBe(400);

    const added = await addCost(owner, lotId, {
      kind: "ACCESSORIES",
      amount: 1500,
      note: "Zips and buttons",
      reference: "B-12",
    });

    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data.lot.groups.find((group: { key: string }) => group.key === "ACCESSORIES").amount).toBe(
      "1500.00",
    );

    const packer = await karigar(owner, "Puja", "PACKING_STAFF");

    await post(owner, "/api/v1/packing/entries", {
      lotId,
      packerId: packer,
      rate: 2,
      packDate: today,
      lines: [{ sizeLabel: "M", quantity: 40 }],
    });

    const after = await sheet(owner, lotId);
    const total = Number(after.lot.total);

    expect(after.lot.total).toBe(await ledgerTotal(lotId));
    expect(after.lot.pieces.packed).toBe(40);
    expect(after.lot.perPiece).toBe((total / 40).toFixed(2));
    expect(after.lot.final).toBe(false);

    const manual = after.lines.find((line) => line.source === "MANUAL")!;

    expect(manual).toMatchObject({ label: "Accessories", description: "Zips and buttons", removable: true });
    expect((await owner.send("post", `/api/v1/costing/costs/${manual.id}/remove`, { reason: "x" })).status).toBe(400);

    const removed = await owner.send("post", `/api/v1/costing/costs/${manual.id}/remove`, { reason: "Wrong lot" });

    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(Number(removed.body.data.lot.total)).toBeCloseTo(total - 1500, 2);
    expect((await owner.send("post", `/api/v1/costing/costs/${manual.id}/remove`, { reason: "Again" })).status).toBe(
      409,
    );

    // An automatic cost cannot be removed here.
    const auto = after.lines.find((line) => line.source === "AUTO")!;

    expect((await owner.send("post", `/api/v1/costing/costs/${auto.id}/remove`, { reason: "Nope" })).status).toBe(409);

    // Completing the lot makes the per-piece figure final.
    await sql("UPDATE production_lots SET status = 'COMPLETED' WHERE id = $1", [lotId]);

    expect((await sheet(owner, lotId)).lot.final).toBe(true);
    expect((await owner.get("/api/v1/costing/lots?status=COMPLETED")).body.data.total).toBe(1);
  });

  it("is for people who see prices; adding costs needs Add lot costs too", async () => {
    const { lotId } = await stitchedLot();

    await createUser({ email: "manager@garment.test", role: "MANAGER" });
    await createUser({ email: "accounts@garment.test", role: "ACCOUNTANT" });

    const manager = await loggedInClient("manager@garment.test");

    expect((await manager.get("/api/v1/costing/lots")).status).toBe(403);

    // The accountant is given prices on their own, but not Add lot costs.
    await sql(
      `INSERT INTO user_permission_overrides (user_id, permission, effect, reason)
       SELECT id, 'costing.view', 'ALLOW', 'Books' FROM users WHERE email = 'accounts@garment.test'`,
    );

    const accounts = await loggedInClient("accounts@garment.test");

    expect((await accounts.get(`/api/v1/costing/lots/${lotId}`)).status).toBe(200);
    expect((await addCost(accounts, lotId, { kind: "OTHER_DIRECT", amount: 5, note: "Tea" })).status).toBe(403);
  });
});
