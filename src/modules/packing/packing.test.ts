import { beforeEach, describe, expect, it } from "vitest";

import { karigar, packingTeam, post, stitchedLot, today } from "../../test/fixtures";
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

async function ledger(karigarId: string) {
  return (
    await sql(
      "SELECT type, source_type, amount::text AS amount FROM karigar_ledger WHERE karigar_id = $1 ORDER BY seq",
      [karigarId],
    )
  ).rows as { type: string; source_type: string; amount: string }[];
}

/** A stitched lot and a packing team of Puja, Raju and Asha. */
async function setup() {
  const lot = await stitchedLot();
  const puja = await karigar(lot.owner, "Puja", "PACKING_STAFF");
  const raju = await karigar(lot.owner, "Raju", "PACKING_STAFF");
  const asha = await karigar(lot.owner, "Asha", "PACKING_STAFF");
  const teamId = await packingTeam(lot.owner, "Pack A", [puja, raju, asha]);

  return { ...lot, puja, raju, asha, teamId };
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
  it("packs per size by a team at a rate, splits the pay equally, books the cost and fills the godown", async () => {
    const { owner, lotId, teamId, puja, asha } = await setup();

    const over = await owner.send("post", "/api/v1/packing/entries", {
      lotId,
      teamId,
      rate: 1,
      packDate: today,
      lines: [{ sizeLabel: "M", quantity: 41 }],
    });

    expect(over.status).toBe(400);
    expect(over.body.error.details["lines.0.quantity"][0]).toMatch(/Only 40 pieces of M/);

    const nobody = await owner.send("post", "/api/v1/packing/entries", {
      lotId,
      rate: 2,
      packDate: today,
      lines: [{ sizeLabel: "M", quantity: 1 }],
    });

    expect(nobody.status).toBe(400);
    expect(nobody.body.error.details.teamId[0]).toMatch(/team or person/);

    const entry = (
      await post(owner, "/api/v1/packing/entries", {
        lotId,
        teamId,
        rate: 1.01,
        packDate: today,
        lines: [
          { sizeLabel: "S", quantity: 20 },
          { sizeLabel: "M", quantity: 30 },
        ],
      })
    ).entry;

    // 50 pieces × Rs 1.01 = Rs 50.50 over three: 16.84, 16.83, 16.83 (leftover paisa by name: Asha first).
    expect(entry).toMatchObject({
      pieces: 50,
      rate: "1.01",
      earning: "50.50",
      status: "POSTED",
      packedBy: { kind: "TEAM", id: teamId, name: "Pack A" },
    });
    expect(entry.members.map((member: { name: string; earning: string }) => [member.name, member.earning])).toEqual([
      ["Asha", "16.84"],
      ["Puja", "16.83"],
      ["Raju", "16.83"],
    ]);
    expect(await ledger(asha)).toEqual([{ type: "EARNING", source_type: "PACKING", amount: "16.84" }]);
    expect(await ledger(puja)).toEqual([{ type: "EARNING", source_type: "PACKING", amount: "16.83" }]);
    expect((await sql("SELECT amount::text AS amount FROM lot_costs WHERE kind = 'PACKING_LABOUR'")).rows).toEqual([
      { amount: "50.50" },
    ]);
    expect(await stock()).toEqual([
      { name: "Polo", size: "M", balance: 30 },
      { name: "Polo", size: "S", balance: 20 },
    ]);
    expect((await queue(owner)).totals).toEqual({ good: 81, packed: 50, waiting: 31 });

    // The next entry for the same item prefills this rate.
    expect((await owner.get(`/api/v1/packing/last-rate?lotId=${lotId}&teamId=${teamId}`)).body.data.rate).toBe("1.01");
    expect((await owner.get(`/api/v1/teams/${teamId}`)).body.data.team.packedThisMonth).toBe(50);
  });

  it("only takes active packing teams", async () => {
    const { owner, lotId, teamId: jogadi } = await stitchedLot();
    const body = { lotId, rate: 1, packDate: today, lines: [{ sizeLabel: "S", quantity: 1 }] };

    const wrongKind = await owner.send("post", "/api/v1/packing/entries", { ...body, teamId: jogadi });

    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error.details.teamId[0]).toMatch(/active packing team/);

    const puja = await karigar(owner, "Puja", "PACKING_STAFF");
    const teamId = await packingTeam(owner, "Pack B", [puja]);
    const off = await owner.send("put", `/api/v1/teams/${teamId}`, {
      name: "Pack B",
      active: false,
      members: [{ karigarId: puja }],
    });

    expect(off.status).toBe(200);
    expect((await owner.send("post", "/api/v1/packing/entries", { ...body, teamId })).status).toBe(400);
  });

  it("keeps the team as it was when packed", async () => {
    const { owner, lotId, teamId, puja, raju } = await setup();
    const entry = (
      await post(owner, "/api/v1/packing/entries", {
        lotId,
        teamId,
        rate: 3,
        packDate: today,
        lines: [{ sizeLabel: "S", quantity: 3 }],
      })
    ).entry;

    await owner.send("put", `/api/v1/teams/${teamId}`, {
      name: "Pack A",
      members: [{ karigarId: puja }, { karigarId: raju }],
    });

    const again = (await owner.get(`/api/v1/packing/entries/${entry.id}`)).body.data.entry;

    expect(again.members.map((member: { name: string }) => member.name)).toEqual(["Asha", "Puja", "Raju"]);
  });

  it("only lets one of two simultaneous packings take the last pieces", async () => {
    const { owner, lotId, teamId } = await setup();
    const body = { lotId, teamId, rate: 1, packDate: today, lines: [{ sizeLabel: "L", quantity: 15 }] };

    const results = await Promise.all([
      owner.send("post", "/api/v1/packing/entries", body),
      owner.send("post", "/api/v1/packing/entries", body),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 400]);
  });

  it("reverses an entry: pieces back to the queue, out of the godown, every share and the cost reversed, once", async () => {
    const { owner, lotId, teamId, puja, raju, asha } = await setup();
    const entry = (
      await post(owner, "/api/v1/packing/entries", {
        lotId,
        teamId,
        rate: 2,
        packDate: today,
        lines: [{ sizeLabel: "L", quantity: 21 }],
      })
    ).entry;

    const reversed = await owner.send("post", `/api/v1/packing/entries/${entry.id}/reverse`, { reason: "Wrong lot" });

    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.data.entry.status).toBe("REVERSED");
    expect((await queue(owner)).totals.waiting).toBe(81);
    expect(await stock()).toEqual([{ name: "Polo", size: "L", balance: 0 }]);

    for (const person of [puja, raju, asha]) {
      const { rows } = await sql(
        "SELECT sum(amount)::text AS net, count(*)::int AS n FROM karigar_ledger WHERE karigar_id = $1",
        [person],
      );

      expect(rows[0]).toEqual({ net: "0.00", n: 2 });
    }

    expect(
      (await sql("SELECT sum(amount)::text AS net FROM lot_costs WHERE kind = 'PACKING_LABOUR'")).rows[0].net,
    ).toBe("0.00");
    expect((await owner.send("post", `/api/v1/packing/entries/${entry.id}/reverse`, { reason: "Again" })).status).toBe(
      409,
    );
  });

  it("still shows and reverses an entry packed by one person before teams", async () => {
    const { owner, lotId, puja } = await setup();
    const entry = (
      await post(owner, "/api/v1/packing/entries", {
        lotId,
        teamId: await packingTeam(owner, "Solo", [puja]),
        rate: 1,
        packDate: today,
        lines: [{ sizeLabel: "S", quantity: 2 }],
      })
    ).entry;

    // Turn it into an entry from before teams: one packer, no team.
    await sql("DELETE FROM packing_entry_members WHERE entry_id = $1", [entry.id]);
    await sql(
      "UPDATE packing_entries SET team_id = NULL, team_name = NULL, packer_id = $2, packer_name = 'Puja' WHERE id = $1",
      [entry.id, puja],
    );

    const old = (await owner.get(`/api/v1/packing/entries/${entry.id}`)).body.data.entry;

    expect(old.packedBy).toEqual({ kind: "PERSON", id: puja, name: "Puja" });
    expect((await owner.get("/api/v1/packing/staff")).body.data.staff[0]).toMatchObject({
      kind: "PERSON",
      name: "Puja",
      code: "K-004",
    });
    expect((await owner.send("post", `/api/v1/packing/entries/${entry.id}/reverse`, { reason: "Old" })).status).toBe(
      200,
    );
    expect(
      (await sql("SELECT sum(amount)::text AS net FROM karigar_ledger WHERE karigar_id = $1", [puja])).rows[0].net,
    ).toBe("0.00");
  });

  it("blocks reversing a stitching receipt whose pieces were packed", async () => {
    const { owner, lotId, receiptId, teamId } = await setup();

    await post(owner, "/api/v1/packing/entries", {
      lotId,
      teamId,
      rate: 1,
      packDate: today,
      lines: [{ sizeLabel: "S", quantity: 1 }],
    });

    const res = await owner.send("post", `/api/v1/stitching/receipts/${receiptId}/reverse`, {
      reason: "Counted twice",
    });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/packed/);
  });
});

