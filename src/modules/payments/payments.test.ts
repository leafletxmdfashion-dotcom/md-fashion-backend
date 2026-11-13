import { beforeEach, describe, expect, it } from "vitest";

import { karigar, post, stitchedLot, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql, type TestClient } from "../../test/helpers";

beforeEach(resetDatabase);

interface Person {
  id: string;
  name: string;
  earned: string;
  paid: string;
  advances: string;
  expenses: string;
  credits: string;
  recovered: string;
  balance: string;
}

async function people(client: TestClient, query = "") {
  const res = await client.get(`/api/v1/payments/people${query}`);

  expect(res.status, JSON.stringify(res.body)).toBe(200);

  return res.body.data as { people: Person[]; total: number; summary: Record<string, string | number> };
}

const entry = (client: TestClient, karigarId: string, type: string, amount: number, extra: object = {}) =>
  client.send("post", "/api/v1/payments/entries", { karigarId, type, amount, entryDate: today, ...extra });

describe("balances", () => {
  it("adds earnings and credits, takes off payments, advances and expenses; negative means they owe", async () => {
    const { owner, ram } = await stitchedLot();

    // Ram earned Rs 405 (half of 81 Good × Rs 10).
    expect((await entry(owner, ram, "PAYMENT", 300, { method: "CASH", reference: "V-1" })).status).toBe(201);
    expect((await entry(owner, ram, "EXPENSE", 50, { category: "Food" })).status).toBe(201);
    expect((await entry(owner, ram, "ADVANCE", 200, { category: "Festival", note: "Dashain" })).status).toBe(201);
    expect((await entry(owner, ram, "CREDIT", 100, { category: "Bonus" })).status).toBe(201);
    expect((await entry(owner, ram, "RECOVERY", 20, { method: "CASH" })).status).toBe(201);

    const ramRow = (await people(owner, "?search=ram")).people[0]!;

    expect(ramRow).toMatchObject({
      name: "Ram",
      earned: "405.00",
      paid: "300.00",
      expenses: "50.00",
      advances: "200.00",
      credits: "100.00",
      recovered: "20.00",
      // 405 + 100 + 20 − 300 − 50 − 200
      balance: "-25.00",
    });

    const all = await people(owner);

    // Sita is owed her Rs 405; Ram owes Rs 25.
    expect(all.summary).toMatchObject({ payable: "405.00", receivable: "25.00" });
    expect((await people(owner, "?balance=owing")).people.map((person) => person.name)).toEqual(["Ram"]);
    expect((await people(owner, "?balance=owed")).people.map((person) => person.name)).toEqual(["Sita"]);
  });

  it("validates amounts and types", async () => {
    const { owner, ram } = await stitchedLot();

    expect((await entry(owner, ram, "PAYMENT", 0)).status).toBe(400);
    expect((await entry(owner, ram, "PAYMENT", 10.555)).status).toBe(400);
    expect((await entry(owner, ram, "EARNING", 10)).status).toBe(400);
    expect((await entry(owner, "00000000-0000-0000-0000-000000000000", "PAYMENT", 10)).status).toBe(400);
  });
});

