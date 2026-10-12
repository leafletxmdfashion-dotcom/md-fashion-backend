import { beforeEach, describe, expect, it } from "vitest";

import { pool } from "../../db/pool";
import { createUser, loggedInClient, resetDatabase, type TestClient } from "../../test/helpers";

beforeEach(resetDatabase);

const today = new Date().toISOString().slice(0, 10);

async function setup() {
  await createUser({ email: "owner@garment.test", role: "OWNER", name: "Olivia Owner" });
  await createUser({ email: "staff@garment.test", role: "STAFF" });
  await createUser({ email: "viewer@garment.test", role: "VIEWER" });
  const owner = await loggedInClient("owner@garment.test");
  return { owner };
}

async function createFabric(client: TestClient, overrides: object = {}) {
  const res = await client.send("post", "/api/v1/fabrics", {
    code: "fb-ctj",
    name: "Cotton Jersey",
    unit: "KG",
    category: "KNIT",
    lowStockThreshold: 50,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.data.fabric as { id: string; code: string };
}

async function postInward(client: TestClient, fabricId: string, quantity: number, rate: number, extra: object = {}) {
  const res = await client.send("post", "/api/v1/fabrics/inwards", {
    fabricId,
    inwardDate: today,
    quantity,
    rate,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.data.inward as { id: string; number: number; amount: number };
}

async function fabricOf(client: TestClient, id: string) {
  return (await client.get(`/api/v1/fabrics/${id}`)).body.data.fabric as {
    balance: number;
    avgRate: number | null;
    stockValue: number;
  };
}

describe("fabric master", () => {
  it("normalizes the code and rejects a duplicate with a field error", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    expect(fabric.code).toBe("FB-CTJ");

    const dup = await owner.send("post", "/api/v1/fabrics", {
      code: "FB-CTJ",
      name: "Other",
      unit: "METER",
      category: "WOVEN",
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.code).toBeDefined();
  });

  it("treats category as optional free text and suggests the ones in use", async () => {
    const { owner } = await setup();
    const plain = await owner.send("post", "/api/v1/fabrics", { code: "NO-CAT", name: "Plain", unit: "KG" });
    expect(plain.status).toBe(201);
    expect(plain.body.data.fabric.category).toBeNull();
    await createFabric(owner, { code: "FB-1", name: "One", category: "Cotton Knit" });
    await createFabric(owner, { code: "FB-2", name: "Two", category: "  cotton knit " });
    await createFabric(owner, { code: "FB-3", name: "Three", category: "Denim" });
    const categories = (await owner.get("/api/v1/fabrics/categories")).body.data.categories as string[];
    expect(categories).toHaveLength(2);
    expect(categories.map((c) => c.toLowerCase()).sort()).toEqual(["cotton knit", "denim"]);
    expect((await owner.get("/api/v1/fabrics?category=knit")).body.data.total).toBe(2);
    const tooLong = await owner.send("post", "/api/v1/fabrics", {
      code: "X-1",
      name: "X",
      unit: "KG",
      category: "x".repeat(51),
    });
    expect(tooLong.body.error.details.category).toBeDefined();
  });

  it("locks the unit once stock has been posted", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    const body = { code: "FB-CTJ", name: "Cotton Jersey", unit: "METER", category: "KNIT", isActive: true };
    expect((await owner.send("put", `/api/v1/fabrics/${fabric.id}`, body)).status).toBe(200);

    await postInward(owner, fabric.id, 10, 100);
    const res = await owner.send("put", `/api/v1/fabrics/${fabric.id}`, { ...body, unit: "KG" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.unit).toBeDefined();
  });

  it("enforces fabric permissions per role", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    const staff = await loggedInClient("staff@garment.test");
    const viewer = await loggedInClient("viewer@garment.test");

    expect((await viewer.get("/api/v1/fabrics")).status).toBe(200);
    expect((await viewer.send("post", "/api/v1/fabrics/inwards", { fabricId: fabric.id })).status).toBe(403);
    expect((await staff.send("post", "/api/v1/fabrics", { code: "X" })).status).toBe(403);
    expect((await staff.send("post", `/api/v1/fabrics/${fabric.id}/adjustments`, {})).status).toBe(403);
    await postInward(staff, fabric.id, 5, 10);
  });
});

describe("fabric list", () => {
  it("filters, searches and pages on the server with workspace-wide summary figures", async () => {
    const { owner } = await setup();
    const low = await createFabric(owner, { code: "FB-INT", name: "Interlock", lowStockThreshold: 50 });
    await postInward(owner, low.id, 20, 100);
    const ok = await createFabric(owner, { code: "FB-PPL", name: "Poplin", unit: "METER", category: "WOVEN" });
    await postInward(owner, ok.id, 300, 10);
    await createFabric(owner, { code: "FB-CRD", name: "Corduroy", category: "WOVEN" });
    const inactive = await createFabric(owner, { code: "FB-OLD", name: "Old Twill" });
    await owner.send("put", `/api/v1/fabrics/${inactive.id}`, {
      code: "FB-OLD",
      name: "Old Twill",
      unit: "KG",
      category: "KNIT",
      isActive: false,
    });

    const all = (await owner.get("/api/v1/fabrics")).body.data;
    expect(all.total).toBe(3);
    expect(all.summary).toEqual({ stockValue: 5_000, active: 3, inStock: 2, reorder: 2, inactive: 1 });

    const page2 = (await owner.get("/api/v1/fabrics?pageSize=2&page=2")).body.data;
    expect(page2.total).toBe(3);
    expect(page2.fabrics.map((f: { name: string }) => f.name)).toEqual(["Poplin"]);

    const search = (await owner.get("/api/v1/fabrics?search=ppl")).body.data;
    expect(search.fabrics.map((f: { code: string }) => f.code)).toEqual(["FB-PPL"]);
    const literal = (await owner.get("/api/v1/fabrics?search=%25")).body.data;
    expect(literal.total).toBe(0);

    const reorder = (await owner.get("/api/v1/fabrics?stock=low")).body.data;
    expect(reorder.fabrics.map((f: { name: string }) => f.name)).toEqual(["Corduroy", "Interlock"]);
    expect((await owner.get("/api/v1/fabrics?stock=out")).body.data.total).toBe(1);
    expect((await owner.get("/api/v1/fabrics?category=WOVEN")).body.data.total).toBe(2);
    expect((await owner.get("/api/v1/fabrics?status=inactive")).body.data.fabrics[0].name).toBe("Old Twill");
    expect((await owner.get("/api/v1/fabrics?status=active,inactive")).body.data.total).toBe(4);
    expect((await owner.get("/api/v1/fabrics?pageSize=500")).status).toBe(400);

    const options = (await owner.get("/api/v1/fabrics/options")).body.data.fabrics;
    expect(options).toHaveLength(4);
    expect(options[0]).toEqual({
      id: expect.any(String),
      code: "FB-CRD",
      name: "Corduroy",
      unit: "KG",
      isActive: true,
      balance: 0,
    });
  });

  it("finds purchases by register number", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    await postInward(owner, fabric.id, 1, 1);
    const second = await postInward(owner, fabric.id, 2, 1);
    for (const term of [`FI-${String(second.number).padStart(4, "0")}`, `fi${second.number}`]) {
      const res = (await owner.get(`/api/v1/fabrics/inwards?search=${term}`)).body.data;
      expect(res.inwards.map((i: { id: string }) => i.id)).toEqual([second.id]);
    }
  });
});

describe("column filters, sorting, export, bulk and import", () => {
  async function seed(owner: TestClient) {
    const a = await createFabric(owner, { code: "FB-A", name: "Alpha Knit", lowStockThreshold: 10 });
    const b = await createFabric(owner, { code: "FB-B", name: "Beta Woven", unit: "METER", category: "WOVEN" });
    const c = await createFabric(owner, { code: "FB-C", name: "Gamma", category: "WOVEN", description: "=SUM(1)" });
    await postInward(owner, a.id, 100, 10, { inwardDate: "2026-01-05", supplier: "Sunrise Knits", color: "Red" });
    await postInward(owner, b.id, 40, 50, {
      inwardDate: "2026-02-10",
      supplier: "Nepal Fabrics",
      invoiceRef: "INV-77",
    });
    await postInward(owner, c.id, 5, 200, { inwardDate: "2026-03-15", supplier: "=HYPERLINK(1)" });
    return { a, b, c };
  }

  it("filters and sorts each list by whitelisted columns only", async () => {
    const { owner } = await setup();
    await seed(owner);

    const names = async (url: string) =>
      (await owner.get(url)).body.data.fabrics.map((f: { name: string }) => f.name) as string[];
    expect(await names("/api/v1/fabrics?sort=balance&dir=desc")).toEqual(["Alpha Knit", "Beta Woven", "Gamma"]);
    expect(await names("/api/v1/fabrics?balanceMin=6&balanceMax=50")).toEqual(["Beta Woven"]);
    expect(await names("/api/v1/fabrics?category=WOVEN&fabric=gam")).toEqual(["Gamma"]);
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
    expect(await inwards("/api/v1/fabrics/inwards?colorRoll=red")).toEqual(["Sunrise Knits"]);

    const ledger = (await owner.get("/api/v1/fabrics/movements?type=PURCHASE_IN&sort=qtyIn&dir=asc")).body.data;
    expect(ledger.movements.map((m: { qtyIn: number }) => m.qtyIn)).toEqual([5, 40, 100]);
    expect(ledger.movements.map((m: { balance: number }) => m.balance)).toEqual([5, 40, 100]);

    // Anything outside the declared columns is rejected, never interpolated.
    for (const bad of ["sort=f.name;drop", "status=NOPE", "balanceMin=abc", "dateFrom=yesterday", "dir=sideways"]) {
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

    const fabrics = await owner.get("/api/v1/fabrics/export?category=WOVEN");
    expect(fabrics.text.replace(/^\uFEFF/, "").split("\r\n")).toHaveLength(3);
    expect((await owner.get("/api/v1/fabrics/movements/export")).status).toBe(200);
  });

  it("changes status in bulk and audits it", async () => {
    const { owner } = await setup();
    const { a, b } = await seed(owner);
    const res = await owner.send("post", "/api/v1/fabrics/bulk-status", { ids: [a.id, b.id, a.id], isActive: false });
    expect(res.body.data.updated).toBe(2);
    expect((await owner.get("/api/v1/fabrics?status=inactive")).body.data.total).toBe(2);
    expect(
      (await owner.send("post", "/api/v1/fabrics/bulk-status", { ids: [a.id], isActive: false })).body.data.updated,
    ).toBe(0);
    const staff = await loggedInClient("staff@garment.test");
    expect((await staff.send("post", "/api/v1/fabrics/bulk-status", { ids: [a.id], isActive: true })).status).toBe(403);
  });

  it("imports fabrics all-or-nothing with per-row errors", async () => {
    const { owner } = await setup();
    await createFabric(owner, { code: "FB-OLD", name: "Existing" });
    const bad = await owner.send("post", "/api/v1/fabrics/import", {
      rows: [
        { code: "fb-new", name: "New Knit", unit: "KG", category: "KNIT" },
        { code: "FB-NEW", name: "Dup In File", unit: "KG", category: "KNIT" },
        { code: "FB-OLD", name: "Dup Saved", unit: "KG", category: "KNIT" },
        { code: "OK-1", name: "", unit: "LITRE", category: "KNIT" },
      ],
    });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details).sort()).toEqual([
      "rows.2.code",
      "rows.3.code",
      "rows.4.name",
      "rows.4.unit",
    ]);
    expect((await owner.get("/api/v1/fabrics")).body.data.total).toBe(1);

    const ok = await owner.send("post", "/api/v1/fabrics/import", {
      rows: [
        { code: "fb-new", name: "New Knit", unit: "KG", category: "KNIT", lowStockThreshold: 20 },
        { code: "FB-NEW2", name: "New Woven", unit: "METER", category: "WOVEN", description: "Plain" },
      ],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.created).toBe(2);
    expect(
      (await owner.get("/api/v1/fabrics?fabric=new")).body.data.fabrics.map((f: { code: string }) => f.code),
    ).toEqual(["FB-NEW", "FB-NEW2"]);
  });
});

describe("purchases and stock ledger", () => {
  it("derives balance, weighted rate and value from posted purchases", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    const first = await postInward(owner, fabric.id, 100, 400, {
      supplier: "Sunrise Knits",
      color: "Red",
      rollRef: "R-001",
    });
    await postInward(owner, fabric.id, 50, 520);
    expect(first.amount).toBe(40_000);

    expect(await fabricOf(owner, fabric.id)).toMatchObject({ balance: 150, avgRate: 440, stockValue: 66_000 });

    const list = await owner.get("/api/v1/fabrics/inwards?search=sunrise");
    expect(list.body.data).toMatchObject({ total: 1, totalAmount: 40_000, totalQuantity: { KG: 100 } });
    expect(list.body.data.inwards[0].color).toBe("Red");
    expect((await owner.get("/api/v1/fabrics/inwards/suppliers")).body.data.suppliers).toEqual(["Sunrise Knits"]);
  });

  it("rejects purchases for inactive fabrics and future dates", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    const future = await owner.send("post", "/api/v1/fabrics/inwards", {
      fabricId: fabric.id,
      inwardDate: "2999-01-01",
      quantity: 1,
      rate: 1,
    });
    expect(future.body.error.details.inwardDate).toBeDefined();

    await owner.send("put", `/api/v1/fabrics/${fabric.id}`, {
      code: "FB-CTJ",
      name: "Cotton Jersey",
      unit: "KG",
      category: "KNIT",
      isActive: false,
    });
    const res = await owner.send("post", "/api/v1/fabrics/inwards", {
      fabricId: fabric.id,
      inwardDate: today,
      quantity: 1,
      rate: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fabricId).toBeDefined();
  });

  it("never lets an adjustment or reversal drive stock negative", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    const inward = await postInward(owner, fabric.id, 100, 400);

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
  });

  it("returns newest-first movements with running balances and a period summary", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    await postInward(owner, fabric.id, 100, 400, { inwardDate: "2026-01-10" });
    await postInward(owner, fabric.id, 20, 400, { inwardDate: "2026-02-10" });
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

    const feb = (
      await owner.get(`/api/v1/fabrics/movements?fabricId=${fabric.id}&dateFrom=2026-02-01&dateTo=2026-02-28`)
    ).body.data;
    expect(feb.total).toBe(1);
    expect(feb.summary).toEqual({ opening: 100, totalIn: 20, totalOut: 0, closing: 120 });
  });

  it("orders the ledger by business date, so a backdated purchase gets the right running balance", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    await postInward(owner, fabric.id, 10, 1, { inwardDate: "2026-03-01" });
    await postInward(owner, fabric.id, 5, 1, { inwardDate: "2026-01-01" });
    const rows = (await owner.get(`/api/v1/fabrics/movements?fabricId=${fabric.id}`)).body.data.movements;
    expect(rows.map((m: { date: string; balance: number }) => [m.date, m.balance])).toEqual([
      ["2026-03-01", 15],
      ["2026-01-01", 5],
    ]);
  });

  it("keeps the stock projection equal to the ledger sum", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
    const inward = await postInward(owner, fabric.id, 40, 100);
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
    await postInward(owner, fabric.id, 30, 100);
    await owner.send("post", `/api/v1/fabrics/inwards/${inward.id}/reverse`, { reason: "Wrong fabric" });
    const { rows } = await pool.query<{ projected: string; ledger: string; purchased: string }>(
      `SELECT s.balance AS projected, s.purchased_qty AS purchased,
              (SELECT sum(qty_in - qty_out) FROM fabric_movements WHERE fabric_id = $1) AS ledger
       FROM fabric_stock s WHERE s.fabric_id = $1`,
      [fabric.id],
    );
    expect(Number(rows[0]!.projected)).toBe(Number(rows[0]!.ledger));
    expect(Number(rows[0]!.projected)).toBe(20);
    expect(Number(rows[0]!.purchased)).toBe(30);
    await expect(pool.query("UPDATE fabric_stock SET balance = -1 WHERE fabric_id = $1", [fabric.id])).rejects.toThrow(
      /check/i,
    );
  });

  it("rejects colour or roll on a stock adjustment", async () => {
    const { owner } = await setup();
    const fabric = await createFabric(owner);
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
    const fabric = await createFabric(owner);
    await postInward(owner, fabric.id, 10, 1);
    await expect(pool.query("UPDATE fabric_movements SET qty_in = 999")).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM fabric_movements")).rejects.toThrow(/append-only/);
  });
});
