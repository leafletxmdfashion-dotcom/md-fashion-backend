import { beforeEach, describe, expect, it } from "vitest";

import { createUser, loggedInClient, resetDatabase, sql, type TestClient } from "../../test/helpers";
import { splitEarning, toPaisa } from "./stitching.split";

beforeEach(resetDatabase);

const today = new Date().toISOString().slice(0, 10);

interface IssueLine {
  id: string;
  colour: string;
  sizeLabel: string;
  quantity: number;
  received: number;
  outstanding: number;
}

interface Issue {
  id: string;
  number: number;
  status: string;
  rate: string | null;
  members: { karigarId: string; name: string; sharePercent: number | null }[];
  lines: IssueLine[];
  receipts: {
    id: string;
    good: number;
    earning: string | null;
    status: string;
    allocations: { karigarId: string; amount: string }[] | null;
  }[];
}

// Supertest bodies are untyped; each caller narrows what it reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(client: TestClient, url: string, body: object, status = 201): Promise<any> {
  const res = await client.send("post", url, body);

  expect(res.status, JSON.stringify(res.body)).toBe(status);

  return res.body.data;
}

async function karigar(owner: TestClient, name: string, category = "TAILOR") {
  // SAFETY: post() asserted the 201, so the karigar DTO is present.
  return (await post(owner, "/api/v1/karigars", { name, category, payMode: "PER_PIECE", payRate: 0 })).karigar
    .id as string;
}

/**
 * A finalized cutting of LOT-1: Black 30.5 kg and Blue 15 kg at 2.13 kg per Pala,
 * ratio S1 M2 L1 → Black S14 M28 L14, Blue S7 M14 L7.
 */
async function setup() {
  await createUser({ email: "owner@garment.test", role: "OWNER" });
  await createUser({ email: "staff@garment.test", role: "STAFF" });
  await createUser({ email: "viewer@garment.test", role: "VIEWER" });

  const owner = await loggedInClient("owner@garment.test");

  // SAFETY: post() asserted the 201, so the inward DTO is present.
  const fabricId = (
    await post(owner, "/api/v1/fabrics/inwards", {
      fabricName: "Jersey",
      unit: "KG",
      inwardDate: today,
      quantity: 100,
      rate: 500,
    })
  ).inward.fabric.id as string;

  const masterId = await karigar(owner, "Cutter", "CUTTING_MASTER");
  const ram = await karigar(owner, "Ram");
  const sita = await karigar(owner, "Sita");
  const hari = await karigar(owner, "Hari");

  const created = await post(owner, "/api/v1/production-lots", {
    lotNumber: "LOT-1",
    article: { name: "Polo" },
    fabricId,
    productionDate: today,
    targetQuantity: null,
    cutting: {
      cuttingMasterId: masterId,
      cuttingDate: today,
      marker: { measuredPalaKg: "2.130", weightSource: "MEASURED", repetitionsPerLayer: 1 },
      sizes: [
        { label: "S", piecesPerPala: 1 },
        { label: "M", piecesPerPala: 2 },
        { label: "L", piecesPerPala: 1 },
      ],
      colours: [
        { name: "Black", rolls: [{ issuedKg: "30.5" }] },
        { name: "Blue", rolls: [{ issuedKg: "15" }] },
      ],
    },
  });

  await post(owner, `/api/v1/cutting-batches/${created.batch.id}/finalize`, {});

  // SAFETY: post() asserted the 201, so the team DTO is present.
  const team = (
    await post(owner, "/api/v1/jogadi", { name: "Team Ram", members: [{ karigarId: ram }, { karigarId: sita }] })
  ).team as {
    id: string;
  };

  return {
    owner,
    lotId: created.lot.id as string,
    batchId: created.batch.id as string,
    teamId: team.id,
    ram,
    sita,
    hari,
  };
}

async function issue(
  client: TestClient,
  lotId: string,
  teamId: string,
  lines: [string, string, number][],
  rate = 12.5,
) {
  return (
    await post(client, "/api/v1/stitching/issues", {
      lotId,
      operation: "Full stitching",
      rate,
      issueDate: today,
      teams: [{ teamId, lines: lines.map(([colour, sizeLabel, quantity]) => ({ colour, sizeLabel, quantity })) }],
    })
  ).issues[0] as Issue;
}

const lineOf = (issued: Issue, colour: string, size: string) =>
  issued.lines.find((line) => line.colour === colour && line.sizeLabel === size)!;

