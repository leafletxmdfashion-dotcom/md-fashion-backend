import { beforeEach, describe, expect, it } from "vitest";

import { createUser, loggedInClient, resetDatabase, sql, type TestClient } from "../../test/helpers";

let lotCounter = 0;

beforeEach(async () => {
  lotCounter = 0;
  await resetDatabase();
});

const today = new Date().toISOString().slice(0, 10);

interface Batch {
  id: string;
  number: number;
  status: string;
  colours: { id: string; name: string; rolls: { id: string; thaan: string; status: string; issuedKg: string }[] }[];
  posted: { consumedKg: string; wastageKg: string; pala: number; acceptedPieces: number } | null;
  costs: { fabricCost: string; earningAmount: string | null } | null;
  outputs: { colourName: string; sizeLabel: string; planned: number; accepted: number; available: number }[];
}

/** Purchases create fabrics by name; returns the fabric's id. */
async function buyFabric(client: TestClient, fabricName: string, unit: "KG" | "METER", quantity: number) {
  const inward = await client.send("post", "/api/v1/fabrics/inwards", {
    fabricName,
    unit,
    inwardDate: today,
    quantity,
    rate: 500,
  });

  expect(inward.status).toBe(201);

  // SAFETY: supertest bodies are untyped; the 201 above means the inward DTO was returned.
  return inward.body.data.inward.fabric.id as string;
}

async function setup() {
  await createUser({ email: "owner@garment.test", role: "OWNER", name: "Olivia Owner" });
  await createUser({ email: "staff@garment.test", role: "STAFF" });
  await createUser({ email: "viewer@garment.test", role: "VIEWER" });

  const owner = await loggedInClient("owner@garment.test");
  const fabricId = await buyFabric(owner, "Cotton Jersey", "KG", 100);

  const master = await owner.send("post", "/api/v1/karigars", {
    name: "Ram Bahadur",
    category: "CUTTING_MASTER",
    payMode: "PER_PIECE",
    payRate: 2.5,
  });

  expect(master.status).toBe(201);

  // SAFETY: the 201 above means the karigar DTO was returned.
  return { owner, fabricId, masterId: master.body.data.karigar.id as string };
}

interface RollDraft {
  id?: string;
  thaan?: string;
  issuedKg: string;
  returnedKg?: string;
  confirmedLayers?: number;
  note?: string;
}

interface ColourDraft {
  id?: string;
  name: string;
  rolls: RollDraft[];
}

function draft(masterId: string | null, colours: ColourDraft[], palaKg = "2.130") {
  return {
    cuttingMasterId: masterId,
    cuttingDate: today,
    marker: {
      measuredPalaKg: palaKg,
      weightSource: "MEASURED",
      repetitionsPerLayer: 1,
      widthM: "1.5",
      lengthM: "7.1",
      gsm: "200",
    },
    sizes: [
      { label: "S", piecesPerPala: 1 },
      { label: "M", piecesPerPala: 2 },
      { label: "L", piecesPerPala: 1 },
    ],
    colours,
  };
}

const black = (issuedKg: string, extra: Partial<RollDraft> = {}): ColourDraft => ({
  name: "Black",
  rolls: [{ thaan: "TH-001", issuedKg, ...extra }],
});

type CuttingBody = ReturnType<typeof draft> & { saveAsDefault?: boolean };

async function newProduction(
  client: TestClient,
  fabricId: string,
  cutting: CuttingBody,
  extra: { targetQuantity?: number | null; lotNumber?: string; fabricId?: string } = {},
) {
  const res = await client.send("post", "/api/v1/production-lots", {
    lotNumber: `L-${(lotCounter += 1)}`,
    article: { name: "Polo T-Shirt" },
    fabricId,
    productionDate: today,
    targetQuantity: 56,
    cutting,
    ...extra,
  });

  expect(res.status).toBe(201);

  // SAFETY: the 201 above means the lot and batch DTOs were returned.
  return res.body.data as { lot: { id: string; lotNumber: string; status: string }; batch: Batch };
}

async function balanceOf(client: TestClient, fabricId: string): Promise<number> {
  return Number((await client.get(`/api/v1/fabrics/${fabricId}`)).body.data.fabric.balance);
}

