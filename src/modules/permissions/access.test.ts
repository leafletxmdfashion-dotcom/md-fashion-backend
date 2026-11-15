import { beforeEach, describe, expect, it } from "vitest";

import { createUser, loggedInClient, resetDatabase, sql, type TestClient } from "../../test/helpers";

beforeEach(resetDatabase);

async function me(client: TestClient): Promise<string[]> {
  return (await client.get("/api/v1/auth/me")).body.data.user.permissions as string[];
}

async function setup() {
  const ownerId = await createUser({ email: "owner@garment.test", role: "OWNER" });
  const adminId = await createUser({ email: "admin@garment.test", role: "ADMIN" });
  const staffId = await createUser({ email: "staff@garment.test", role: "STAFF", name: "Sita" });
  const managerId = await createUser({ email: "manager@garment.test", role: "MANAGER" });

  return {
    ownerId,
    adminId,
    staffId,
    managerId,
    owner: await loggedInClient("owner@garment.test"),
    admin: await loggedInClient("admin@garment.test"),
    staff: await loggedInClient("staff@garment.test"),
  };
}

describe("per-person access", () => {
  it("gives and takes away rights on top of the role, at once, with a reason and an audit trail", async () => {
    const { owner, staff, staffId } = await setup();
    const before = await me(staff);

    expect(before).toContain("dashboard.view");
    expect(before).not.toContain("godown.view");

    const noReason = await owner.send("put", `/api/v1/access/${staffId}`, {
      overrides: [{ permission: "godown.view", effect: "ALLOW" }],
      reason: "",
    });

    expect(noReason.status).toBe(400);

    const res = await owner.send("put", `/api/v1/access/${staffId}`, {
      overrides: [
        { permission: "godown.view", effect: "ALLOW" },
        { permission: "dashboard.view", effect: "DENY" },
        // No-ops are dropped: STAFF already lacks roles.manage.
        { permission: "roles.manage", effect: "DENY" },
      ],
      reason: "Covers the godown this week",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      res.body.data.overrides.map((row: { permission: string; effect: string }) => [row.permission, row.effect]),
    ).toEqual([
      ["dashboard.view", "DENY"],
      ["godown.view", "ALLOW"],
    ]);
    expect(res.body.data.effective).toContain("godown.view");
    expect(res.body.data.effective).not.toContain("dashboard.view");

    // The next request already runs with the new rights.
    const after = await me(staff);

    expect(after).toContain("godown.view");
    expect(after).not.toContain("dashboard.view");
    expect((await staff.get("/api/v1/godown/stock")).status).toBe(200);

    const { rows } = await sql(
      "SELECT event_type, target_user_id, metadata FROM audit_events WHERE event_type = 'PERMISSION_OVERRIDE_CHANGED'",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].target_user_id).toBe(staffId);
    expect(rows[0].metadata).toMatchObject({
      allowed: ["godown.view"],
      denied: ["dashboard.view"],
      reason: "Covers the godown this week",
    });

    const list = (await owner.get("/api/v1/access")).body.data.people as {
      id: string;
      allowed: number;
      denied: number;
    }[];

    expect(list.find((row) => row.id === staffId)).toMatchObject({ allowed: 1, denied: 1 });

    // Back to the role.
    await owner.send("put", `/api/v1/access/${staffId}`, { overrides: [], reason: "Week over" });
    expect((await me(staff)).sort()).toEqual([...before].sort());
  });

  it("never lets anyone escalate: own rights only, below their rank, not themselves, not owners", async () => {
    const { admin, staff, adminId, staffId, ownerId, managerId } = await setup();
    const reason = "Testing limits";

    // Staff have no roles.manage at all.
    expect((await staff.get("/api/v1/access")).status).toBe(403);

    // Admins cannot change themselves or an owner.
    expect((await admin.send("put", `/api/v1/access/${adminId}`, { overrides: [], reason })).status).toBe(403);
    expect((await admin.send("put", `/api/v1/access/${ownerId}`, { overrides: [], reason })).status).toBe(403);

    // Take a right away from admins, then let one try to give it to someone else.
    await sql(
      "DELETE FROM role_permissions WHERE permission = 'payments.manage' AND role_id = (SELECT id FROM roles WHERE key = 'ADMIN')",
    );

    const escalate = await admin.send("put", `/api/v1/access/${staffId}`, {
      overrides: [{ permission: "payments.manage", effect: "ALLOW" }],
      reason,
    });

    expect(escalate.status).toBe(403);
    expect(escalate.body.error.details.overrides[0]).toMatch(/payments\.manage/);

    // A manager is ranked below an admin: the admin may change the manager.
    const manager = await admin.send("put", `/api/v1/access/${managerId}`, {
      overrides: [{ permission: "fabric.view", effect: "DENY" }],
      reason,
    });

    expect(manager.status, JSON.stringify(manager.body)).toBe(200);

    const people = (await admin.get("/api/v1/access")).body.data.people as { id: string; editable: boolean }[];

    expect(people.find((row) => row.id === ownerId)!.editable).toBe(false);
    expect(people.find((row) => row.id === adminId)!.editable).toBe(false);
    expect(people.find((row) => row.id === staffId)!.editable).toBe(true);
  });

  it("does not let a DENY touch an owner", async () => {
    const { owner, ownerId } = await setup();

    await sql(
      "INSERT INTO user_permission_overrides (user_id, permission, effect) VALUES ($1, 'roles.manage', 'DENY')",
      [ownerId],
    );

    expect(await me(owner)).toContain("roles.manage");
  });
});
