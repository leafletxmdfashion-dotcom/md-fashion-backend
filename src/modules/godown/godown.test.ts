import { beforeEach, describe, expect, it } from "vitest";

import { karigar, post, stitchedLot, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, type TestClient } from "../../test/helpers";

beforeEach(resetDatabase);

/** A stitched lot with S 20, M 40, L 21 packed into the godown. */
async function packed() {
  const lot = await stitchedLot();
  const packer = await karigar(lot.owner, "Puja", "PACKER", 1);
  const entry = (
    await post(lot.owner, "/api/v1/packing/entries", {
      lotId: lot.lotId,
      packerId: packer,
      packDate: today,
      lines: [
        { sizeLabel: "S", quantity: 20 },
        { sizeLabel: "M", quantity: 40 },
        { sizeLabel: "L", quantity: 21 },
      ],
    })
  ).entry as { id: string };

  return { ...lot, packer, entryId: entry.id };
}

interface StockItem {
  article: { id: string; name: string; code: string };
  sizes: { size: string; in: number; out: number; balance: number }[];
  balance: number;
}

async function stockOf(client: TestClient, query = "") {
  const res = await client.get(`/api/v1/godown/stock${query}`);

  expect(res.status).toBe(200);

  return res.body.data as { items: StockItem[]; summary: Record<string, number> };
}

function dispatch(client: TestClient, articleId: string, lines: [string, number][], party = "Sharma Traders") {
  return client.send("post", "/api/v1/godown/dispatches", {
    dispatchDate: today,
    party,
    challan: "CH-101",
    lines: lines.map(([sizeLabel, quantity]) => ({ articleId, sizeLabel, quantity })),
  });
}

describe("godown stock", () => {
  it("receives every packing automatically, per item and size", async () => {
    const { owner } = await packed();
    const data = await stockOf(owner);

    expect(data.items).toHaveLength(1);
    expect(data.items[0]!.article.name).toBe("Polo");
    expect(data.items[0]!.sizes).toEqual([
      { size: "S", in: 20, out: 0, balance: 20 },
      { size: "M", in: 40, out: 0, balance: 40 },
      { size: "L", in: 21, out: 0, balance: 21 },
    ]);
    expect(data.summary).toMatchObject({ items: 1, pieces: 81, inThisMonth: 81, outThisMonth: 0 });
    expect((await stockOf(owner, "?search=nothing")).items).toHaveLength(0);
  });
});

describe("dispatch", () => {
  it("sends goods out, never more than in stock, and reverses back", async () => {
    const { owner, articleId, entryId } = await packed();

    const over = await dispatch(owner, articleId, [
      ["S", 5],
      ["M", 41],
    ]);

    expect(over.status).toBe(400);
    expect(over.body.error.details["lines.1.quantity"][0]).toMatch(/Only 40 pieces of Polo M/);

    const res = await dispatch(owner, articleId, [
      ["S", 5],
      ["M", 10],
    ]);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.dispatch).toMatchObject({
      party: "Sharma Traders",
      challan: "CH-101",
      pieces: 15,
      status: "POSTED",
    });
    expect((await stockOf(owner)).summary).toMatchObject({ pieces: 66, outThisMonth: 15 });

    // Packed pieces that have gone out cannot be un-packed.
    expect((await owner.send("post", `/api/v1/packing/entries/${entryId}/reverse`, { reason: "Wrong" })).status).toBe(
      409,
    );

    const list = (await owner.get("/api/v1/godown/dispatches?search=sharma")).body.data;

    expect(list).toMatchObject({ total: 1, summary: { dispatches: 1, pieces: 15 } });
    expect((await owner.get("/api/v1/godown/parties")).body.data.parties).toEqual(["Sharma Traders"]);

    const id = res.body.data.dispatch.id as string;
    const reversed = await owner.send("post", `/api/v1/godown/dispatches/${id}/reverse`, {
      reason: "Returned unopened",
    });

    expect(reversed.status).toBe(200);
    expect((await stockOf(owner)).summary.pieces).toBe(81);
    expect((await owner.send("post", `/api/v1/godown/dispatches/${id}/reverse`, { reason: "Again" })).status).toBe(409);
  });
});

