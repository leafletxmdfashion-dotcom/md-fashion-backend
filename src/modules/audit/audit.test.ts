import { beforeEach, describe, expect, it } from "vitest";

import { karigar, post } from "../../test/fixtures";
import { createUser, loggedInClient, resetDatabase, sql, TestClient } from "../../test/helpers";
import { describeDevice } from "./audit.routes";

beforeEach(resetDatabase);

interface Event {
  id: string;
  type: string;
  label: string;
  category: string;
  severity: string;
  outcome: string;
  actor: { id: string; name: string; roleKey: string; roleName: string } | null;
  target: { id: string; name: string } | null;
  record: { key: string; id: string } | null;
  reason: string | null;
  ip: string | null;
  device: { browser: string; os: string } | null;
  sessionId: string | null;
  requestId: string | null;
}

async function events(client: TestClient, query = "") {
  const res = await client.get(`/api/v1/audit-events${query}`);

  expect(res.status, JSON.stringify(res.body)).toBe(200);

  return res.body.data as { events: Event[]; total: number; summary: Record<string, number> };
}

describe("audit log", () => {
  it("records who did it with their role at the time, from where, and filters every way", async () => {
    const ownerId = await createUser({ email: "owner@garment.test", role: "OWNER", name: "Mira Owner" });
    const staffId = await createUser({ email: "staff@garment.test", role: "STAFF", name: "Sita" });
    const owner = await loggedInClient("owner@garment.test");

    // A failed sign-in from a phone.
    const phone = new TestClient();
    const token = await phone.csrf();

    await phone.agent
      .post("/api/v1/auth/login")
      .set("Origin", "http://localhost:3000")
      .set("X-CSRF-Token", token)
      .set("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36")
      .send({ email: "staff@garment.test", password: "wrong" });

    const ram = await karigar(owner, "Ram");

    await post(owner, "/api/v1/teams", { name: "Team Ram", members: [{ karigarId: ram }] });
    await owner.send("put", `/api/v1/access/${staffId}`, {
      overrides: [{ permission: "godown.view", effect: "ALLOW" }],
      reason: "Helping in the godown",
    });

    const all = await events(owner);

    expect(all.total).toBeGreaterThanOrEqual(5);

    const access = all.events.find((event) => event.type === "PERMISSION_OVERRIDE_CHANGED")!;

    expect(access).toMatchObject({
      label: "Personal access changed",
      category: "Users & access",
      severity: "critical",
      outcome: "success",
      actor: { id: ownerId, name: "Mira Owner", roleKey: "OWNER", roleName: "Owner" },
      target: { id: staffId, name: "Sita" },
      reason: "Helping in the godown",
    });
    expect(access.sessionId).toBeTruthy();
    expect(access.requestId).toBeTruthy();

    const team = all.events.find((event) => event.type === "TEAM_CREATED")!;

    expect(team.record?.key).toBe("teamId");
    // Who did it stays as it was even if the person is renamed later.
    await sql("UPDATE users SET name = 'Renamed' WHERE id = $1", [ownerId]);
    expect((await events(owner, `?type=TEAM_CREATED`)).events[0]!.actor!.name).toBe("Mira Owner");

    // Filters.
    const failed = await events(owner, "?outcome=failure");

    expect(failed.events.map((event) => event.type)).toEqual(["LOGIN_FAILURE"]);
    expect(failed.events[0]!.device).toMatchObject({ browser: "Chrome 131", os: "Android" });
    expect(failed.summary.failures).toBe(1);

    expect((await events(owner, "?category=Teams%20%26%20karigars")).events.map((event) => event.type).sort()).toEqual([
      "KARIGAR_CREATED",
      "TEAM_CREATED",
    ]);
    expect((await events(owner, "?severity=critical")).events.every((event) => event.severity === "critical")).toBe(
      true,
    );
    expect((await events(owner, `?actorId=${ownerId}&type=TEAM_CREATED,KARIGAR_CREATED`)).total).toBe(2);
    expect((await events(owner, `?targetId=${staffId}`)).events.map((event) => event.type)).toContain(
      "PERMISSION_OVERRIDE_CHANGED",
    );
    expect((await events(owner, "?q=godown")).events.map((event) => event.type)).toContain(
      "PERMISSION_OVERRIDE_CHANGED",
    );
    // A label word finds its events too.
    expect((await events(owner, "?q=sign-in%20failed")).total).toBe(1);
    expect((await events(owner, `?recordId=${team.record!.id}`)).total).toBe(1);
    expect((await events(owner, "?role=OWNER")).events.every((event) => event.actor?.roleKey === "OWNER")).toBe(true);

    const today = new Date().toISOString().slice(0, 10);

    expect((await events(owner, `?from=2000-01-01&to=2000-01-31`)).total).toBe(0);
    expect((await events(owner, `?from=${today}&to=${today}`)).total).toBeGreaterThan(0);

    // Paging and order.
    const first = await events(owner, "?pageSize=10&page=1&sort=asc");

    expect(first.events[0]!.type).toBe("LOGIN_SUCCESS");
    expect((await owner.get("/api/v1/audit-events?pageSize=7")).status).toBe(400);
    expect((await owner.get("/api/v1/audit-events?type=NOPE")).status).toBe(400);

    const detail = (await owner.get(`/api/v1/audit-events/${access.id}`)).body.data.event;

    expect(detail.metadata).toMatchObject({ allowed: ["godown.view"] });

    const facets = (await owner.get("/api/v1/audit-events/facets")).body.data;

    expect(facets.types.length).toBeGreaterThan(50);
    expect(facets.actors.map((actor: { id: string }) => actor.id)).toContain(ownerId);

    const exported = await owner.get("/api/v1/audit-events/export?outcome=failure");

    expect(exported.status).toBe(200);
    expect(exported.text).toMatch(/Sign-in failed/);
  });

  it("cannot be changed or deleted, and needs its own permission to read", async () => {
    await createUser({ email: "owner@garment.test", role: "OWNER" });
    await createUser({ email: "admin@garment.test", role: "ADMIN" });
    await createUser({ email: "staff@garment.test", role: "STAFF" });

    const admin = await loggedInClient("admin@garment.test");
    const staff = await loggedInClient("staff@garment.test");

    expect((await admin.get("/api/v1/audit-events")).status).toBe(200);
    expect((await staff.get("/api/v1/audit-events")).status).toBe(403);
    await expect(sql("UPDATE audit_events SET event_type = 'LOGOUT'")).rejects.toThrow(/append-only/);
    await expect(sql("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
  });
});

describe("device from user agent", () => {
  it("names common browsers and systems", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      ),
    ).toEqual({ browser: "Edge 131", os: "Windows", mobile: false });
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Safari 17", os: "iOS", mobile: true });
    expect(describeDevice(null)).toBeNull();
  });
});
