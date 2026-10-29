import { beforeEach, describe, expect, it } from "vitest";

import { createUser, loggedInClient, resetDatabase, sql, type TestClient } from "../../test/helpers";

beforeEach(resetDatabase);

const today = new Date().toISOString().slice(0, 10);

async function setup() {
  await createUser({ email: "owner@garment.test", role: "OWNER", name: "Olivia Owner" });
  await createUser({ email: "staff@garment.test", role: "STAFF" });
  await createUser({ email: "viewer@garment.test", role: "VIEWER" });
  const owner = await loggedInClient("owner@garment.test");
  return { owner };
}

interface Fabric {
  id: string;
  code: string;
  name: string;
  unit: "KG" | "METER";
}

/** A fabric with no stock yet. In the app fabrics come from their first purchase. */
async function createFabric(
  overrides: { name?: string; unit?: "KG" | "METER"; lowStockThreshold?: number | null; description?: string } = {},
) {
  const fabric = { name: "Cotton Jersey", unit: "KG", lowStockThreshold: 50, description: null, ...overrides };
  const { rows } = await sql(
    `INSERT INTO fabrics (name, unit, low_stock_threshold, description) VALUES ($1, $2, $3, $4)
     RETURNING id::text, code, name, unit`,
    [fabric.name, fabric.unit, fabric.lowStockThreshold, fabric.description],
  );
  return rows[0] as Fabric;
}

