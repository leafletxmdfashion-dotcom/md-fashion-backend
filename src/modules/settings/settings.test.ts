import { beforeEach, describe, expect, it } from "vitest";

import { cutLot, karigar, post, today } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql } from "../../test/helpers";

beforeEach(resetDatabase);

const base = {
  companyName: "MD Fashion Center",
  address: "Kathmandu",
  phone: null,
  defaultReorderLevel: 50,
  lotNumberPattern: "L-{year}-{seq}",
  approveAdjustments: false,
  approveReversals: true,
};

async function setup() {
  await createUser({ email: "owner@garment.test", role: "OWNER" });
  await createUser({ email: "staff@garment.test", role: "STAFF" });

  return { owner: await loggedInClient("owner@garment.test"), staff: await loggedInClient("staff@garment.test") };
}

describe("settings", () => {
  it("are read by everyone, saved only with settings.manage, validated and audited", async () => {
    const { owner, staff } = await setup();

    expect((await staff.get("/api/v1/settings")).body.data.settings).toMatchObject({ approveReversals: false });
    expect((await staff.send("put", "/api/v1/settings", base)).status).toBe(403);

    const bad = await owner.send("put", "/api/v1/settings", { ...base, lotNumberPattern: "LOT-{num}" });

    expect(bad.status).toBe(400);
    expect(bad.body.error.details.lotNumberPattern).toBeDefined();

    const saved = await owner.send("put", "/api/v1/settings", base);

    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.settings).toMatchObject({ ...base, updatedBy: "Test User" });

    const audit = await sql("SELECT metadata FROM audit_events WHERE event_type = 'SETTINGS_SAVED'");

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.changed).toEqual(
      expect.arrayContaining(["address", "defaultReorderLevel", "lotNumberPattern", "approveReversals"]),
    );
  });

  it("gives new fabrics the default reorder level unless one is typed", async () => {
    const { owner } = await setup();

    await owner.send("put", "/api/v1/settings", base);

    const purchase = (fabricName: string, extra: object = {}) =>
      post(owner, "/api/v1/fabrics/inwards", {
        fabricName,
        unit: "KG",
        inwardDate: today,
        quantity: 10,
        rate: 100,
        ...extra,
      });

    const plain = (await purchase("Jersey")).inward.fabric.id as string;
    const typed = (await purchase("Rib", { lowStockThreshold: 5 })).inward.fabric.id as string;

    expect((await owner.get(`/api/v1/fabrics/${plain}`)).body.data.fabric.lowStockThreshold).toBe(50);
    expect((await owner.get(`/api/v1/fabrics/${typed}`)).body.data.fabric.lowStockThreshold).toBe(5);
  });

  it("suggests the next lot number from the pattern, padded like the numbers in use", async () => {
    const { owner } = await setup();
    const next = async () => (await owner.get("/api/v1/settings/next-lot-number")).body.data.lotNumber as string;

    expect(await next()).toBe("LOT-1");

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

    await cutLot(owner, fabricId, masterId, "Polo", "LOT-007");
    await cutLot(owner, fabricId, masterId, "Polo", "lot-012");

    expect(await next()).toBe("LOT-013");

    await owner.send("put", "/api/v1/settings", base);

    expect(await next()).toBe(`L-${today.slice(0, 4)}-1`);
  });
});
