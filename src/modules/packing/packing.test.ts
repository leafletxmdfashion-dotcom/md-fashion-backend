import { beforeEach, describe, expect, it } from "vitest";

import { karigar, post, stitchedLot, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql, type TestClient } from "../../test/helpers";

beforeEach(resetDatabase);

interface QueueLot {
  lot: { id: string; lotNumber: string; articleName: string };
  sizes: { size: string; good: number; packed: number; waiting: number }[];
  waiting: number;
}

async function queue(client: TestClient) {
  const res = await client.get("/api/v1/packing/queue");

  expect(res.status).toBe(200);

  return res.body.data as { lots: QueueLot[]; totals: { good: number; packed: number; waiting: number } };
}

async function stock() {
  const { rows } = await sql(
    `SELECT a.name, s.size_label AS size, s.balance FROM godown_stock s JOIN articles a ON a.id = s.article_id
     ORDER BY a.name, s.size_label`,
  );

  return rows as { name: string; size: string; balance: number }[];
}

describe("packing queue", () => {
  it("shows Good pieces from stitching waiting to be packed, by size, with no transfer step", async () => {
    const { owner } = await stitchedLot();
    const data = await queue(owner);

    expect(data.totals).toEqual({ good: 81, packed: 0, waiting: 81 });
    expect(data.lots).toHaveLength(1);
    expect(data.lots[0]!.lot.lotNumber).toBe("LOT-1");
    expect(data.lots[0]!.sizes).toEqual([
      { size: "S", good: 20, packed: 0, waiting: 20 },
      { size: "M", good: 40, packed: 0, waiting: 40 },
      { size: "L", good: 21, packed: 0, waiting: 21 },
    ]);
  });

  it("adds recovered rework to the queue", async () => {
    const { owner } = await stitchedLot();
    const rework = (await owner.get("/api/v1/stitching/rework")).body.data.items[0] as { id: string };

    await post(owner, `/api/v1/stitching/rework/${rework.id}/resolve`, { resolvedOn: today, recovered: 2, failed: 0 });

    expect((await queue(owner)).lots[0]!.sizes[1]).toEqual({ size: "M", good: 42, packed: 0, waiting: 42 });
  });
});

describe("packing", () => {
  it("packs per size, pays the packer per piece, books the cost and puts the pieces in the godown", async () => {
    const { owner, lotId } = await stitchedLot();
    const packer = await karigar(owner, "Puja", "PACKER", 1.5);

    const over = await owner.send("post", "/api/v1/packing/entries", {
      lotId,
      packerId: packer,
      packDate: today,
      lines: [{ sizeLabel: "M", quantity: 41 }],
    });

    expect(over.status).toBe(400);
    expect(over.body.error.details["lines.0.quantity"][0]).toMatch(/Only 40 pieces of M/);

    const entry = (
      await post(owner, "/api/v1/packing/entries", {
        lotId,
        packerId: packer,
        packDate: today,
        lines: [
          { sizeLabel: "S", quantity: 20 },
          { sizeLabel: "M", quantity: 30 },
        ],
      })
    ).entry;

    // 50 pieces × Rs 1.50 = Rs 75.
    expect(entry).toMatchObject({ pieces: 50, rate: "1.50", earning: "75.00", status: "POSTED" });
    expect(entry.lines).toEqual([
      { sizeLabel: "S", quantity: 20 },
      { sizeLabel: "M", quantity: 30 },
    ]);
    expect(
      (await sql("SELECT type, source_type, amount::text AS amount FROM karigar_ledger WHERE karigar_id = $1", [packer]))
        .rows,
    ).toEqual([{ type: "EARNING", source_type: "PACKING", amount: "75.00" }]);
    expect((await sql("SELECT amount::text AS amount FROM lot_costs WHERE kind = 'PACKING_LABOUR'")).rows).toEqual([
      { amount: "75.00" },
    ]);
    expect(await stock()).toEqual([
      { name: "Polo", size: "M", balance: 30 },
      { name: "Polo", size: "S", balance: 20 },
    ]);
    expect((await queue(owner)).totals).toEqual({ good: 81, packed: 50, waiting: 31 });
  });

  it("only lets one of two simultaneous packings take the last pieces", async () => {
    const { owner, lotId } = await stitchedLot();
    const packer = await karigar(owner, "Puja", "PACKER", 1);
    const body = { lotId, packerId: packer, packDate: today, lines: [{ sizeLabel: "L", quantity: 15 }] };

    const results = await Promise.all([
      owner.send("post", "/api/v1/packing/entries", body),
      owner.send("post", "/api/v1/packing/entries", body),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 400]);
  });

  it("reverses an entry: pieces back to the queue, out of the godown, earning and cost reversed, once", async () => {
    const { owner, lotId } = await stitchedLot();
    const packer = await karigar(owner, "Puja", "PACKER", 2);
    const entry = (
      await post(owner, "/api/v1/packing/entries", {
        lotId,
        packerId: packer,
        packDate: today,
        lines: [{ sizeLabel: "L", quantity: 21 }],
      })
    ).entry;

    const reversed = await owner.send("post", `/api/v1/packing/entries/${entry.id}/reverse`, { reason: "Wrong lot" });

    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.data.entry.status).toBe("REVERSED");
    expect((await queue(owner)).totals.waiting).toBe(81);
    expect(await stock()).toEqual([{ name: "Polo", size: "L", balance: 0 }]);
    expect(
      (await sql("SELECT sum(amount)::text AS net FROM karigar_ledger WHERE karigar_id = $1", [packer])).rows[0].net,
    ).toBe("0.00");
    expect(
      (await sql("SELECT sum(amount)::text AS net FROM lot_costs WHERE kind = 'PACKING_LABOUR'")).rows[0].net,
    ).toBe("0.00");
    expect((await owner.send("post", `/api/v1/packing/entries/${entry.id}/reverse`, { reason: "Again" })).status).toBe(
      409,
    );
  });

  it("blocks reversing a stitching receipt whose pieces were packed", async () => {
    const { owner, lotId, receiptId } = await stitchedLot();
    const packer = await karigar(owner, "Puja", "PACKER", 1);

    await post(owner, "/api/v1/packing/entries", {
      lotId,
      packerId: packer,
      packDate: today,
      lines: [{ sizeLabel: "S", quantity: 1 }],
    });

    const res = await owner.send("post", `/api/v1/stitching/receipts/${receiptId}/reverse`, { reason: "Counted twice" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/packed/);
  });
});