async function postInward(client: TestClient, fabric: Fabric, quantity: number, rate: number, extra: object = {}) {
  const res = await client.send("post", "/api/v1/fabrics/inwards", {
    fabricName: fabric.name,
    unit: fabric.unit,
    inwardDate: today,
    quantity,
    rate,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.data.inward as { id: string; number: number; amount: number; fabric: Fabric };
}

async function fabricOf(client: TestClient, id: string) {
  return (await client.get(`/api/v1/fabrics/${id}`)).body.data.fabric as {
    lowStockThreshold: number | null;
    description: string | null;
    balance: number;
    avgRate: number | null;
    stockValue: number;
  };
}

describe("fabrics from purchases", () => {
  const buy = (client: TestClient, body: object) =>
    client.send("post", "/api/v1/fabrics/inwards", { inwardDate: today, quantity: 10, rate: 100, ...body });

  it("creates a fabric with a generated code, then adds later purchases of that name to it", async () => {
    const { owner } = await setup();
    const first = await buy(owner, { fabricName: "  Cotton   Jersey ", unit: "KG", lowStockThreshold: 25 });
    expect(first.status).toBe(201);
    const fabric = first.body.data.inward.fabric as Fabric;
    expect(fabric).toMatchObject({ code: "FAB-0001", name: "Cotton Jersey", unit: "KG" });

    // Same name in any case: same fabric, same code; the reorder level stays unless sent.
    const again = await buy(owner, { fabricName: "cotton jersey", unit: "KG", quantity: 5 });
    expect(again.body.data.inward.fabric).toMatchObject({ id: fabric.id, code: "FAB-0001" });
    expect(await fabricOf(owner, fabric.id)).toMatchObject({ balance: 15, lowStockThreshold: 25 });

    await buy(owner, { fabricName: "Cotton Jersey", unit: "KG", lowStockThreshold: 40, description: "Knit, 180 GSM" });
    expect(await fabricOf(owner, fabric.id)).toMatchObject({ lowStockThreshold: 40, description: "Knit, 180 GSM" });

    const other = await buy(owner, { fabricName: "Poplin", unit: "METER" });
    expect(other.body.data.inward.fabric.code).toBe("FAB-0002");
  });

  it("refuses a different unit for an existing fabric, with a field error", async () => {
    const { owner } = await setup();
    await buy(owner, { fabricName: "Cotton Jersey", unit: "KG" });
    const res = await buy(owner, { fabricName: "COTTON JERSEY", unit: "METER" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.unit[0]).toMatch(/bought in kilograms/);
    expect((await buy(owner, { unit: "KG" })).body.error.details.fabricName).toBeDefined();
  });

  it("gives simultaneous first purchases of one name a single fabric and unique codes", async () => {
    const { owner } = await setup();
    const results = await Promise.all([
      buy(owner, { fabricName: "Rib", unit: "KG" }),
      buy(owner, { fabricName: "rib", unit: "KG" }),
      buy(owner, { fabricName: "Lycra", unit: "KG" }),
      buy(owner, { fabricName: "Denim", unit: "METER" }),
    ]);
    expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201]);
    // SAFETY: the SELECT list defines exactly these columns.
    const rows = (await sql("SELECT lower(name) AS name, code FROM fabrics ORDER BY code")).rows as Record<
      string,
      string
    >[];
    expect(rows.map((row) => row.name).sort()).toEqual(["denim", "lycra", "rib"]);
    expect(new Set(rows.map((row) => row.code)).size).toBe(3);
  });

  it("continues codes after existing FAB numbers and never truncates them", async () => {
    const { owner } = await setup();
    await createFabric({ name: "Old" });
    await sql("UPDATE fabrics SET code = 'FAB-9999'");
    await sql("SELECT setval('fabric_code_seq', 9999)");
    const res = await buy(owner, { fabricName: "New", unit: "KG" });
    expect(res.body.data.inward.fabric.code).toBe("FAB-10000");
  });

  it("fixes a fabric's name and details, but not a duplicate name or the unit once stocked", async () => {
    const { owner } = await setup();
    const typo = await createFabric({ name: "Coton Jersy" });
    const other = await createFabric({ name: "Rib", unit: "METER" });
    const put = (id: string, body: object) =>
      owner.send("put", `/api/v1/fabrics/${id}`, { name: "Cotton Jersey", unit: "KG", ...body });

    const fixed = await put(typo.id, { lowStockThreshold: 30, description: "Knit" });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.fabric).toMatchObject({ code: typo.code, name: "Cotton Jersey", lowStockThreshold: 30 });
    // Purchases of the corrected name now add to it.
    expect((await postInward(owner, { ...typo, name: "cotton jersey" }, 5, 10)).fabric.id).toBe(typo.id);

    const duplicate = await put(other.id, { name: "COTTON JERSEY", unit: "METER" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details.name).toBeDefined();

    expect((await put(other.id, { name: "Rib", unit: "KG" })).status).toBe(200);
    const locked = await put(typo.id, { unit: "METER" });
    expect(locked.status).toBe(400);
    expect(locked.body.error.details.unit).toBeDefined();
    expect((await put(typo.id, { code: "X" })).status).toBe(400);
  });

  it("enforces fabric permissions per role", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    const staff = await loggedInClient("staff@garment.test");
    const viewer = await loggedInClient("viewer@garment.test");

    expect((await viewer.get("/api/v1/fabrics")).status).toBe(200);
    expect((await buy(viewer, { fabricName: "X", unit: "KG" })).status).toBe(403);
    expect((await staff.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {})).status).toBe(403);
    await postInward(staff, fabric, 5, 10);
    expect((await owner.send("post", "/api/v1/fabrics", { name: "X", unit: "KG" })).status).toBe(404);
    expect((await staff.send("put", `/api/v1/fabrics/${fabric.id}`, { name: "X", unit: "KG" })).status).toBe(403);
  });

  it("hides rates, amounts and stock value from roles without costing.view", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    const inward = await postInward(owner, fabric, 10, 400);
    await postInward(owner, fabric, 5, 100);
    const staff = await loggedInClient("staff@garment.test");
    const viewer = await loggedInClient("viewer@garment.test");

    const ownList = (await owner.get("/api/v1/fabrics/inwards")).body.data;
    expect(ownList.totalAmount).toBe(4_500);
    expect(ownList.inwards[0].amount).toBeGreaterThan(0);

    for (const client of [staff, viewer]) {
      const list = (await client.get("/api/v1/fabrics")).body.data;
      expect(list.summary.stockValue).toBeNull();
      expect(list.fabrics[0]).toMatchObject({ balance: 15, avgRate: null, stockValue: null });
      expect((await client.get(`/api/v1/fabrics/${fabric.id}`)).body.data.fabric).toMatchObject({
        avgRate: null,
        stockValue: null,
      });

      const inwards = (await client.get("/api/v1/fabrics/inwards")).body.data;
      expect(inwards.totalAmount).toBeNull();
      expect(inwards.inwards[0]).toMatchObject({ quantity: expect.any(Number), rate: null, amount: null });

      // Money filters and sorts would leak values by elimination, so they are ignored.
      expect((await client.get("/api/v1/fabrics/inwards?amountMin=4000")).body.data.total).toBe(2);
      expect((await client.get("/api/v1/fabrics?stockValueMin=1000000")).body.data.total).toBe(1);

      const csv = (await client.get("/api/v1/fabrics/inwards/export")).text;
      expect(csv.split("\r\n")[0]).not.toMatch(/Rate|Amount/);
      expect(csv).not.toContain("4000");
    }

    // Staff may add purchases; the response does not echo stock value either.
    const posted = await staff.send("post", "/api/v1/fabrics/inwards", {
      fabricName: fabric.name,
      unit: fabric.unit,
      inwardDate: today,
      quantity: 1,
      rate: 50,
    });
    expect(posted.status).toBe(201);
    expect(posted.body.data.inward).toMatchObject({ rate: null, amount: null });
    const reversed = await owner.send("post", `/api/v1/fabrics/inwards/${inward.id}/reverse`, { reason: "wrong rate" });
    expect(reversed.body.data.inward.amount).toBe(4_000);
  });
});