describe("packing reports", () => {
  it("lists entries and their lines with filters, and sums each team's pieces and pay", async () => {
    const { owner, lotId, teamId, puja, raju } = await setup();
    const solo = await packingTeam(owner, "Solo Raju", [raju]);

    await post(owner, "/api/v1/packing/entries", {
      lotId,
      teamId,
      rate: 1,
      packDate: today,
      lines: [{ sizeLabel: "S", quantity: 12 }],
    });
    await post(owner, "/api/v1/packing/entries", {
      lotId,
      teamId: solo,
      rate: 2,
      packDate: today,
      lines: [
        { sizeLabel: "M", quantity: 5 },
        { sizeLabel: "L", quantity: 5 },
      ],
    });

    const all = (await owner.get("/api/v1/packing/entries")).body.data;

    expect(all.total).toBe(2);
    expect(all.summary).toMatchObject({ entries: 2, pieces: 22, earning: "32.00" });

    const solos = (await owner.get(`/api/v1/packing/entries?teamId=${solo}`)).body.data;

    expect(solos.entries.map((entry: { packedBy: { name: string } }) => entry.packedBy.name)).toEqual(["Solo Raju"]);
    // Raju packed in both teams; Puja only in Pack A.
    expect((await owner.get(`/api/v1/packing/entries?packerId=${raju}`)).body.data.total).toBe(2);
    expect((await owner.get(`/api/v1/packing/entries?packerId=${puja}`)).body.data.total).toBe(1);
    expect((await owner.get("/api/v1/packing/entries?search=solo")).body.data.total).toBe(1);

    const lines = (await owner.get(`/api/v1/packing/lines?dateFrom=${today}&dateTo=${today}`)).body.data;

    expect(lines.total).toBe(3);
    expect(lines.lines[0]).toMatchObject({ date: today, packedBy: { name: expect.any(String) }, articleName: "Polo" });

    const staff = (await owner.get("/api/v1/packing/staff")).body.data.staff as {
      name: string;
      members: string;
      pieces: number;
      entries: number;
      earned: string | null;
    }[];

    expect(staff.map((row) => [row.name, row.pieces, row.entries, row.earned, row.members])).toEqual([
      ["Pack A", 12, 1, "12.00", "Asha, Puja, Raju"],
      ["Solo Raju", 10, 1, "20.00", "Raju"],
    ]);

    const summary = (await owner.get("/api/v1/packing/summary")).body.data;

    expect(summary).toMatchObject({
      waiting: 59,
      packedToday: 22,
      packedThisMonth: 22,
      packedTotal: 22,
      packersToday: 2,
    });
  });
});

