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

async function setup() {
  await createUser({ email: "owner@garment.test", role: "OWNER", name: "Olivia Owner" });
  await createUser({ email: "staff@garment.test", role: "STAFF" });
  await createUser({ email: "viewer@garment.test", role: "VIEWER" });

  const owner = await loggedInClient("owner@garment.test");
  const fabric = await owner.send("post", "/api/v1/fabrics", { code: "FB-CTJ", name: "Cotton Jersey", unit: "KG" });

  expect(fabric.status).toBe(201);

  // SAFETY: supertest bodies are untyped; the 201 above means the fabric DTO was returned.
  const fabricId = fabric.body.data.fabric.id as string;
  const inward = await owner.send("post", "/api/v1/fabrics/inwards", { fabricId, inwardDate: today, quantity: 100, rate: 500 });

  expect(inward.status).toBe(201);

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
  thaan: string;
  issuedKg: string;
  returnedKg?: string;
  confirmedLayers?: number;
}

interface ColourDraft {
  id?: string;
  name: string;
  rolls: RollDraft[];
  rejects?: { sizeLabel: string; quantity: number; reason: string }[];
}

function draft(masterId: string | null, colours: ColourDraft[], palaKg = "2.130") {
  return {
    cuttingMasterId: masterId,
    cuttingDate: today,
    marker: { measuredPalaKg: palaKg, weightSource: "MEASURED", repetitionsPerLayer: 1, widthM: "1.5", lengthM: "7.1", gsm: "200" },
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
  return rows as { type: string; from_state: string; to_state: string; quantity: string; wastage_type: string | null }[];
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
      expect.objectContaining({ type: "WASTAGE", to_state: "WASTAGE", quantity: "0.680000", wastage_type: "AUTO_PALA_REMAINDER" }),
    ]);

    const detail = (await owner.get(`/api/v1/production-lots/${lot.id}`)).body.data.lot;

    expect(detail).toMatchObject({ status: "ACTIVE", inCuttingKg: "0.000000", output: { accepted: 56, available: 56 } });
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

  it("blocks finalizing with more Pala than the Thaan can give, without a target or without a master", async () => {
    const { owner, fabricId, masterId } = await setup();
    const tooMany = await newProduction(owner, fabricId, draft(masterId, [black("30.500", { confirmedLayers: 15 })]));
    const res = await owner.send("post", `/api/v1/cutting-batches/${tooMany.batch.id}/finalize`);

    expect(res.status).toBe(400);
    expect(res.body.error.details["colours.0.rolls.0.confirmedLayers"]).toBeDefined();
    expect(await balanceOf(owner, fabricId)).toBe(100);

    const noTarget = await newProduction(owner, fabricId, draft(masterId, [black("10")]), { targetQuantity: null });

    expect((await owner.send("post", `/api/v1/cutting-batches/${noTarget.batch.id}/finalize`)).body.error.details).toHaveProperty(
      "targetQuantity",
    );

    const noMaster = await newProduction(owner, fabricId, draft(null, [black("10")]));

    expect((await owner.send("post", `/api/v1/cutting-batches/${noMaster.batch.id}/issue`)).body.error.details).toHaveProperty(
      "cuttingMasterId",
    );
  });

  it("7: colours keep separate size output and rejects reduce accepted pieces", async () => {
    const { owner, fabricId, masterId } = await setup();

    const { batch } = await newProduction(
      owner,
      fabricId,
      draft(masterId, [
        { name: "Black", rolls: [{ thaan: "TH-001", issuedKg: "30.5" }], rejects: [{ sizeLabel: "M", quantity: 1, reason: "Torn" }] },
        { name: "Blue", rolls: [{ thaan: "TH-002", issuedKg: "15" }] },
      ]),
    );

    // SAFETY: finalize answers with the batch DTO; the assertions below fail if it did not.
    const posted = (await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`)).body.data.batch as Batch;

    expect(posted.posted?.acceptedPieces).toBe(83);
    expect(posted.outputs.filter((o) => o.colourName === "Blue").map((o) => o.accepted)).toEqual([7, 14, 7]);
    expect(posted.outputs.find((o) => o.colourName === "Black" && o.sizeLabel === "M")).toMatchObject({
      planned: 28,
      accepted: 27,
    });
  });
});

describe("reversal", () => {
  it("returns all fabric, reverses cost and earning, and keeps the history", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { lot, batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500", { returnedKg: "0.5" })]));

    await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`);

    expect((await owner.send("post", `/api/v1/cutting-batches/${batch.id}/reverse`, { reason: "x" })).status).toBe(400);

    const res = await owner.send("post", `/api/v1/cutting-batches/${batch.id}/reverse`, { reason: "Wrong marker used" });

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
    expect((await owner.send("post", `/api/v1/cutting-batches/${batch.id}/reverse`, { reason: "Again please" })).status).toBe(409);
  });

  it("11: is blocked once cut pieces have gone downstream", async () => {
    const { owner, fabricId, masterId } = await setup();
    const { batch } = await newProduction(owner, fabricId, draft(masterId, [black("30.500")]));

    await owner.send("post", `/api/v1/cutting-batches/${batch.id}/finalize`);
    // Stitching is not built yet; simulate it drawing pieces down.
    await sql("UPDATE cutting_outputs SET available_for_stitching = available_for_stitching - 2 WHERE size_label = 'M'");

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

    const other = await owner.send("post", "/api/v1/fabrics", { code: "FB-RIB", name: "Rib", unit: "KG" });

    const wrongFabric = await owner.send("post", "/api/v1/production-lots", {
      lotNumber: "LOT-45",
      article: { name: "Polo T-Shirt" },
      fabricId: other.body.data.fabric.id,
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
    expect((await owner.send("post", "/api/v1/production-lots", { article: { name: "X" }, fabricId, productionDate: today })).body
      .error.details.lotNumber).toBeDefined();
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

    const dup = await owner.send("post", "/api/v1/articles", { name: "POLO  T SHIRT" });

    expect(dup.status).toBe(409);
    expect(dup.body.error.details.name).toBeDefined();
  });

  it("only cuts fabric measured in kg", async () => {
    const { owner } = await setup();
    const metre = await owner.send("post", "/api/v1/fabrics", { code: "FB-DNM", name: "Denim", unit: "METER" });

    const res = await owner.send("post", "/api/v1/production-lots", {
      lotNumber: "L-J1",
      article: { name: "Jeans" },
      fabricId: metre.body.data.fabric.id,
      productionDate: today,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.details.fabricId).toBeDefined();
  });

  it("cancels a lot only while nothing has been issued", async () => {
    const { owner, fabricId, masterId } = await setup();
    const draftOnly = await newProduction(owner, fabricId, draft(masterId, [black("1")]));

    expect((await owner.send("patch", `/api/v1/production-lots/${draftOnly.lot.id}`, { status: "CANCELLED" })).status).toBe(200);
    expect((await owner.send("put", `/api/v1/cutting-batches/${draftOnly.batch.id}`, draft(masterId, [black("2")]))).status).toBe(409);

    const issued = await newProduction(owner, fabricId, draft(masterId, [black("1")]));

    await owner.send("post", `/api/v1/cutting-batches/${issued.batch.id}/issue`);
    expect((await owner.send("patch", `/api/v1/production-lots/${issued.lot.id}`, { status: "CANCELLED" })).status).toBe(409);
  });

  it("saves the marker and ratio as the article's default", async () => {
    const { owner, fabricId, masterId } = await setup();

    await newProduction(owner, fabricId, { ...draft(masterId, [black("1")]), saveAsDefault: true });

    const [article] = (await owner.get("/api/v1/articles/options")).body.data.articles;

    expect(article.defaultMarker).toMatchObject({ measuredPalaKg: "2.130", sizes: [{ label: "S" }, { label: "M" }, { label: "L" }] });
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
    expect((await staff.send("post", `/api/v1/cutting-batches/${batch.id}/reverse`, { reason: "Wrong" })).status).toBe(403);

    const karigars = (await staff.get("/api/v1/karigars")).body.data.karigars;

    expect(karigars[0]).toMatchObject({ name: "Ram Bahadur", payRate: null, earned: null });
    expect((await staff.get("/api/v1/karigars?sort=earned&dir=desc")).status).toBe(200);
    expect((await staff.get("/api/v1/karigars?earnedMin=1")).status).toBe(403);
  });
});