describe("fabric list", () => {
  it("filters, searches and pages on the server with workspace-wide summary figures", async () => {
    const { owner } = await setup();
    const low = await createFabric({ name: "Interlock", lowStockThreshold: 50 });
    await postInward(owner, low, 20, 100);
    const ok = await createFabric({ name: "Poplin", unit: "METER" });
    await postInward(owner, ok, 300, 10);
    await createFabric({ name: "Corduroy" });

    const all = (await owner.get("/api/v1/fabrics")).body.data;
    expect(all.total).toBe(3);
    expect(all.summary).toEqual({ stockValue: 5_000, fabrics: 3, inStock: 2, reorder: 2 });

    const page2 = (await owner.get("/api/v1/fabrics?pageSize=2&page=2")).body.data;
    expect(page2.total).toBe(3);
    expect(page2.fabrics.map((f: { name: string }) => f.name)).toEqual(["Poplin"]);

    const search = (await owner.get("/api/v1/fabrics?search=popl")).body.data;
    expect(search.fabrics.map((f: { name: string }) => f.name)).toEqual(["Poplin"]);
    const literal = (await owner.get("/api/v1/fabrics?search=%25")).body.data;
    expect(literal.total).toBe(0);

    const reorder = (await owner.get("/api/v1/fabrics?stock=low")).body.data;
    expect(reorder.fabrics.map((f: { name: string }) => f.name)).toEqual(["Corduroy", "Interlock"]);
    expect((await owner.get("/api/v1/fabrics?stock=out")).body.data.total).toBe(1);
    expect((await owner.get("/api/v1/fabrics?pageSize=500")).status).toBe(400);

    const options = (await owner.get("/api/v1/fabrics/options")).body.data.fabrics;
    expect(options).toHaveLength(3);
    expect(options[0]).toEqual({
      id: expect.any(String),
      code: expect.stringMatching(/^FAB-\d{4}$/),
      name: "Corduroy",
      unit: "KG",
      balance: 0,
      lowStockThreshold: 50,
      description: null,
    });
  });

  it("finds purchases by register number", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    await postInward(owner, fabric, 1, 1);
    const second = await postInward(owner, fabric, 2, 1);
    for (const term of [`FI-${String(second.number).padStart(4, "0")}`, `fi${second.number}`]) {
      const res = (await owner.get(`/api/v1/fabrics/inwards?search=${term}`)).body.data;
      expect(res.inwards.map((i: { id: string }) => i.id)).toEqual([second.id]);
    }
  });
});