describe("packing reports", () => {
  it("lists entries and their lines with filters, and sums each packer's pieces and pay", async () => {
    const { owner, lotId } = await stitchedLot();
    const puja = await karigar(owner, "Puja", "PACKER", 1);
    const raju = await karigar(owner, "Raju", "PACKER", 2);

    await post(owner, "/api/v1/packing/entries", {
      lotId,
      packerId: puja,
      packDate: today,
      lines: [{ sizeLabel: "S", quantity: 10 }],
    });
    await post(owner, "/api/v1/packing/entries", {
      lotId,
      packerId: raju,
      packDate: today,
      lines: [
        { sizeLabel: "M", quantity: 5 },
        { sizeLabel: "L", quantity: 5 },
      ],
    });

    const all = (await owner.get("/api/v1/packing/entries")).body.data;

    expect(all.total).toBe(2);
    expect(all.summary).toMatchObject({ entries: 2, pieces: 20, earning: "30.00" });

    const rajus = (await owner.get(`/api/v1/packing/entries?packerId=${raju}`)).body.data;

    expect(rajus.entries.map((entry: { packer: { name: string } }) => entry.packer.name)).toEqual(["Raju"]);
    expect((await owner.get("/api/v1/packing/entries?search=puja")).body.data.total).toBe(1);

    const lines = (await owner.get(`/api/v1/packing/lines?dateFrom=${today}&dateTo=${today}`)).body.data;

    expect(lines.total).toBe(3);
    expect(lines.lines[0]).toMatchObject({ date: today, packer: { name: expect.any(String) }, articleName: "Polo" });

    const staff = (await owner.get("/api/v1/packing/staff")).body.data.staff as {
      name: string;
      pieces: number;
      entries: number;
      earned: string | null;
    }[];

    expect(staff.map((row) => [row.name, row.pieces, row.entries, row.earned])).toEqual([
      ["Puja", 10, 1, "10.00"],
      ["Raju", 10, 1, "20.00"],
    ]);

    const summary = (await owner.get("/api/v1/packing/summary")).body.data;

    expect(summary).toMatchObject({ waiting: 61, packedToday: 20, packedThisMonth: 20, packedTotal: 20 });
  });
});

describe("packing permissions", () => {
  it("lets packing staff pack at the packer's rate without seeing money, and viewers only look", async () => {
    const { owner, lotId } = await stitchedLot();
    const packer = await karigar(owner, "Puja", "PACKER", 1.25);

    await createUser({ email: "packer@garment.test", role: "PACKING_STAFF" });
    await createUser({ email: "viewer@garment.test", role: "VIEWER" });

    const staff = await loggedInClient("packer@garment.test");
    const viewer = await loggedInClient("viewer@garment.test");
    const body = { lotId, packerId: packer, packDate: today, lines: [{ sizeLabel: "S", quantity: 4 }] };

    expect((await viewer.get("/api/v1/packing/queue")).status).toBe(200);
    expect((await viewer.send("post", "/api/v1/packing/entries", body)).status).toBe(403);
    expect((await staff.send("post", "/api/v1/packing/entries", { ...body, rate: 9 })).status).toBe(403);

    const entry = (await post(staff, "/api/v1/packing/entries", body)).entry;

    expect(entry).toMatchObject({ pieces: 4, rate: null, earning: null });
    expect((await owner.get(`/api/v1/packing/entries/${entry.id}`)).body.data.entry).toMatchObject({
      rate: "1.25",
      earning: "5.00",
    });
  });
});