async function movements(batchId: string) {
  const { rows } = await sql(
    `SELECT type, from_state, to_state, quantity::text AS quantity, wastage_type, reversal_of IS NOT NULL AS reversal
     FROM cutting_movements WHERE batch_id = $1 ORDER BY seq`,
    [batchId],
  );

  // SAFETY: the SELECT list above defines exactly these columns.
  return rows as {
    type: string;
    from_state: string;
    to_state: string;
    quantity: string;
    wastage_type: string | null;
  }[];
}

describe("definition of done: one Thaan from new production to finalized cutting", () => {
  it("creates article, lot and draft together, then finalizes 30.500 kg into 56 pieces", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { lot, batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500")]));

    expect(lot).toMatchObject({ lotNumber: "L-1", status: "DRAFT" });
    expect(batch.status).toBe("DRAFT");

    const preview = await owner.send("post", "/api/v1/cutting-batches/preview", {
      fabricId,
      batchId: batch.id,
      cutting: draft(masterId, [black("30.500")]),
    });

    expect(preview.body.data.result.colours[0].rolls[0]).toMatchObject({
      estimatedPala: 14,
      pieces: 56,
      consumedKg: "29.820000",
      wastageKg: "0.680000",
    });
    expect(preview.body.data.result.marker.calculatedPalaKg).toBe("2.130000");
    expect(preview.body.data.stock).toMatchObject({ availableKg: "100.000000", toIssueKg: "30.500000", enough: true });

    const res = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`);

    expect(res.status).toBe(201);

    // SAFETY: the 201 above means the batch DTO was returned.
    const posted = res.body.data.batch as Batch;

    expect(posted.status).toBe("FINALIZED");
    expect(posted.posted).toMatchObject({ consumedKg: "29.82", wastageKg: "0.68", pala: 14, acceptedPieces: 56 });
    expect(posted.costs).toEqual({ fabricCost: "15250", earningAmount: "140" });
    expect(posted.outputs.map((o) => [o.sizeLabel, o.planned, o.available])).toEqual([
      ["S", 14, 14],
      ["M", 28, 28],
      ["L", 14, 14],
    ]);

    // Store: −30.5 once (issued), never again on finalize.
    expect(await balanceOf(owner, fabricId)).toBe(69.5);
    expect(await movements(batch.id)).toEqual([
      expect.objectContaining({ type: "ISSUE", from_state: "STORE", to_state: "CUTTING", quantity: "30.500000" }),
      expect.objectContaining({ type: "CONSUME", from_state: "CUTTING", to_state: "CONSUMED", quantity: "29.820000" }),
      expect.objectContaining({
        type: "WASTAGE",
        to_state: "WASTAGE",
        quantity: "0.680000",
        wastage_type: "AUTO_PALA_REMAINDER",
      }),
    ]);

    const detail = (await owner.get(`/api/v1/production-lots/${lot.id}`)).body.data.lot;

    expect(detail).toMatchObject({
      status: "ACTIVE",
      inCuttingKg: "0.000000",
      output: { accepted: 56, available: 56 },
    });
    expect(detail.costs.entries.map((c: { kind: string; amount: string }) => [c.kind, c.amount])).toEqual([
      ["FABRIC_CONSUMED", "14910.00"],
      ["FABRIC_WASTAGE", "340.00"],
      ["CUTTING_LABOUR", "140.00"],
    ]);
    expect(detail.history).toHaveLength(3);

    const { rows } = await sql("SELECT amount::text AS amount, type FROM karigar_ledger");

    expect(rows).toEqual([{ amount: "140.00", type: "EARNING" }]);
  });

  it("10: finalizing twice posts exactly once", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500")]));

    const [first, second] = await Promise.all([
      owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`),
      owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(await movements(batch.id)).toHaveLength(3);
    expect((await sql("SELECT count(*)::int AS n FROM lot_costs")).rows[0].n).toBe(3);
    expect((await sql("SELECT count(*)::int AS n FROM karigar_ledger")).rows[0].n).toBe(1);
    expect(await balanceOf(owner, fabricId)).toBe(69.5);
  });
});

