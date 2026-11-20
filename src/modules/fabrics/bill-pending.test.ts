import { beforeEach, describe, expect, it } from "vitest";

import { cutLot, karigar, post, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql, type TestClient } from "../../test/helpers";

// Fabric that arrives before its bill: it is received at once (stock right), cut at once, and
// priced when the bill comes; cutting done meanwhile is re-costed at the real rate.

beforeEach(resetDatabase);

const purchase = (client: TestClient, quantity: number, extra: object) =>
  client.send("post", "/api/v1/fabrics/inwards", {
    fabricName: "Jersey",
    unit: "KG",
    inwardDate: today,
    quantity,
    ...extra,
  });

async function fabricCost(lotId: string) {
  const { rows } = await sql(
    `SELECT COALESCE(sum(amount), 0)::numeric(14, 2)::text AS amount FROM lot_costs
     WHERE lot_id = $1 AND kind IN ('FABRIC_CONSUMED', 'FABRIC_WASTAGE')`,
    [lotId],
  );

  return rows[0].amount as string;
}

async function setup() {
  await createUser({ email: "owner@garment.test", role: "OWNER" });

  const owner = await loggedInClient("owner@garment.test");
  const billed = await purchase(owner, 100, { rate: 500, supplier: "Shah Textiles" });

  expect(billed.status, JSON.stringify(billed.body)).toBe(201);

  const fabricId = billed.body.data.inward.fabric.id as string;
  const masterId = await karigar(owner, "Cutter", "CUTTING_MASTER");

  return { owner, fabricId, masterId };
}

describe("fabric before its bill", () => {
  it("receives without a rate, cuts at once, and re-costs that cutting when the bill is added", async () => {
    const { owner, fabricId, masterId } = await setup();

    expect((await purchase(owner, 50, { billPending: true, rate: 600 })).status).toBe(400);
    expect((await purchase(owner, 50, {})).status).toBe(400);

    const pending = await purchase(owner, 50, { billPending: true, supplier: "Shah Textiles" });

    expect(pending.status, JSON.stringify(pending.body)).toBe(201);
    expect(pending.body.data.inward).toMatchObject({ billStatus: "PENDING", rate: null, amount: null });

    const inwardId = pending.body.data.inward.id as string;

    // Stock counts the fabric at once; the average rate is over billed purchases only.
    expect((await owner.get(`/api/v1/fabrics/${fabricId}`)).body.data.fabric).toMatchObject({
      balance: 150,
      avgRate: 500,
    });
    expect((await owner.get("/api/v1/fabrics/inwards?billStatus=PENDING")).body.data).toMatchObject({
      total: 1,
      billsPending: 1,
    });

    // 45.5 kg cut while the bill is pending: costed at Rs 500 for now, marked provisional.
    const { lotId } = await cutLot(owner, fabricId, masterId, "Polo", "LOT-1");
    const batchId = (await sql("SELECT id FROM cutting_batches WHERE lot_id = $1", [lotId])).rows[0].id as string;

    expect((await owner.get(`/api/v1/cutting-batches/${batchId}`)).body.data.batch.costs).toMatchObject({
      provisional: true,
    });
    expect(await fabricCost(lotId)).toBe("22750.00");

    const bill = await owner.send("post", `/api/v1/fabrics/inwards/${inwardId}/bill`, {
      rate: 560,
      invoiceRef: "INV-77",
    });

    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.data).toMatchObject({
      inward: { billStatus: "BILLED", rate: 560, amount: 28000, supplier: "Shah Textiles", invoiceRef: "INV-77" },
      recostedBatches: 1,
    });

    // (100 × 500 + 50 × 560) / 150 = 520 a kg; 45.5 kg = Rs 23,660.
    expect((await owner.get(`/api/v1/fabrics/${fabricId}`)).body.data.fabric.avgRate).toBe(520);
    expect(await fabricCost(lotId)).toBe("23660.00");
    expect((await owner.get(`/api/v1/cutting-batches/${batchId}`)).body.data.batch.costs).toMatchObject({
      provisional: false,
      fabricCost: "23660",
    });

    // One bill per purchase; corrections reverse and re-enter.
    expect((await owner.send("post", `/api/v1/fabrics/inwards/${inwardId}/bill`, { rate: 1 })).status).toBe(409);

    // Reversing the cutting takes back exactly the live cost, once.
    const reversed = await owner.send("post", `/api/v1/cutting-batches/${batchId}/reverse`, { reason: "Wrong lot" });

    expect(reversed.status, JSON.stringify(reversed.body)).toBe(201);
    expect(await fabricCost(lotId)).toBe("0.00");
  });

  it("keeps cutting provisional while any bill of the fabric is still pending", async () => {
    const { owner, fabricId, masterId } = await setup();
    const first = (await purchase(owner, 20, { billPending: true })).body.data.inward.id as string;

    await purchase(owner, 20, { billPending: true });

    const { lotId } = await cutLot(owner, fabricId, masterId, "Polo", "LOT-1");
    const bill = await owner.send("post", `/api/v1/fabrics/inwards/${first}/bill`, { rate: 800 });

    expect(bill.body.data.recostedBatches).toBe(0);
    expect(await fabricCost(lotId)).toBe("22750.00");
  });

  it("lets the store receive without prices; only someone who sees prices adds the bill", async () => {
    const { owner } = await setup();

    await createUser({ email: "store@garment.test", role: "STORE_KEEPER" });

    const store = await loggedInClient("store@garment.test");
    const pending = await purchase(store, 10, { billPending: true });

    expect(pending.status, JSON.stringify(pending.body)).toBe(201);

    const inwardId = pending.body.data.inward.id as string;

    expect((await store.send("post", `/api/v1/fabrics/inwards/${inwardId}/bill`, { rate: 500 })).status).toBe(403);
    expect((await owner.send("post", `/api/v1/fabrics/inwards/${inwardId}/bill`, { rate: 500 })).status).toBe(200);

    // A pending purchase can still be reversed like any other, and then takes no bill.
    const another = (await purchase(owner, 5, { billPending: true })).body.data.inward.id as string;
    const reversed = await post(owner, `/api/v1/fabrics/inwards/${another}/reverse`, { reason: "Sent back" }, 200);

    expect(reversed.inward).toMatchObject({ billStatus: "PENDING" });
    expect((await owner.send("post", `/api/v1/fabrics/inwards/${another}/bill`, { rate: 500 })).status).toBe(409);
  });
});