describe("column filters, sorting and export", () => {
  async function seed(owner: TestClient) {
    const a = await createFabric({ name: "Alpha Knit", lowStockThreshold: 10 });
    const b = await createFabric({ name: "Beta Woven", unit: "METER" });
    const c = await createFabric({ name: "Gamma", description: "=SUM(1)" });
    await postInward(owner, a, 100, 10, { inwardDate: "2026-01-05", supplier: "Sunrise Knits" });
    await postInward(owner, b, 40, 50, {
      inwardDate: "2026-02-10",
      supplier: "Nepal Fabrics",
      invoiceRef: "INV-77",
    });
    await postInward(owner, c, 5, 200, { inwardDate: "2026-03-15", supplier: "=HYPERLINK(1)" });
    return { a, b, c };
  }

  it("filters and sorts each list by whitelisted columns only", async () => {
    const { owner } = await setup();
    await seed(owner);

    const names = async (url: string) =>
      (await owner.get(url)).body.data.fabrics.map((f: { name: string }) => f.name) as string[];
    expect(await names("/api/v1/fabrics?sort=balance&dir=desc")).toEqual(["Alpha Knit", "Beta Woven", "Gamma"]);
    expect(await names("/api/v1/fabrics?balanceMin=6&balanceMax=50")).toEqual(["Beta Woven"]);
    expect(await names("/api/v1/fabrics?fabric=gam")).toEqual(["Gamma"]);
    expect(await names("/api/v1/fabrics?stockValueMin=2000&sort=stockValue&dir=asc")).toEqual(["Beta Woven"]);

    const inwards = async (url: string) =>
      (await owner.get(url)).body.data.inwards.map((i: { supplier: string }) => i.supplier) as string[];
    expect(await inwards("/api/v1/fabrics/inwards?supplier=inv-77")).toEqual(["Nepal Fabrics"]);
    expect(await inwards("/api/v1/fabrics/inwards?dateFrom=2026-02-01&dateTo=2026-02-28")).toEqual(["Nepal Fabrics"]);
    expect(await inwards("/api/v1/fabrics/inwards?amountMin=1000&sort=amount&dir=desc")).toEqual([
      "Nepal Fabrics",
      "=HYPERLINK(1)",
      "Sunrise Knits",
    ]);
    expect(await inwards("/api/v1/fabrics/inwards?amountMin=1500")).toEqual(["Nepal Fabrics"]);

    const ledger = (await owner.get("/api/v1/fabrics/movements?type=PURCHASE_IN&sort=qtyIn&dir=asc")).body.data;
    expect(ledger.movements.map((m: { qtyIn: number }) => m.qtyIn)).toEqual([5, 40, 100]);
    expect(ledger.movements.map((m: { balance: number }) => m.balance)).toEqual([5, 40, 100]);

    // Anything outside the declared columns is rejected, never interpolated.
    for (const bad of ["sort=f.name;drop", "stock=NOPE", "balanceMin=abc", "dateFrom=yesterday", "dir=sideways"]) {
      const target = bad.startsWith("date") ? "/api/v1/fabrics/inwards" : "/api/v1/fabrics";
      expect((await owner.get(`${target}?${bad}`)).status).toBe(400);
    }
  });

  it("exports the filtered rows as CSV and neutralises spreadsheet formulas", async () => {
    const { owner } = await setup();
    await seed(owner);
    const res = await owner.get("/api/v1/fabrics/inwards/export?amountMin=1000&dateFrom=2026-02-01");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/fabric-purchases-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = res.text.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^No\.,Date,Fabric code/);
    expect(res.text).toContain("'=HYPERLINK(1)");
    expect((await owner.get("/api/v1/fabrics/movements/export")).status).toBe(200);
  });
});