async function ledger() {
  const { rows } = await sql(
    `SELECT k.name, l.type, l.source_type, l.amount::text AS amount
     FROM karigar_ledger l JOIN karigars k ON k.id = l.karigar_id WHERE l.source_type <> 'CUTTING' ORDER BY l.seq`,
  );

  return rows as { name: string; type: string; source_type: string; amount: string }[];
}

describe("earning split", () => {
  const members = (...shares: (number | null)[]) =>
    shares.map((share, index) => ({ karigarId: `k${index}`, shareHundredths: share }));

  it("splits equally without losing or inventing a paisa", () => {
    const result = splitEarning(100n, "EQUAL", members(null, null, null));

    expect(result.ok && [...result.amounts.values()]).toEqual([34n, 33n, 33n]);
  });

  it("splits by percentages that make exactly 100%", () => {
    const result = splitEarning(35_000n, "PERCENT", members(6000, 4000));

    expect(result.ok && [...result.amounts.values()]).toEqual([21_000n, 14_000n]);
    expect(splitEarning(1n, "PERCENT", members(3333, 3333, 3334)).ok).toBe(true);
    expect(splitEarning(100n, "PERCENT", members(5000, 4000))).toMatchObject({ ok: false });
  });

  it("accepts direct amounts only when they total the team earning", () => {
    const direct = [
      { karigarId: "a", amountPaisa: toPaisa(200) },
      { karigarId: "b", amountPaisa: toPaisa("150.5") },
    ];

    expect(splitEarning(35_050n, "AMOUNT", direct).ok).toBe(true);
    expect(splitEarning(35_000n, "AMOUNT", direct)).toMatchObject({ ok: false });
    expect(toPaisa(0.1)).toBe(10n);
  });
});