describe("packing permissions", () => {
  it("lets packing staff pack at a typed rate without seeing money, and viewers only look", async () => {
    const { owner, lotId, teamId } = await setup();

    await createUser({ email: "packer@garment.test", role: "PACKING_STAFF" });
    await createUser({ email: "viewer@garment.test", role: "VIEWER" });

    const staff = await loggedInClient("packer@garment.test");
    const viewer = await loggedInClient("viewer@garment.test");
    const body = { lotId, teamId, rate: 1.25, packDate: today, lines: [{ sizeLabel: "S", quantity: 4 }] };

    expect((await viewer.get("/api/v1/packing/queue")).status).toBe(200);
    expect((await viewer.send("post", "/api/v1/packing/entries", body)).status).toBe(403);
    // Packing staff choose the team in the form.
    expect((await staff.get("/api/v1/teams?kind=PACKING&active=true")).status).toBe(200);

    const entry = (await post(staff, "/api/v1/packing/entries", body)).entry;

    expect(entry).toMatchObject({ pieces: 4, rate: null, earning: null });
    expect(entry.members.every((member: { earning: string | null }) => member.earning === null)).toBe(true);
    expect((await staff.get(`/api/v1/packing/last-rate?lotId=${lotId}`)).body.data.rate).toBeNull();
    expect((await owner.get(`/api/v1/packing/entries/${entry.id}`)).body.data.entry).toMatchObject({
      rate: "1.25",
      earning: "5.00",
    });
  });
});

