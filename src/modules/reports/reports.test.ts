import { beforeEach, describe, expect, it } from "vitest";

import { karigar, post, stitchedLot, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql } from "../../test/helpers";

beforeEach(resetDatabase);

interface ReportData {
  columns: { key: string; type: string; money?: boolean }[];
  rows: Record<string, string | number | null>[];
  totals: Record<string, number>;
}

describe("reports", () => {
  it("runs every report and agrees with the screens", async () => {
    const { owner, lotId } = await stitchedLot();
    const packer = await karigar(owner, "Puja", "PACKING_STAFF");

    await post(owner, "/api/v1/packing/entries", {
      lotId,
      packerId: packer,
      rate: 2,
      packDate: today,
      lines: [{ sizeLabel: "M", quantity: 30 }],
    });

    const catalog = (await owner.get("/api/v1/reports")).body.data.reports as { key: string }[];

    expect(catalog.length).toBeGreaterThanOrEqual(15);

    const results: Record<string, ReportData> = {};

    for (const { key } of catalog) {
      const res = await owner.get(`/api/v1/reports/${key}`);

      expect(res.status, `${key}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
      results[key] = res.body.data as ReportData;
      expect((await owner.get(`/api/v1/reports/${key}/export`)).status, `${key} export`).toBe(200);
    }

    expect(results["lot-production"]!.rows[0]).toMatchObject({ cut: 84, good: 81, packed: 30, toPack: 51 });
    expect(results["size-cutting"]!.totals.pieces).toBe(84);
    expect(results["jogadi-work"]!.totals.good).toBe(81);
    expect(results["packing-pending"]!.totals.waiting).toBe(51);
    expect(results["finished-goods"]!.totals.inGodown).toBe(30);

    const costTotal = Number(
      (await sql("SELECT sum(amount)::text AS t FROM lot_costs WHERE lot_id = $1", [lotId])).rows[0].t,
    );

    expect(results["manufacturing-cost"]!.totals.total).toBeCloseTo(costTotal, 2);
    expect(Number(results["manufacturing-cost"]!.rows[0]!.perPiece)).toBeCloseTo(costTotal / 30, 2);

    // A date range before anything happened is empty; a backwards one is refused.
    expect((await owner.get("/api/v1/reports/size-cutting?from=2020-01-01&to=2020-01-31")).body.data.rows).toEqual([]);
    expect((await owner.get("/api/v1/reports/size-cutting?from=2026-02-01&to=2026-01-01")).status).toBe(400);
  });

  it("leaves money out without See prices & costs, and hides reports a person cannot open", async () => {
    await stitchedLot();
    await createUser({ email: "manager@garment.test", role: "MANAGER" });
    await createUser({ email: "staff@garment.test", role: "STAFF" });

    const manager = await loggedInClient("manager@garment.test");
    const keys = ((await manager.get("/api/v1/reports")).body.data.reports as { key: string }[]).map(
      (report) => report.key,
    );

    expect(keys).not.toContain("manufacturing-cost");
    expect((await manager.get("/api/v1/reports/manufacturing-cost")).status).toBe(404);

    const stock = (await manager.get("/api/v1/reports/fabric-stock")).body.data as ReportData;

    expect(stock.columns.some((column) => column.money)).toBe(false);
    expect(stock.rows.every((row) => !("value" in row) && !("avgRate" in row))).toBe(true);
    expect((await manager.get("/api/v1/reports/fabric-stock/export")).text).not.toMatch(/Stock value|Avg rate/);

    // Without the Reports right at all.
    const staff = await loggedInClient("staff@garment.test");

    expect((await staff.get("/api/v1/reports")).status).toBe(403);
  });
});