describe("one request per action", () => {
  it("creates a lot with its cutting and issues or finalizes it in the same request", async () => {
    const { owner, fabricId, masterId } = await setup();
    const create = (action: string) =>
      owner.send("post", "/api/v1/production-lots", {
        lotNumber: `L-${(lotCounter += 1)}`,
        article: { name: "Polo T-Shirt" },
        fabricId,
        productionDate: today,
        cutting: draft(masterId, [black("10")]),
        action,
      });

    const issued = await create("issue");
    expect(issued.status).toBe(201);
    expect(issued.body.data.batch.status).toBe("ISSUED");
    expect(await balanceOf(owner, fabricId)).toBe(90);

    const finalized = await create("finalize");
    expect(finalized.body.data.batch.status).toBe("FINALIZED");
    expect(await balanceOf(owner, fabricId)).toBe(80);

    // A failed posting rolls the whole request back: no lot, no draft.
    const tooMuch = await owner.send("post", "/api/v1/production-lots", {
      lotNumber: "L-TOO-MUCH",
      article: { name: "Polo T-Shirt" },
      fabricId,
      productionDate: today,
      cutting: draft(masterId, [black("500")]),
      action: "issue",
    });
    expect(tooMuch.status).toBe(400);
    expect((await sql("SELECT count(*)::int AS n FROM production_lots WHERE lot_number = 'L-TOO-MUCH'")).rows[0].n).toBe(0);
  });

  it("saves edits and issues or finalizes them in the same request", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500")]));

    const issued = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/issue`, {
      cutting: draft(masterId, [black("10")]),
    });
    expect(issued.status).toBe(201);
    expect(issued.body.data.batch).toMatchObject({ status: "ISSUED" });
    expect(await balanceOf(owner, fabricId)).toBe(90);

    const colour = issued.body.data.batch.colours[0];
    const finalized = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`, {
      cutting: draft(masterId, [
        { id: colour.id, name: "Black", rolls: [{ id: colour.rolls[0].id, thaan: colour.rolls[0].thaan, issuedKg: "10", returnedKg: "1" }] },
      ]),
    });
    expect(finalized.status).toBe(201);
    expect(finalized.body.data.batch.status).toBe("FINALIZED");
    expect(await balanceOf(owner, fabricId)).toBe(91);
  });
});

