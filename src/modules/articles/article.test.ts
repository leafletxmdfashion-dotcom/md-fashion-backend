import { beforeEach, describe, expect, it } from "vitest";

import { cutLot, karigar, post, stitch, stitchedLot, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql } from "../../test/helpers";

beforeEach(resetDatabase);

interface Option {
  id: string;
  name: string;
  lots: number;
}

describe("item list", () => {
  it("remembers typed items with how many lots use them", async () => {
    const { owner, fabricId, masterId } = await stitchedLot("Trouser");

    await cutLot(owner, fabricId, masterId, "Shirt", "LOT-2");

    const options = (await owner.get("/api/v1/articles/options")).body.data.articles as Option[];

    expect(options.map((option) => [option.name, option.lots])).toEqual([
      ["Shirt", 1],
      ["Trouser", 1],
    ]);
  });
});

describe("delete item", () => {
  it("deletes an item typed by mistake, never one in use", async () => {
    const { owner, articleId } = await stitchedLot("Trouser");

    await sql(`INSERT INTO articles (code, name, created_by) SELECT 'ART-0099', 'Trousr', id FROM users LIMIT 1`);

    const typo = (await sql("SELECT id FROM articles WHERE name = 'Trousr'")).rows[0].id as string;

    expect((await owner.send("delete", `/api/v1/articles/${articleId}`)).status).toBe(409);
    expect((await owner.send("delete", `/api/v1/articles/${typo}`)).status).toBe(200);
    expect((await sql("SELECT count(*)::int AS n FROM articles")).rows[0].n).toBe(1);
  });
});

describe("merge items", () => {
  it("moves lots and godown stock of near-duplicates into the item kept", async () => {
    const { owner, fabricId, masterId, teamId, lotId, articleId } = await stitchedLot("Trouser");
    const other = await cutLot(owner, fabricId, masterId, "Black trouser", "LOT-2");

    await stitch(owner, other.lotId, teamId);

    const packer = await karigar(owner, "Puja", "PACKER", 1);

    for (const lot of [lotId, other.lotId]) {
      await post(owner, "/api/v1/packing/entries", {
        lotId: lot,
        packerId: packer,
        packDate: today,
        lines: [{ sizeLabel: "M", quantity: 10 }],
      });
    }

    const self = await owner.send("post", "/api/v1/articles/merge", { targetId: articleId, sourceIds: [articleId] });

    expect(self.status).toBe(400);

    const res = await owner.send("post", "/api/v1/articles/merge", {
      targetId: articleId,
      sourceIds: [other.articleId],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ article: { id: articleId, name: "Trouser" }, lots: 1, removed: 1 });
    expect((await sql("SELECT lot_number, article_name FROM production_lots ORDER BY lot_number")).rows).toEqual([
      { lot_number: "LOT-1", article_name: "Trouser" },
      { lot_number: "LOT-2", article_name: "Trouser" },
    ]);
    expect((await sql("SELECT size_label, balance FROM godown_stock WHERE balance > 0")).rows).toEqual([
      { size_label: "M", balance: 20 },
    ]);
    expect((await sql("SELECT count(*)::int AS n FROM articles")).rows[0].n).toBe(1);

    // Stock still moves normally after the merge.
    const out = await owner.send("post", "/api/v1/godown/dispatches", {
      dispatchDate: today,
      party: "Shop",
      lines: [{ articleId, sizeLabel: "M", quantity: 20 }],
    });

    expect(out.status).toBe(201);
  });

  it("is only for people who manage production", async () => {
    const { articleId } = await stitchedLot("Trouser");

    await createUser({ email: "viewer@garment.test", role: "VIEWER" });

    const viewer = await loggedInClient("viewer@garment.test");

    expect((await viewer.send("delete", `/api/v1/articles/${articleId}`)).status).toBe(403);
    expect(
      (await viewer.send("post", "/api/v1/articles/merge", { targetId: articleId, sourceIds: [] })).status,
    ).toBe(403);
  });
});