describe("jogadi teams", () => {
  it("keeps membership history, validates shares and counts the pieces a team holds", async () => {
    const { owner, lotId, teamId, ram, sita, hari } = await setup();

    expect(
      (await owner.send("post", "/api/v1/jogadi", { name: "team ram", members: [{ karigarId: hari }] })).status,
    ).toBe(409);
    // A refused duplicate does not use up a team code.
    const next = await post(owner, "/api/v1/jogadi", { name: "Team Hari", members: [{ karigarId: hari }] });
    expect(next.team.code).toBe("JG-002");

    const badShares = await owner.send("post", "/api/v1/jogadi", {
      name: "Team Hari",
      members: [
        { karigarId: ram, sharePercent: 60 },
        { karigarId: hari, sharePercent: 30 },
      ],
    });

    expect(badShares.status).toBe(400);
    expect(JSON.stringify(badShares.body.error.details)).toMatch(/exactly 100%/);

    await issue(owner, lotId, teamId, [["Black", "S", 10]]);

    // Sita leaves, Hari joins: the issued work keeps Ram and Sita.
    const updated = await owner.send("put", `/api/v1/jogadi/${teamId}`, {
      name: "Team Ram",
      members: [{ karigarId: ram }, { karigarId: hari }],
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data.team.members.map((member: { name: string }) => member.name)).toEqual(["Ram", "Hari"]);
    expect(updated.body.data.team.piecesHeld).toBe(10);
    expect(
      (await sql("SELECT count(*)::int AS n FROM jogadi_members WHERE karigar_id = $1 AND left_at IS NOT NULL", [sita]))
        .rows[0].n,
    ).toBe(1);

    const issues = (await owner.get("/api/v1/stitching/issues")).body.data.issues as { id: string }[];
    const detail = (await owner.get(`/api/v1/stitching/issues/${issues[0]!.id}`)).body.data.issue as Issue;

    expect(detail.members.map((member) => member.name)).toEqual(["Ram", "Sita"]);
  });
});

describe("stitching issue", () => {
  it("issues no more than the cut pieces waiting, and blocks reversing the cutting underneath", async () => {
    const { owner, lotId, teamId, batchId } = await setup();

    const tooMany = await owner.send("post", "/api/v1/stitching/issues", {
      lotId,
      operation: "Full stitching",
      rate: 10,
      issueDate: today,
      teams: [{ teamId, lines: [{ colour: "Black", sizeLabel: "M", quantity: 29 }] }],
    });

    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.details["teams.0.lines.0.quantity"][0]).toMatch(/Only 28 pieces/);

    const issued = await issue(owner, lotId, teamId, [
      ["Black", "M", 28],
      ["Blue", "S", 5],
    ]);

    expect(issued.lines.map((line) => [line.colour, line.sizeLabel, line.outstanding])).toEqual([
      ["Black", "M", 28],
      ["Blue", "S", 5],
    ]);

    const balance = (await owner.get(`/api/v1/stitching/lots/${lotId}/balance`)).body.data;

    expect(balance.totals).toMatchObject({ cut: 84, unissued: 51, issued: 33, wip: 33, good: 0 });
    expect(
      balance.rows.find((row: { colour: string; size: string }) => row.colour === "Black" && row.size === "M"),
    ).toMatchObject({
      unissued: 0,
      wip: 28,
    });

    expect(
      (await owner.send("post", `/api/v1/cutting-batches/${batchId}/reverse`, { reason: "Wrong marker" })).status,
    ).toBe(409);
  });

  it("divides one lot between several Jogadi teams in one posting, never more than is waiting", async () => {
    const { owner, lotId, teamId, hari } = await setup();
    // SAFETY: post() asserted the 201, so the team DTO is present.
    const second = (await post(owner, "/api/v1/jogadi", { name: "Team Hari", members: [{ karigarId: hari }] }))
      .team as {
      id: string;
    };
    const divide = (black: [number, number]) =>
      owner.send("post", "/api/v1/stitching/issues", {
        lotId,
        operation: "Full stitching",
        rate: 10,
        issueDate: today,
        teams: [
          { teamId, lines: [{ colour: "Black", sizeLabel: "M", quantity: black[0] }] },
          { teamId: second.id, lines: [{ colour: "Black", sizeLabel: "M", quantity: black[1] }] },
        ],
      });

    // 28 Black M are waiting: 15 + 14 is one too many, and nothing is posted.
    const over = await divide([15, 14]);

    expect(over.status).toBe(400);
    expect(over.body.error.details["teams.1.lines.0.quantity"][0]).toMatch(/Only 13 pieces .* left for this team/);
    expect((await sql("SELECT count(*)::int AS n FROM stitching_issues")).rows[0].n).toBe(0);

    const same = await owner.send("post", "/api/v1/stitching/issues", {
      lotId,
      operation: "Full stitching",
      rate: 10,
      issueDate: today,
      teams: [
        { teamId, lines: [{ colour: "Black", sizeLabel: "M", quantity: 1 }] },
        { teamId, lines: [{ colour: "Black", sizeLabel: "S", quantity: 1 }] },
      ],
    });

    expect(same.status).toBe(400);

    const res = await divide([14, 14]);

    expect(res.status).toBe(201);
    expect(
      res.body.data.issues.map((issue: Issue & { team: { name: string } }) => [
        issue.team.name,
        issue.lines[0]!.quantity,
      ]),
    ).toEqual([
      ["Team Ram", 14],
      ["Team Hari", 14],
    ]);
    expect((await owner.get(`/api/v1/stitching/lots/${lotId}/balance`)).body.data.totals).toMatchObject({
      issued: 28,
      wip: 28,
    });
  });

  it("lets only one of two simultaneous issues take the last pieces", async () => {
    const { owner, lotId, teamId } = await setup();

    const body = {
      lotId,
      operation: "Full stitching",
      rate: 10,
      issueDate: today,
      teams: [{ teamId, lines: [{ colour: "Blue", sizeLabel: "L", quantity: 5 }] }],
    };

    const results = await Promise.all([
      owner.send("post", "/api/v1/stitching/issues", body),
      owner.send("post", "/api/v1/stitching/issues", body),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 400]);
    expect(
      (
        await sql(
          "SELECT sum(available_for_stitching)::int AS n FROM cutting_outputs WHERE colour_name = 'Blue' AND size_label = 'L'",
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it("reverses an issue nothing came back from, putting the pieces back to wait", async () => {
    const { owner, lotId, teamId, batchId } = await setup();
    const issued = await issue(owner, lotId, teamId, [["Black", "L", 14]]);

    const reversed = await owner.send("post", `/api/v1/stitching/issues/${issued.id}/reverse`, {
      reason: "Wrong team",
    });

    expect(reversed.status).toBe(200);
    expect(reversed.body.data.issue.status).toBe("REVERSED");
    expect((await owner.get(`/api/v1/stitching/lots/${lotId}/balance`)).body.data.totals).toMatchObject({
      unissued: 84,
      wip: 0,
    });
    expect(
      (await owner.send("post", `/api/v1/stitching/issues/${issued.id}/reverse`, { reason: "Again" })).status,
    ).toBe(409);
    // Nothing in stitching any more, so the cutting can be reversed again.
    expect(
      (await owner.send("post", `/api/v1/cutting-batches/${batchId}/reverse`, { reason: "Wrong marker" })).status,
    ).toBe(201);
  });
});

describe("stitching receipt", () => {
  it("receives Good, Rework and Reject, pays the team for Good pieces and books the labour cost", async () => {
    const { owner, lotId, teamId } = await setup();

    const issued = await issue(owner, lotId, teamId, [
      ["Black", "S", 10],
      ["Black", "M", 20],
    ]);

    const s = lineOf(issued, "Black", "S");
    const m = lineOf(issued, "Black", "M");

    const over = await owner.send("post", `/api/v1/stitching/issues/${issued.id}/receipts`, {
      receiptDate: today,
      lines: [{ issueLineId: s.id, good: 11, rework: 0, reject: 0 }],
    });

    expect(over.status).toBe(400);
    expect(over.body.error.details["lines.0.good"][0]).toMatch(/team holds 10 pieces/);

    const noReason = await owner.send("post", `/api/v1/stitching/issues/${issued.id}/receipts`, {
      receiptDate: today,
      lines: [{ issueLineId: s.id, good: 0, rework: 0, reject: 1 }],
    });

    expect(noReason.body.error.details["lines.0.rejectReason"]).toBeDefined();

    // Reasons come from the list; "Other" needs a note, as the receive dialog asks.
    for (const rejectReason of ["Other", "Other:  ", "<b>made up reason</b>"]) {
      const bad = await owner.send("post", `/api/v1/stitching/issues/${issued.id}/receipts`, {
        receiptDate: today,
        lines: [{ issueLineId: s.id, good: 0, rework: 0, reject: 1, rejectReason }],
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details["lines.0.rejectReason"]).toBeDefined();
    }

    // SAFETY: post() asserted the 201, so the issue DTO is present.
    const received = (
      await post(owner, `/api/v1/stitching/issues/${issued.id}/receipts`, {
        receiptDate: today,
        lines: [
          { issueLineId: s.id, good: 8, rework: 1, reject: 1, rejectReason: "Hole or tear" },
          { issueLineId: m.id, good: 20, rework: 0, reject: 0 },
        ],
      })
    ).issue as Issue;

    // 28 Good × Rs 12.50 = Rs 350, equal split.
    expect(received.receipts[0]).toMatchObject({ good: 28, earning: "350.00" });
    expect(received.lines.map((line) => line.outstanding)).toEqual([0, 0]);
    expect(await ledger()).toEqual([
      { name: "Ram", type: "EARNING", source_type: "STITCHING", amount: "175.00" },
      { name: "Sita", type: "EARNING", source_type: "STITCHING", amount: "175.00" },
    ]);
    expect((await sql("SELECT amount::text AS amount FROM lot_costs WHERE kind = 'STITCHING_LABOUR'")).rows).toEqual([
      { amount: "350.00" },
    ]);

    const balance = (await owner.get(`/api/v1/stitching/lots/${lotId}/balance`)).body.data.totals;

    expect(balance).toMatchObject({ issued: 30, received: 30, wip: 0, good: 28, rework: 1, reject: 1 });

    const rejects = (await owner.get("/api/v1/stitching/rejects")).body.data;

    expect(rejects).toMatchObject({ total: 1, pieces: 1 });
    expect(rejects.rejects[0]).toMatchObject({ reason: "Hole or tear", colour: "Black", sizeLabel: "S" });
  });

  it("splits by custom percentages or direct amounts, and never pays twice for one receipt", async () => {
    const { owner, lotId, teamId, ram, sita } = await setup();
    const issued = await issue(owner, lotId, teamId, [["Blue", "M", 14]], 10);
    const line = issued.lines[0]!;

    const receive = (good: number, split: object) =>
      owner.send("post", `/api/v1/stitching/issues/${issued.id}/receipts`, {
        receiptDate: today,
        lines: [{ issueLineId: line.id, good, rework: 0, reject: 0 }],
        split,
      });

    const percent = await receive(5, {
      method: "PERCENT",
      members: [
        { karigarId: ram, percent: 70 },
        { karigarId: sita, percent: 30 },
      ],
    });

    expect(percent.status).toBe(201);

    const wrongAmount = await receive(4, {
      method: "AMOUNT",
      members: [
        { karigarId: ram, amount: 30 },
        { karigarId: sita, amount: 5 },
      ],
    });

    expect(wrongAmount.status).toBe(400);
    expect(wrongAmount.body.error.details.split[0]).toMatch(/Rs 35\.00.*Rs 40\.00/);

    expect(
      (
        await receive(4, {
          method: "AMOUNT",
          members: [
            { karigarId: ram, amount: 40 },
            { karigarId: sita, amount: 0 },
          ],
        })
      ).status,
    ).toBe(201);
    expect(await ledger()).toEqual([
      { name: "Ram", type: "EARNING", source_type: "STITCHING", amount: "35.00" },
      { name: "Sita", type: "EARNING", source_type: "STITCHING", amount: "15.00" },
      { name: "Ram", type: "EARNING", source_type: "STITCHING", amount: "40.00" },
    ]);

    await expect(
      sql(
        `INSERT INTO karigar_ledger (karigar_id, entry_date, type, pay_mode, quantity, rate, amount, source_type, source_id, description, created_by)
         SELECT karigar_id, entry_date, type, pay_mode, quantity, rate, amount, source_type, source_id, description, created_by
         FROM karigar_ledger WHERE source_type = 'STITCHING' LIMIT 1`,
      ),
    ).rejects.toThrow(/karigar_ledger_once/);
  });

  it("reverses a receipt: pieces back with the team, earnings and cost reversed", async () => {
    const { owner, lotId, teamId } = await setup();
    const issued = await issue(owner, lotId, teamId, [["Blue", "S", 7]]);
    const line = issued.lines[0]!;

    // SAFETY: post() asserted the 201, so the issue DTO is present.
    const received = (
      await post(owner, `/api/v1/stitching/issues/${issued.id}/receipts`, {
        receiptDate: today,
        lines: [{ issueLineId: line.id, good: 6, rework: 1, reject: 0 }],
      })
    ).issue as Issue;

    expect(
      (await owner.send("post", `/api/v1/stitching/issues/${issued.id}/reverse`, { reason: "Wrong" })).status,
    ).toBe(409);

    const reversed = await owner.send("post", `/api/v1/stitching/receipts/${received.receipts[0]!.id}/reverse`, {
      reason: "Counted twice",
    });

    expect(reversed.status).toBe(200);
    expect(reversed.body.data.issue.lines[0].outstanding).toBe(7);
    expect(
      (await sql("SELECT sum(amount)::text AS net FROM karigar_ledger WHERE source_type = 'STITCHING'")).rows[0].net,
    ).toBe("0.00");
    expect(
      (await sql("SELECT sum(amount)::text AS net FROM lot_costs WHERE kind = 'STITCHING_LABOUR'")).rows[0].net,
    ).toBe("0.00");
    expect((await owner.get("/api/v1/stitching/rework")).body.data.total).toBe(0);
    expect((await owner.get(`/api/v1/stitching/lots/${lotId}/balance`)).body.data.totals).toMatchObject({
      wip: 7,
      good: 0,
      rework: 0,
    });
  });
});

describe("rework", () => {
  it("moves rework through its states; recovered pieces become Good and are paid, failed ones become Reject", async () => {
    const { owner, lotId, teamId, hari } = await setup();
    const issued = await issue(owner, lotId, teamId, [["Black", "L", 14]], 12.5);
    const line = issued.lines[0]!;

    // SAFETY: post() asserted the 201, so the issue DTO is present.
    const received = (
      await post(owner, `/api/v1/stitching/issues/${issued.id}/receipts`, {
        receiptDate: today,
        lines: [{ issueLineId: line.id, good: 10, rework: 4, reject: 0 }],
      })
    ).issue as Issue;

    const list = (await owner.get("/api/v1/stitching/rework")).body.data;

    expect(list).toMatchObject({ total: 1, pending: 4 });

    const item = list.items[0] as { id: string; status: string };

    expect(item.status).toBe("PENDING");
    expect(
      (await owner.send("put", `/api/v1/stitching/rework/${item.id}`, { status: "ASSIGNED", assignedToId: hari }))
        .status,
    ).toBe(200);

    const tooMany = await owner.send("post", `/api/v1/stitching/rework/${item.id}/resolve`, {
      resolvedOn: today,
      recovered: 5,
      failed: 0,
    });

    expect(tooMany.status).toBe(400);

    const noReason = await owner.send("post", `/api/v1/stitching/rework/${item.id}/resolve`, {
      resolvedOn: today,
      recovered: 0,
      failed: 1,
    });

    expect(noReason.body.error.details.failedReason).toBeDefined();
    const madeUp = await owner.send("post", `/api/v1/stitching/rework/${item.id}/resolve`, {
      resolvedOn: today,
      recovered: 0,
      failed: 1,
      failedReason: "Other",
    });
    expect(madeUp.body.error.details.failedReason).toBeDefined();

    await post(owner, `/api/v1/stitching/rework/${item.id}/resolve`, { resolvedOn: today, recovered: 2, failed: 0 });
    expect((await owner.get("/api/v1/stitching/rework")).body.data.items[0]).toMatchObject({
      status: "IN_PROGRESS",
      pending: 2,
    });

    await post(owner, `/api/v1/stitching/rework/${item.id}/resolve`, {
      resolvedOn: today,
      recovered: 1,
      failed: 1,
      failedReason: "Fabric defect",
    });

    // Closed: no longer in the open list, shown when filtered by status.
    expect((await owner.get("/api/v1/stitching/rework")).body.data.total).toBe(0);
    expect((await owner.get("/api/v1/stitching/rework?status=COMPLETED")).body.data.items[0]).toMatchObject({
      recovered: 3,
      failed: 1,
      pending: 0,
    });
    expect(
      (
        await owner.send("post", `/api/v1/stitching/rework/${item.id}/resolve`, {
          resolvedOn: today,
          recovered: 1,
          failed: 0,
        })
      ).status,
    ).toBe(409);

    expect((await owner.get(`/api/v1/stitching/lots/${lotId}/balance`)).body.data.totals).toMatchObject({
      good: 13,
      rework: 0,
      reject: 1,
    });

    // 10 Good at receipt (Rs 125) + 2 and 1 recovered (Rs 25, Rs 12.50), each split equally.
    const paid = await sql(
      "SELECT source_type, sum(amount)::text AS amount FROM karigar_ledger WHERE source_type <> 'CUTTING' GROUP BY 1 ORDER BY 1",
    );

    expect(paid.rows).toEqual([
      { source_type: "REWORK", amount: "37.50" },
      { source_type: "STITCHING", amount: "125.00" },
    ]);

    // Resolved rework pins the receipt.
    expect(
      (await owner.send("post", `/api/v1/stitching/receipts/${received.receipts[0]!.id}/reverse`, { reason: "Wrong" }))
        .status,
    ).toBe(409);
    expect((await owner.get("/api/v1/stitching/rejects")).body.data.rejects[0]).toMatchObject({
      reason: "Fabric defect",
      quantity: 1,
    });
  });
});

describe("stitching permissions", () => {
  it("lets viewers look, staff issue and receive without seeing money, and only managers of money split by amount", async () => {
    const { owner, lotId, teamId, ram, sita } = await setup();
    const viewer = await loggedInClient("viewer@garment.test");
    const staff = await loggedInClient("staff@garment.test");

    expect((await viewer.get("/api/v1/stitching/issues")).status).toBe(200);
    expect((await viewer.send("post", "/api/v1/stitching/issues", {})).status).toBe(403);

    const issued = await issue(staff, lotId, teamId, [["Blue", "M", 4]]);

    expect(issued.rate).toBeNull();
    expect((await owner.get(`/api/v1/stitching/issues/${issued.id}`)).body.data.issue.rate).toBe("12.50");

    const byAmount = await staff.send("post", `/api/v1/stitching/issues/${issued.id}/receipts`, {
      receiptDate: today,
      lines: [{ issueLineId: issued.lines[0]!.id, good: 4, rework: 0, reject: 0 }],
      split: {
        method: "AMOUNT",
        members: [
          { karigarId: ram, amount: 50 },
          { karigarId: sita, amount: 0 },
        ],
      },
    });

    expect(byAmount.status).toBe(403);
    expect((await staff.send("post", `/api/v1/stitching/issues/${issued.id}/reverse`, { reason: "Oops" })).status).toBe(
      403,
    );
    expect((await staff.send("post", "/api/v1/jogadi", { name: "X", members: [{ karigarId: ram }] })).status).toBe(403);
  });
});