describe("issue, returns and validation", () => {
  it("4: returned fabric goes back to the store, the rest of the remainder is wastage", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500", { returnedKg: "0.5" })]));
    const res = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`);

    expect(res.body.data.batch.posted).toMatchObject({ consumedKg: "29.82", wastageKg: "0.18" });
    expect(await balanceOf(owner, fabricId)).toBe(70);
  });

  it("issues fabric before cutting, keeps it as in-cutting stock and fixes issued Thaan", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { lot, batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500")]));
    const issued = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/issue`);

    expect(issued.status).toBe(201);
    expect(issued.body.data.batch.status).toBe("ISSUED");
    expect(await balanceOf(owner, fabricId)).toBe(69.5);
    expect((await owner.get(`/api/v1/production-lots/${lot.id}`)).body.data.lot.inCuttingKg).toBe("30.500000");
    expect((await owner.send("post", `/api/v1/cutting-batches/${batch.id}/issue`)).status).toBe(409);

    const colour = issued.body.data.batch.colours[0];

    const changed = draft(masterId, [
      { id: colour.id, name: "Black", rolls: [{ id: colour.rolls[0].id, thaan: "TH-001", issuedKg: "31" }] },
    ]);

    const edit = await owner.send("put", `/api/v1/cutting-batches/${batch.id}`, changed);

    expect(edit.status).toBe(400);
    expect(edit.body.error.details["colours.0.rolls.0.issuedKg"]).toBeDefined();

    const removed = await owner.send("put", `/api/v1/cutting-batches/${batch.id}`, draft(masterId, [black("10")]));

    expect(removed.status).toBe(400);
    expect((await owner.send("delete", `/api/v1/cutting-batches/${batch.id}`)).status).toBe(409);
  });

  it("rejects a return above the issue and bad repetitions with field messages", async () => {
    const { owner, fabricId, masterId } = await setup();
    const create = (cutting: CuttingBody) =>
      owner.send("post", "/api/v1/production-lots", {
        lotNumber: `L-${(lotCounter += 1)}`,
        article: { name: "Polo T-Shirt" },
        fabricId,
        productionDate: today,
        targetQuantity: 56,
        cutting,
      });

    const tooMuchBack = await create(draft(masterId, [black("5", { returnedKg: "6" })]));
    expect(tooMuchBack.status).toBe(400);
    expect(tooMuchBack.body.error.details["cutting.colours.0.rolls.0.returnedKg"][0]).toMatch(/more than the issued/);

    for (const repetitionsPerLayer of [0, 51]) {
      const body = draft(masterId, [black("10")]);
      const res = await create({ ...body, marker: { ...body.marker, repetitionsPerLayer } });
      expect(res.status).toBe(400);
      expect(res.body.error.details["cutting.marker.repetitionsPerLayer"][0]).toBe("Use a whole number from 1 to 50.");
    }
  });

  it("refuses to issue more than the store holds", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { batch } = await newProduction(owner, fabricId, draft(masterId, [black("120")]));
    const res = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/issue`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Only 100\.000 kg/);
    expect(await balanceOf(owner, fabricId)).toBe(100);
  });

  it("9: two batches racing for the last stock cannot both take it", async () => {
    const { owner, fabricId, masterId } = await setup();
    const a = await newProduction(owner, fabricId, draft(masterId, [black("60")]));
    const b = await newProduction(owner, fabricId, draft(masterId, [black("60")]));

    const results = await Promise.all([
      owner.send("post", `/api/v1/cutting-batches/${a.batch.id}/issue`),
      owner.send("post", `/api/v1/cutting-batches/${b.batch.id}/issue`),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await balanceOf(owner, fabricId)).toBe(40);
    expect(b.lot.lotNumber).toBe("L-2");
  });

  it("finalizes more Pala than the weight estimate, without a target, but never without a master", async () => {
    const { owner, fabricId, masterId } = await setup();
    // 30.5 kg at 2.13 kg fits 14 Pala; the cutter laid 15 on thinner fabric.
    const manual = await newProduction(
      owner,
      fabricId,
      draft(masterId, [black("30.500", { confirmedLayers: 15, note: "Thin fabric at the roll end" })]),
      {
        targetQuantity: null,
      },
    );
    const res = await owner.send("post", `/api/v1/cutting-batches/${manual.batch.id}/finalize`);

    expect(res.status).toBe(201);
    expect(res.body.data.batch.posted).toMatchObject({
      consumedKg: "30.5",
      wastageKg: "0",
      pala: 15,
      acceptedPieces: 60,
    });
    expect(res.body.data.batch.colours[0].rolls[0].note).toBe("Thin fabric at the roll end");
    expect(await balanceOf(owner, fabricId)).toBe(69.5);

    const noMaster = await newProduction(owner, fabricId, draft(null, [black("10")]));

    expect(
      (await owner.send("post", `/api/v1/cutting-batches/${noMaster.batch.id}/issue`)).body.error.details,
    ).toHaveProperty("cuttingMasterId");
  });

  it("numbers new Thaan itself and works out the return when none is entered", async () => {
    const { owner, fabricId, masterId } = await setup();

    const { batch } = await newProduction(
      owner,
      fabricId,
      draft(masterId, [{ name: "Black", rolls: [{ issuedKg: "30.5", confirmedLayers: 10 }, { issuedKg: "5" }] }]),
    );

    expect(batch.colours[0]!.rolls.map((roll) => roll.thaan)).toEqual(["1", "2"]);

    // A later save keeps those numbers and numbers the new Thaan after them.
    const colour = batch.colours[0]!;

    const saved = await owner.send(
      "put",
      `/api/v1/cutting-batches/${batch.id}`,
      draft(masterId, [
        {
          id: colour.id,
          name: "Black",
          rolls: [
            { id: colour.rolls[0]!.id, thaan: "1", issuedKg: "30.5", confirmedLayers: 10 },
            { id: colour.rolls[1]!.id, thaan: "2", issuedKg: "5" },
            { issuedKg: "2" },
          ],
        },
      ]),
    );

    expect(saved.status).toBe(200);
    expect(saved.body.data.batch.colours[0].rolls.map((roll: { thaan: string }) => roll.thaan)).toEqual([
      "1",
      "2",
      "3",
    ]);

    const res = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`);

    expect(res.status).toBe(201);

    // Thaan 1: 10 Pala use 21.3 kg of 30.5; 9.2 kg left: 4 Pala worth (8.52) back to store, 0.68 wasted.
    // Thaan 2: 2 Pala (4.26), 0.74 wasted. Thaan 3: under one Pala, all 2 kg wasted.
    const rolls = res.body.data.batch.colours[0].rolls as { returnedKg: string; wastageKg: string }[];

    expect(rolls.map((roll) => [roll.returnedKg, roll.wastageKg])).toEqual([
      ["8.52", "0.68"],
      ["0", "0.74"],
      ["0", "2"],
    ]);
    expect(await balanceOf(owner, fabricId)).toBe(100 - 37.5 + 8.52);
  });

  it("7: colours keep separate size output; a size with 0 pieces per Pala is left out", async () => {
    const { owner, fabricId, masterId } = await setup();

    const cutting = draft(masterId, [
      { name: "Black", rolls: [{ thaan: "TH-001", issuedKg: "30.5" }] },
      { name: "Blue", rolls: [{ thaan: "TH-002", issuedKg: "15" }] },
    ]);

    cutting.sizes = [
      { label: "S", piecesPerPala: 1 },
      { label: "M", piecesPerPala: 2 },
      { label: "L", piecesPerPala: 0 },
    ];

    const { batch } = await newProduction(owner, fabricId, cutting);

    // SAFETY: finalize answers with the batch DTO; the assertions below fail if it did not.
    const posted = (await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`)).body.data.batch as Batch;

    // Black 14 Pala and Blue 7 Pala, at 3 pieces per Pala.
    expect(posted.posted?.acceptedPieces).toBe(63);
    expect(posted.outputs.filter((o) => o.colourName === "Blue").map((o) => o.accepted)).toEqual([7, 14, 0]);
    expect(posted.outputs.find((o) => o.colourName === "Black" && o.sizeLabel === "M")).toMatchObject({
      planned: 28,
      accepted: 28,
    });
    expect(posted.outputs[0]).not.toHaveProperty("rejected");
  });

  it("refuses a ratio where every size is 0, and no longer takes rejected pieces", async () => {
    const { owner, fabricId, masterId } = await setup();
    const allZero = draft(masterId, [black("10")]);

    allZero.sizes = allZero.sizes.map((size) => ({ ...size, piecesPerPala: 0 }));

    const zero = await owner.send("post", "/api/v1/production-lots", {
      lotNumber: "L-ZERO",
      article: { name: "Polo T-Shirt" },
      fabricId,
      productionDate: today,
      targetQuantity: 56,
      cutting: allZero,
    });

    expect(zero.status).toBe(400);
    expect(zero.body.error.details).toHaveProperty(["cutting.sizes"]);

    const withRejects = draft(masterId, [
      { ...black("10"), rejects: [{ sizeLabel: "M", quantity: 1, reason: "Torn" }] } as ColourDraft,
    ]);
    const res = await owner.send("post", "/api/v1/production-lots", {
      lotNumber: "L-REJ",
      article: { name: "Polo T-Shirt" },
      fabricId,
      productionDate: today,
      targetQuantity: 56,
      cutting: withRejects,
    });

    expect(res.status).toBe(400);
  });
});

describe("reversal", () => {
  it("returns all fabric, reverses cost and earning, and keeps the history", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { lot, batch } = await newProduction(
      owner,
      fabricId,
      draft(masterId, [black("30.500", { returnedKg: "0.5" })]),
    );

    await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`);

    expect((await owner.send("post", `/api/v1/cutting-batches/${batch.id}/reverse`, { reason: "x" })).status).toBe(400);

    const res = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/reverse`, {
      reason: "Wrong marker used",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.batch).toMatchObject({ status: "REVERSED", reversal: { reason: "Wrong marker used" } });
    expect(res.body.data.batch.outputs.every((o: { available: number }) => o.available === 0)).toBe(true);
    expect(await balanceOf(owner, fabricId)).toBe(100);

    const sums = await sql(
      `SELECT (SELECT sum(amount)::text FROM lot_costs) AS costs, (SELECT sum(amount)::text FROM karigar_ledger) AS earned,
              (SELECT count(*)::int FROM cutting_movements) AS rows`,
    );

    expect(sums.rows[0]).toEqual({ costs: "0.00", earned: "0.00", rows: 7 });
    expect((await owner.get(`/api/v1/production-lots/${lot.id}`)).body.data.lot.inCuttingKg).toBe("0.000000");
    expect(
      (await owner.send("post", `/api/v1/cutting-batches/${batch.id}/reverse`, { reason: "Again please" })).status,
    ).toBe(409);
  });

  it("11: is blocked once cut pieces have gone downstream", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500")]));

    await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`);
    // Stitching is not built yet; simulate it drawing pieces down.
    await sql(
      "UPDATE cutting_outputs SET available_for_stitching = available_for_stitching - 2 WHERE size_label = 'M'",
    );

    const res = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/reverse`, { reason: "Wrong marker" });

    expect(res.status).toBe(409);
    expect(await balanceOf(owner, fabricId)).toBe(69.5);
  });

  it("keeps the cutting ledger append-only", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500")]));

    await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`);
    await expect(sql("UPDATE cutting_movements SET quantity = 1")).rejects.toThrow(/append-only/);
    await expect(sql("DELETE FROM lot_costs")).rejects.toThrow(/append-only/);
    await expect(sql("DELETE FROM karigar_ledger")).rejects.toThrow(/append-only/);
  });
});