describe("ledger", () => {
  it("lists a person's entries with a running balance, filters and a summary", async () => {
    const { owner, ram } = await stitchedLot();

    await entry(owner, ram, "PAYMENT", 100, { reference: "V-77" });
    await entry(owner, ram, "EXPENSE", 40, { category: "Food" });

    const all = (await owner.get(`/api/v1/payments/ledger?karigarId=${ram}`)).body.data;

    expect(all.total).toBe(3);
    expect(
      all.entries.map((row: { kind: string; amount: string; balance: string }) => [row.kind, row.amount, row.balance]),
    ).toEqual([
      ["EXPENSE", "-40.00", "265.00"],
      ["PAYMENT", "-100.00", "305.00"],
      ["EARNING", "405.00", "405.00"],
    ]);
    expect(all.summary).toMatchObject({ credit: "405.00", debit: "140.00", net: "265.00" });

    const food = (await owner.get(`/api/v1/payments/ledger?karigarId=${ram}&search=food`)).body.data;

    expect(food.total).toBe(1);

    const payments = (await owner.get(`/api/v1/payments/ledger?kind=PAYMENT,ADVANCE`)).body.data;

    expect(payments.entries.map((row: { reference: string }) => row.reference)).toEqual(["V-77"]);
  });

  it("reverses a manual entry once; earnings are reversed by their own documents only", async () => {
    const { owner, ram } = await stitchedLot();
    const paid = (
      await post(owner, "/api/v1/payments/entries", { karigarId: ram, type: "PAYMENT", amount: 100, entryDate: today })
    ).entry as { id: string };

    const reversed = await owner.send("post", `/api/v1/payments/entries/${paid.id}/reverse`, { reason: "Paid twice" });

    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect((await people(owner, "?search=ram")).people[0]).toMatchObject({ paid: "0.00", balance: "405.00" });
    expect((await owner.send("post", `/api/v1/payments/entries/${paid.id}/reverse`, { reason: "Again" })).status).toBe(
      409,
    );

    const earning = (await sql("SELECT id FROM karigar_ledger WHERE karigar_id = $1 AND type = 'EARNING'", [ram]))
      .rows[0].id as string;

    expect(
      (await owner.send("post", `/api/v1/payments/entries/${earning}/reverse`, { reason: "Not allowed" })).status,
    ).toBe(409);
  });
});

describe("people master", () => {
  it("counts only earnings as earned, links a login, and shows that person their own ledger only", async () => {
    const { owner, ram, sita } = await stitchedLot();

    await entry(owner, ram, "PAYMENT", 100);

    const userId = await createUser({ email: "ram@garment.test", role: "KARIGAR", name: "Ram" });
    const linked = await owner.send("put", `/api/v1/karigars/${ram}`, {
      name: "Ram",
      category: "TAILOR",
      payMode: "PER_PIECE",
      payRate: 0,
      active: true,
      userId,
    });

    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.data.karigar).toMatchObject({ earned: 405, user: { id: userId, email: "ram@garment.test" } });

    // One login, one person.
    const twice = await owner.send("put", `/api/v1/karigars/${sita}`, {
      name: "Sita",
      category: "TAILOR",
      payMode: "PER_PIECE",
      payRate: 0,
      active: true,
      userId,
    });

    expect(twice.status).toBe(409);

    const me = await loggedInClient("ram@garment.test");
    const mine = (await me.get("/api/v1/payments/me")).body.data;

    expect(mine.person).toMatchObject({ name: "Ram" });
    expect(mine.summary).toMatchObject({ earned: "405.00", paid: "100.00", balance: "305.00" });

    const ledger = (await me.get(`/api/v1/payments/me/ledger?karigarId=${sita}`)).body.data;

    expect(ledger.total).toBe(2);
    expect(ledger.entries.every((row: { karigar: { name: string } }) => row.karigar.name === "Ram")).toBe(true);
    expect((await me.get("/api/v1/payments/people")).status).toBe(403);
    expect((await me.get("/api/v1/payments/ledger")).status).toBe(403);

    // Someone without a linked person has no ledger.
    expect((await owner.get("/api/v1/payments/me")).body.data.person).toBeNull();
  });

  it("lets accountants record payments, and nobody else without the right", async () => {
    const { ram } = await stitchedLot();

    await createUser({ email: "acc@garment.test", role: "ACCOUNTANT" });
    await createUser({ email: "staff@garment.test", role: "STAFF" });

    const accountant = await loggedInClient("acc@garment.test");
    const staff = await loggedInClient("staff@garment.test");

    expect((await entry(accountant, ram, "PAYMENT", 10)).status).toBe(201);
    expect((await entry(staff, ram, "PAYMENT", 10)).status).toBe(403);
    expect((await staff.get("/api/v1/payments/people")).status).toBe(403);
  });

  it("adds staff who are not karigars", async () => {
    const { owner } = await stitchedLot();
    const staffId = await karigar(owner, "Office Gita", "STAFF", 15000, { payMode: "SALARY" });

    await entry(owner, staffId, "CREDIT", 15000, { category: "Salary" });
    await entry(owner, staffId, "PAYMENT", 15000, { method: "BANK" });

    expect((await people(owner, "?category=STAFF")).people[0]).toMatchObject({ name: "Office Gita", balance: "0.00" });
  });
});