describe("one packer and rate pending", () => {
  const totals = async (lotId: string) =>
    (
      await sql(
        "SELECT COALESCE(sum(amount), 0)::numeric(14, 2)::text AS amount FROM lot_costs WHERE lot_id = $1 AND kind = 'PACKING_LABOUR'",
        [lotId],
      )
    ).rows[0].amount as string;

  it("packs by one person without a team, at a rate set later, then changed, then reversed back to zero", async () => {
    const { owner, lotId, puja } = await setup();

    const entry = (
      await post(owner, "/api/v1/packing/entries", {
        lotId,
        packerId: puja,
        packDate: today,
        lines: [{ sizeLabel: "S", quantity: 10 }],
      })
    ).entry as { id: string; packedBy: { kind: string; name: string } };

    expect(entry).toMatchObject({ packedBy: { kind: "PERSON", name: "Puja" }, ratePending: true, earning: "0.00" });
    // Pieces are in the godown; nobody is paid yet.
    expect(await stock()).toEqual([{ name: "Polo", size: "S", balance: 10 }]);
    expect(await ledger(puja)).toEqual([]);
    expect((await owner.get("/api/v1/packing/entries?ratePending=1")).body.data.total).toBe(1);

    const set = await owner.send("post", `/api/v1/packing/entries/${entry.id}/rate`, { rate: 2 });

    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.entry).toMatchObject({ rate: "2.00", earning: "20.00", ratePending: false });
    expect(await ledger(puja)).toEqual([{ type: "EARNING", source_type: "PACKING", amount: "20.00" }]);
    expect((await owner.get("/api/v1/packing/entries?ratePending=1")).body.data.total).toBe(0);

    // Changing a paid rate needs a reason and posts only the difference.
    expect((await owner.send("post", `/api/v1/packing/entries/${entry.id}/rate`, { rate: 2.5 })).status).toBe(400);

    const changed = await owner.send("post", `/api/v1/packing/entries/${entry.id}/rate`, {
      rate: 2.5,
      reason: "Agreed rate",
    });

    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.entry.rateChanges).toEqual([
      expect.objectContaining({ oldRate: null, newRate: "2.00" }),
      expect.objectContaining({ oldRate: "2.00", newRate: "2.50", pieces: 10, amount: "5.00", reason: "Agreed rate" }),
    ]);
    expect((await ledger(puja)).at(-1)).toEqual({ type: "EARNING", source_type: "RATE_CHANGE", amount: "5.00" });
    expect(await totals(lotId)).toBe("25.00");

    expect(
      (await owner.send("post", `/api/v1/packing/entries/${entry.id}/reverse`, { reason: "Wrong lot" })).status,
    ).toBe(200);

    const balance = (await sql("SELECT sum(amount)::text AS total FROM karigar_ledger WHERE karigar_id = $1", [puja]))
      .rows[0].total as string;

    expect(balance).toBe("0.00");
    expect(await totals(lotId)).toBe("0.00");
  });

  it("splits a set rate equally over a team and refuses a rate on a reversed entry", async () => {
    const { owner, lotId, teamId, puja, raju, asha } = await setup();
    const entry = (
      await post(owner, "/api/v1/packing/entries", {
        lotId,
        teamId,
        packDate: today,
        lines: [{ sizeLabel: "M", quantity: 5 }],
      })
    ).entry as { id: string };

    expect((await owner.send("post", `/api/v1/packing/entries/${entry.id}/rate`, { rate: 1 })).status).toBe(200);

    // Rs 5 over three people: 1.67 + 1.67 + 1.66, leftover paisa by name (Asha, Puja, Raju).
    expect([await ledger(asha), await ledger(puja), await ledger(raju)].map((rows) => rows[0]!.amount)).toEqual([
      "1.67",
      "1.67",
      "1.66",
    ]);

    expect(
      (await owner.send("post", `/api/v1/packing/entries/${entry.id}/reverse`, { reason: "Recount" })).status,
    ).toBe(200);

    expect(
      (await owner.send("post", `/api/v1/packing/entries/${entry.id}/rate`, { rate: 2, reason: "x" })).status,
    ).toBe(409);
  });
});