describe("lots and articles", () => {
  it("adds cutting to an open lot typed again, ignoring case and spaces, and refuses a mismatch", async () => {
    const { owner, fabricId, masterId } = await setup();
    const first = await newProduction(owner, fabricId, draft(masterId, [black("10")]), { lotNumber: "LOT-45" });
    const second = await newProduction(owner, fabricId, draft(masterId, [black("5")]), { lotNumber: " lot-45 " });

    expect(second.lot.id).toBe(first.lot.id);
    expect(second.batch.id).not.toBe(first.batch.id);
    expect((await sql("SELECT count(*)::int AS n FROM production_lots")).rows[0].n).toBe(1);

    const otherId = await buyFabric(owner, "Rib", "KG", 10);

    const wrongFabric = await owner.send("post", "/api/v1/production-lots", {
      lotNumber: "LOT-45",
      article: { name: "Polo T-Shirt" },
      fabricId: otherId,
      productionDate: today,
    });

    expect(wrongFabric.status).toBe(400);
    expect(wrongFabric.body.error.details.fabricId).toBeDefined();

    const wrongItem = await owner.send("post", "/api/v1/production-lots", {
      lotNumber: "lot-45",
      article: { name: "Hoodie" },
      fabricId,
      productionDate: today,
    });

    expect(wrongItem.body.error.details.article).toBeDefined();
    expect(
      (await owner.send("post", "/api/v1/production-lots", { article: { name: "X" }, fabricId, productionDate: today }))
        .body.error.details.lotNumber,
    ).toBeDefined();
  });

  it("reuses an article whose name differs only by case or punctuation", async () => {
    const { owner, fabricId } = await setup();
    const first = await newProduction(owner, fabricId, draft(null, [black("1")]));

    const second = await owner.send("post", "/api/v1/production-lots", {
      lotNumber: "L-99",
      article: { name: "polo tshirt" },
      fabricId,
      productionDate: today,
    });

    expect(second.status).toBe(201);
    expect((await sql("SELECT count(*)::int AS n FROM articles")).rows[0].n).toBe(1);
    expect(second.body.data.lot.article.code).toBe("ART-0001");
    expect(first.lot.id).not.toBe(second.body.data.lot.id);

    // Items are managed through cutting only; there is no item master to post to.
    expect((await owner.send("post", "/api/v1/articles", { name: "POLO  T SHIRT" })).status).toBe(404);
  });

  it("only cuts fabric measured in kg", async () => {
    const { owner } = await setup();
    const metreId = await buyFabric(owner, "Denim", "METER", 10);

    const res = await owner.send("post", "/api/v1/production-lots", {
      lotNumber: "L-J1",
      article: { name: "Jeans" },
      fabricId: metreId,
      productionDate: today,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.details.fabricId).toBeDefined();
  });

  it("cancels a lot only while nothing has been issued", async () => {
    const { owner, fabricId, masterId } = await setup();
    const draftOnly = await newProduction(owner, fabricId, draft(masterId, [black("1")]));

    expect(
      (await owner.send("patch", `/api/v1/production-lots/${draftOnly.lot.id}`, { status: "CANCELLED" })).status,
    ).toBe(200);
    // Its draft goes with it, so it never sits in "open cutting" counts.
    expect(
      (await owner.send("put", `/api/v1/cutting-batches/${draftOnly.batch.id}`, draft(masterId, [black("2")]))).status,
    ).toBe(404);
    expect(
      (await sql("SELECT count(*)::int AS n FROM cutting_batches WHERE lot_id = $1", [draftOnly.lot.id])).rows[0].n,
    ).toBe(0);

    const issued = await newProduction(owner, fabricId, draft(masterId, [black("1")]));

    await owner.send("post", `/api/v1/cutting-batches/${issued.batch.id}/issue`);
    expect(
      (await owner.send("patch", `/api/v1/production-lots/${issued.lot.id}`, { status: "CANCELLED" })).status,
    ).toBe(409);
  });

  it("saves the marker and ratio as the article's default", async () => {
    const { owner, fabricId, masterId } = await setup();

    await newProduction(owner, fabricId, { ...draft(masterId, [black("1")]), saveAsDefault: true });

    const [article] = (await owner.get("/api/v1/articles/options")).body.data.articles;

    expect(article.defaultMarker).toMatchObject({
      measuredPalaKg: "2.130",
      sizes: [{ label: "S" }, { label: "M" }, { label: "L" }],
    });
  });
});

describe("permissions", () => {
  it("lets staff draft and issue but not finalize or reverse, and hides costs from them", async () => {
    const { owner, fabricId, masterId } = await setup();
    const staff = await loggedInClient("staff@garment.test");
    const viewer = await loggedInClient("viewer@garment.test");
    const { batch } = await newProduction(staff, fabricId, draft(masterId, [black("30.500")]));

    expect((await viewer.send("post", "/api/v1/production-lots", {})).status).toBe(403);
    expect((await staff.send("post", `/api/v1/cutting-batches/${batch.id}/issue`)).status).toBe(201);
    expect((await staff.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`)).status).toBe(403);
    expect((await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`)).status).toBe(201);
    expect((await staff.get(`/api/v1/cutting-batches/${batch.id}`)).body.data.batch.costs).toBeNull();
    expect((await staff.send("post", `/api/v1/cutting-batches/${batch.id}/reverse`, { reason: "Wrong" })).status).toBe(
      403,
    );

    const karigars = (await staff.get("/api/v1/karigars")).body.data.karigars;

    expect(karigars[0]).toMatchObject({ name: "Ram Bahadur", payRate: null, earned: null });
    expect((await staff.get("/api/v1/karigars?sort=earned&dir=desc")).status).toBe(200);
    expect((await staff.get("/api/v1/karigars?earnedMin=1")).status).toBe(403);
  });

  it("shows a karigar manager pay rates but not earnings, which need costing.view", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500")]));
    await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`);
    await createUser({ email: "supervisor@garment.test", role: "STITCHING_SUPERVISOR" });
    const supervisor = await loggedInClient("supervisor@garment.test");

    expect((await owner.get(`/api/v1/karigars/${masterId}`)).body.data.karigar.earned).toBeGreaterThan(0);
    const list = (await supervisor.get("/api/v1/karigars")).body.data.karigars;
    expect(list[0]).toMatchObject({ name: "Ram Bahadur", payRate: 2.5, earned: null });
    expect((await supervisor.get(`/api/v1/karigars/${masterId}`)).body.data.karigar).toMatchObject({
      payRate: 2.5,
      earned: null,
    });
    expect((await supervisor.get("/api/v1/karigars?earnedMin=1")).status).toBe(403);
    expect((await supervisor.get("/api/v1/karigars?payRateMin=1")).status).toBe(200);

    const edited = await supervisor.send("put", `/api/v1/karigars/${masterId}`, {
      name: "Ram Bahadur",
      category: "CUTTING_MASTER",
      payMode: "PER_PIECE",
      payRate: 3,
    });
    expect(edited.body.data.karigar).toMatchObject({ payRate: 3, earned: null });
  });
});