describe("adjustment", () => {
  it("sets a size to the counted quantity with a reason", async () => {
    const { owner, articleId } = await packed();
    const adjust = (counted: number, reason = "Physical count") =>
      owner.send("post", "/api/v1/godown/adjustments", { date: today, articleId, sizeLabel: "M", counted, reason });

    expect((await adjust(40)).status).toBe(400);
    expect((await adjust(38, "")).status).toBe(400);
    expect((await adjust(38)).status).toBe(201);
    expect((await adjust(39)).status).toBe(201);

    const m = (await stockOf(owner)).items[0]!.sizes.find((size) => size.size === "M");

    expect(m).toEqual({ size: "M", in: 41, out: 2, balance: 39 });

    const moves = (await owner.get("/api/v1/godown/movements?type=ADJUST_IN,ADJUST_OUT")).body.data;

    expect(moves.total).toBe(2);
    expect(moves.movements.map((move: { type: string; quantity: number }) => [move.type, move.quantity])).toEqual([
      ["ADJUST_IN", 1],
      ["ADJUST_OUT", 2],
    ]);
    expect((await owner.get("/api/v1/godown/movements")).body.data.summary).toMatchObject({ in: 82, out: 2 });
  });
});

describe("adjustment races", () => {
  it("counts a size not yet in the godown only once when two people save at the same time", async () => {
    const { owner, articleId } = await packed();
    const body = { date: today, articleId, sizeLabel: "XXL", counted: 10, reason: "Found in a carton" };

    const results = await Promise.all([
      owner.send("post", "/api/v1/godown/adjustments", body),
      owner.send("post", "/api/v1/godown/adjustments", body),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 400]);
    expect((await stockOf(owner)).items[0]!.sizes.find((size) => size.size === "XXL")?.balance).toBe(10);
  });
});

describe("finished goods", () => {
  it("shows each lot from cutting to godown, and item totals", async () => {
    const { owner, articleId } = await packed();

    await dispatch(owner, articleId, [["L", 1]]);

    const data = (await owner.get("/api/v1/godown/finished-goods")).body.data;

    expect(data.total).toBe(1);
    expect(data.lots[0]).toMatchObject({
      lotNumber: "LOT-1",
      articleName: "Polo",
      cut: 84,
      good: 81,
      reject: 1,
      rework: 2,
      packed: 81,
      toPack: 0,
    });
    expect(data.summary).toMatchObject({ lots: 1, cut: 84, good: 81, packed: 81, reject: 1 });

    const items = (await owner.get("/api/v1/godown/finished-goods/items")).body.data.items;

    expect(items[0]).toMatchObject({ articleName: "Polo", packed: 81, dispatched: 1, inStock: 80, lots: 1 });
  });
});

describe("godown permissions", () => {
  it("lets godown staff dispatch, packing staff and viewers only look", async () => {
    const { articleId } = await packed();

    await createUser({ email: "godown@garment.test", role: "GODOWN_STAFF" });
    await createUser({ email: "viewer@garment.test", role: "VIEWER" });
    await createUser({ email: "packer@garment.test", role: "PACKING_STAFF" });

    const godown = await loggedInClient("godown@garment.test");
    const viewer = await loggedInClient("viewer@garment.test");
    const packer = await loggedInClient("packer@garment.test");

    expect((await viewer.get("/api/v1/godown/stock")).status).toBe(200);
    expect((await dispatch(viewer, articleId, [["S", 1]])).status).toBe(403);
    expect((await packer.get("/api/v1/godown/stock")).status).toBe(403);
    expect((await dispatch(godown, articleId, [["S", 1]])).status).toBe(201);
  });
});