describe("purchases and stock ledger", () => {
  it("derives balance, weighted rate and value from posted purchases", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    const first = await postInward(owner, fabric, 100, 400, { supplier: "Sunrise Knits" });
    await postInward(owner, fabric, 50, 520);
    expect(first.amount).toBe(40_000);

    expect(await fabricOf(owner, fabric.id)).toMatchObject({ balance: 150, avgRate: 440, stockValue: 66_000 });

    const list = await owner.get("/api/v1/fabrics/inwards?search=sunrise");
    expect(list.body.data).toMatchObject({ total: 1, totalAmount: 40_000, totalQuantity: { KG: 100 } });
    expect(list.body.data.inwards[0]).not.toHaveProperty("color");
    expect((await owner.get("/api/v1/fabrics/inwards/suppliers")).body.data.suppliers).toEqual(["Sunrise Knits"]);
  });

  it("rejects purchases with a future date", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    const future = await owner.send("post", "/api/v1/fabrics/inwards", {
      fabricName: fabric.name,
      unit: fabric.unit,
      inwardDate: "2999-01-01",
      quantity: 1,
      rate: 1,
    });
    expect(future.status).toBe(400);
    expect(future.body.error.details.inwardDate).toBeDefined();

    // "Today" is the factory's day in Nepal, with no extra day of slack.
    const nepal = (offsetDays: number) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(Date.now() + offsetDays * 86_400_000);
    const post = (inwardDate: string) =>
      owner.send("post", "/api/v1/fabrics/inwards", {
        fabricName: fabric.name,
        unit: fabric.unit,
        inwardDate,
        quantity: 1,
        rate: 1,
      });
    expect((await post(nepal(1))).status).toBe(400);
    expect((await post(nepal(0))).status).toBe(201);
  });

  it("rejects quantities and rates with more decimals than are stored, and amounts too large to store", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    const post = (quantity: number, rate: number) =>
      owner.send("post", "/api/v1/fabrics/inwards", {
        fabricName: fabric.name,
        unit: fabric.unit,
        inwardDate: today,
        quantity,
        rate,
      });

    const qty = await post(1.2345, 10);
    expect(qty.status).toBe(400);
    expect(qty.body.error.details.quantity[0]).toMatch(/3 decimals/);
    expect((await post(0.0004, 10)).body.error.details.quantity).toBeDefined();
    const rate = await post(1, 2.345);
    expect(rate.status).toBe(400);
    expect(rate.body.error.details.rate[0]).toMatch(/2 decimals/);

    const before = await post(1, 1);
    const overflow = await post(999_999_999, 99_999_999);
    expect(overflow.status).toBe(400);
    expect(overflow.body.error.details.rate[0]).toMatch(/too large/);

    // Floats that are exact at the stored precision still pass, and no register number was burned.
    const ok = await post(125.375, 412.5);
    expect(ok.status).toBe(201);
    expect(ok.body.data.inward).toMatchObject({
      number: Number(before.body.data.inward.number) + 1,
      quantity: 125.375,
      rate: 412.5,
      amount: 51_717.19,
    });
    expect((await post(0.1, 0.29)).status).toBe(201);

    const adjust = await owner.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {
      direction: "OUT",
      quantity: 1.0005,
      reason: "Count",
    });
    expect(adjust.status).toBe(400);
    expect(adjust.body.error.details.quantity[0]).toMatch(/3 decimals/);
  });

  it("never lets an adjustment or reversal drive stock negative", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    const inward = await postInward(owner, fabric, 100, 400);

    const tooMuch = await owner.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {
      direction: "OUT",
      quantity: 101,
      reason: "Count",
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.details.quantity).toBeDefined();

    const adjust = await owner.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {
      direction: "OUT",
      quantity: 30,
      reason: "Physical count after godown audit",
    });
    expect(adjust.status).toBe(201);

    const blocked = await owner.send("post", `/api/v1/fabrics/inwards/${inward.id}/reverse`, {
      reason: "Wrong fabric",
    });
    expect(blocked.status).toBe(409);

    await owner.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {
      direction: "IN",
      quantity: 30,
      reason: "Found in rack B",
    });
    const reversed = await owner.send("post", `/api/v1/fabrics/inwards/${inward.id}/reverse`, {
      reason: "Wrong fabric",
    });
    expect(reversed.status).toBe(200);
    expect(reversed.body.data.inward.reversal.reason).toBe("Wrong fabric");
    expect((await owner.send("post", `/api/v1/fabrics/inwards/${inward.id}/reverse`, { reason: "Again" })).status).toBe(
      409,
    );

    expect(await fabricOf(owner, fabric.id)).toMatchObject({ balance: 0, avgRate: null });

    const totals = (await owner.get("/api/v1/fabrics/inwards")).body.data;
    expect(totals).toMatchObject({ total: 1, totalAmount: 0 });

    // A reduction racing a reversal for the last stock: one wins, the other gets a clear 4xx, never a 500.
    for (let round = 0; round < 5; round += 1) {
      const last = await postInward(owner, fabric, 1, 10);
      const [cut, back] = await Promise.all([
        owner.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {
          direction: "OUT",
          quantity: 1,
          reason: "Count",
        }),
        owner.send("post", `/api/v1/fabrics/inwards/${last.id}/reverse`, { reason: "Wrong fabric" }),
      ]);
      expect([cut.status, back.status].sort()).toEqual(cut.status === 201 ? [201, 409] : [200, 400]);
      expect((await fabricOf(owner, fabric.id)).balance).toBe(0);
    }
  });

  it("returns newest-first movements with running balances and a period summary", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    await postInward(owner, fabric, 100, 400, { inwardDate: "2026-01-10" });
    await postInward(owner, fabric, 20, 400, { inwardDate: "2026-02-10" });
    await owner.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {
      direction: "OUT",
      quantity: 5,
      reason: "Damaged",
    });

    const all = (await owner.get(`/api/v1/fabrics/movements?fabricId=${fabric.id}`)).body.data;
    expect(all.movements.map((m: { type: string; balance: number }) => [m.type, m.balance])).toEqual([
      ["ADJUSTMENT_OUT", 115],
      ["PURCHASE_IN", 120],
      ["PURCHASE_IN", 100],
    ]);
    expect(all.summary).toEqual({ opening: 0, totalIn: 120, totalOut: 5, closing: 115 });
    expect(all.byUnit).toEqual({ KG: { in: 120, out: 5 } });

    const feb = (
      await owner.get(`/api/v1/fabrics/movements?fabricId=${fabric.id}&dateFrom=2026-02-01&dateTo=2026-02-28`)
    ).body.data;
    expect(feb.total).toBe(1);
    expect(feb.byUnit).toEqual({ KG: { in: 20, out: 0 } });

    // Across fabrics, kilograms and metres are totalled separately.
    const meters = await createFabric({ name: "Satin", unit: "METER" });
    await postInward(owner, meters, 40, 90, { inwardDate: "2026-02-12" });
    const everything = (await owner.get("/api/v1/fabrics/movements")).body.data;
    expect(everything.total).toBe(4);
    expect(everything.summary).toBeNull();
    expect(everything.byUnit).toEqual({ KG: { in: 120, out: 5 }, METER: { in: 40, out: 0 } });
    expect(feb.summary).toEqual({ opening: 100, totalIn: 20, totalOut: 0, closing: 120 });
  });

  it("orders the ledger by business date, so a backdated purchase gets the right running balance", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    await postInward(owner, fabric, 10, 1, { inwardDate: "2026-03-01" });
    await postInward(owner, fabric, 5, 1, { inwardDate: "2026-01-01" });
    const rows = (await owner.get(`/api/v1/fabrics/movements?fabricId=${fabric.id}`)).body.data.movements;
    expect(rows.map((m: { date: string; balance: number }) => [m.date, m.balance])).toEqual([
      ["2026-03-01", 15],
      ["2026-01-01", 5],
    ]);
  });

  it("keeps the stock projection equal to the ledger sum", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    const inward = await postInward(owner, fabric, 40, 100);
    await owner.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {
      direction: "OUT",
      quantity: 15,
      reason: "Damaged",
    });
    await owner.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {
      direction: "IN",
      quantity: 5,
      reason: "Found",
    });
    await postInward(owner, fabric, 30, 100);
    await owner.send("post", `/api/v1/fabrics/inwards/${inward.id}/reverse`, { reason: "Wrong fabric" });
    const { rows } = await sql(
      `SELECT s.balance AS projected, s.purchased_qty AS purchased,
              (SELECT sum(qty_in - qty_out) FROM fabric_movements WHERE fabric_id = $1) AS ledger
       FROM fabric_stock s WHERE s.fabric_id = $1`,
      [fabric.id],
    );
    expect(Number(rows[0]!.projected)).toBe(Number(rows[0]!.ledger));
    expect(Number(rows[0]!.projected)).toBe(20);
    expect(Number(rows[0]!.purchased)).toBe(30);
    await expect(sql("UPDATE fabric_stock SET balance = -1 WHERE fabric_id = $1", [fabric.id])).rejects.toThrow(
      /check/i,
    );
  });

  it("rejects colour or roll on purchases and adjustments", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();

    const purchase = await owner.send("post", "/api/v1/fabrics/inwards", {
      fabricName: fabric.name,
      unit: fabric.unit,
      inwardDate: "2026-01-05",
      quantity: 1,
      rate: 1,
      rollRef: "R-001",
    });

    expect(purchase.status).toBe(400);

    const res = await owner.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {
      direction: "IN",
      quantity: 1,
      reason: "Count",
      color: "Red",
    });
    expect(res.status).toBe(400);
  });

  it("keeps the ledger append-only at the database level", async () => {
    const { owner } = await setup();
    const fabric = await createFabric();
    await postInward(owner, fabric, 10, 1);
    await expect(sql("UPDATE fabric_movements SET qty_in = 999")).rejects.toThrow(/append-only/);
    await expect(sql("DELETE FROM fabric_movements")).rejects.toThrow(/append-only/);
  });
});
