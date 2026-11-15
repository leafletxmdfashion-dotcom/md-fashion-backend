import { beforeEach, describe, expect, it } from "vitest";

import { karigar, packingTeam, post, stitchedLot, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase } from "../../test/helpers";
import { toSeries } from "./dashboard";

beforeEach(resetDatabase);

describe("dashboard", () => {
  it("adds up the flow, where pieces are now, teams, items and money for the range", async () => {
    const { owner, lotId, articleId } = await stitchedLot();
    const teamId = await packingTeam(owner, "Pack A", [await karigar(owner, "Puja", "PACKER")]);

    await post(owner, "/api/v1/packing/entries", {
      lotId,
      teamId,
      rate: 2,
      packDate: today,
      lines: [{ sizeLabel: "M", quantity: 30 }],
    });
    await post(owner, "/api/v1/godown/dispatches", {
      dispatchDate: today,
      party: "Shop",
      lines: [{ articleId, sizeLabel: "M", quantity: 10 }],
    });

    const res = await owner.get(`/api/v1/dashboard?from=${today}&to=${today}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const data = res.body.data;

    expect(data.range).toMatchObject({ days: 1, bucket: "day" });
    expect(data.flow.totals).toEqual({ cut: 84, good: 81, packed: 30, dispatched: 10 });
    expect(data.flow.series).toEqual([{ date: today, cut: 84, good: 81, packed: 30, dispatched: 10 }]);
    expect(data.pipeline).toMatchObject({ toPack: 51, inGodown: 20, inRework: 2 });
    expect(data.rejects).toEqual({ rejected: 1, sentToRework: 2 });
    expect(data.teams.jogadi[0]).toMatchObject({ name: "Team Ram", pieces: 81 });
    expect(data.teams.packing[0]).toMatchObject({ name: "Pack A", pieces: 30 });
    expect(data.items.packed[0]).toMatchObject({ name: "Polo", pieces: 30 });
    expect(data.items.inStock[0]).toMatchObject({ name: "Polo", pieces: 20 });
    expect(data.costs.find((row: { kind: string }) => row.kind === "PACKING_LABOUR").amount).toBe("60.00");
    expect(Number(data.payments.payable)).toBeGreaterThan(0);
    expect(data.recent.length).toBeGreaterThan(0);

    expect((await owner.get("/api/v1/dashboard?from=2026-01-01&to=2027-06-01")).status).toBe(400);
    expect((await owner.get(`/api/v1/dashboard?from=${today}&to=2000-01-01`)).status).toBe(400);
  });

  it("sends each section only to people who may see it, and money only with costing", async () => {
    await stitchedLot();
    await createUser({ email: "packer@garment.test", role: "PACKING_STAFF" });

    const packer = await loggedInClient("packer@garment.test");
    const data = (await packer.get("/api/v1/dashboard")).body.data;

    expect(data.flow).not.toBeNull();
    expect(data.teams.packing).toEqual([]);
    expect(data.teams.jogadi === null || Array.isArray(data.teams.jogadi)).toBe(true);
    expect(data.costs).toBeNull();
    expect(data.payments).toBeNull();
    expect(data.recent).toBeNull();
    expect(data.range.days).toBe(30);
  });

  it("rolls long ranges up into weeks from Monday, zeros included", () => {
    const series = toSeries(
      [
        { day: "2026-11-03", flow: "cut", pieces: 5 },
        { day: "2026-11-09", flow: "cut", pieces: 7 },
      ],
      { from: "2026-11-04", to: "2026-11-20" },
      true,
    );

    expect(series.map((point) => [point.date, point.cut])).toEqual([
      ["2026-11-02", 5],
      ["2026-11-09", 7],
      ["2026-11-16", 0],
    ]);
  });
});
