import { beforeEach, describe, expect, it } from "vitest";

import { pool } from "../../db/pool";
import { auditTypes, createUser, loggedInClient, resetDatabase, TestClient } from "../../test/helpers";

beforeEach(resetDatabase);

async function setup() {
  const ownerId = await createUser({ email: "owner@garment.test", role: "OWNER" });
  const adminId = await createUser({ email: "admin@garment.test", role: "ADMIN" });
  const managerId = await createUser({ email: "manager@garment.test", role: "MANAGER" });
  const staffId = await createUser({ email: "staff@garment.test", role: "STAFF" });
  return { ownerId, adminId, managerId, staffId };
}

describe("authorization", () => {
  it("rejects unauthenticated access to protected routes", async () => {
    const res = await new TestClient().get("/api/v1/users");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_UNAUTHENTICATED");
  });

  it("denies a role lacking the permission (403)", async () => {
    await setup();
    const staff = await loggedInClient("staff@garment.test");
    const res = await staff.get("/api/v1/users");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTH_FORBIDDEN");
  });

  it("allows a role holding the permission", async () => {
    await setup();
    const manager = await loggedInClient("manager@garment.test");
    const res = await manager.get("/api/v1/users");
    expect(res.status).toBe(200);
    expect(res.body.data.users).toHaveLength(4);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password_hash|token/i);
  });

  it("denies a managing action to a view-only role", async () => {
    await setup();
    const manager = await loggedInClient("manager@garment.test");
    const res = await manager.send("post", "/api/v1/users/invitations", {
      email: "x@garment.test",
      name: "X",
      roleKey: "VIEWER",
    });
    expect(res.status).toBe(403);
  });

  it("applies permission changes immediately (no stale cache)", async () => {
    const { staffId } = await setup();
    const staff = await loggedInClient("staff@garment.test");
    expect((await staff.get("/api/v1/users")).status).toBe(403);
    await pool.query("UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'MANAGER') WHERE id = $1", [
      staffId,
    ]);
    expect((await staff.get("/api/v1/users")).status).toBe(200);
  });

  it("restricts role permission editing to owners", async () => {
    await setup();
    const admin = await loggedInClient("admin@garment.test");
    expect(
      (await admin.send("put", "/api/v1/roles/STAFF/permissions", { permissions: ["dashboard.view"] })).status,
    ).toBe(403);
  });
});

describe("privilege escalation guards", () => {
  it("an admin cannot invite at or above its own rank", async () => {
    await setup();
    const admin = await loggedInClient("admin@garment.test");
    for (const roleKey of ["OWNER", "ADMIN"]) {
      const res = await admin.send("post", "/api/v1/users/invitations", {
        email: `${roleKey}@x.test`,
        name: "X",
        roleKey,
      });
      expect(res.status).toBe(403);
    }
    const ok = await admin.send("post", "/api/v1/users/invitations", {
      email: "s@x.test",
      name: "S",
      roleKey: "STAFF",
    });
    expect(ok.status).toBe(201);
  });

  it("an admin cannot manage an owner or promote anyone to owner", async () => {
    const { ownerId, staffId } = await setup();
    const admin = await loggedInClient("admin@garment.test");
    expect((await admin.send("post", `/api/v1/users/${ownerId}/disable`)).status).toBe(403);
    expect((await admin.send("put", `/api/v1/users/${staffId}/role`, { roleKey: "OWNER" })).status).toBe(403);
  });

  it("nobody can change their own role or disable themselves via admin routes", async () => {
    const { ownerId } = await setup();
    const owner = await loggedInClient("owner@garment.test");
    expect((await owner.send("put", `/api/v1/users/${ownerId}/role`, { roleKey: "STAFF" })).status).toBe(409);
    expect((await owner.send("post", `/api/v1/users/${ownerId}/disable`)).status).toBe(409);
  });

  it("validates ids and rejects unknown fields", async () => {
    await setup();
    const owner = await loggedInClient("owner@garment.test");
    expect((await owner.send("post", "/api/v1/users/not-a-uuid/disable")).status).toBe(400);
    const res = await owner.send("post", "/api/v1/users/invitations", {
      email: "a@x.test",
      name: "A",
      roleKey: "STAFF",
      status: "ACTIVE",
    });
    expect(res.status).toBe(400);
  });
});

describe("account administration", () => {
  it("disabling revokes sessions and blocks login; enabling restores it", async () => {
    const { staffId } = await setup();
    const staff = await loggedInClient("staff@garment.test");
    const admin = await loggedInClient("admin@garment.test");

    expect((await admin.send("post", `/api/v1/users/${staffId}/disable`)).status).toBe(200);
    expect((await staff.get("/api/v1/auth/me")).status).toBe(401);
    expect((await new TestClient().login("staff@garment.test")).status).toBe(401);

    expect((await admin.send("post", `/api/v1/users/${staffId}/enable`)).status).toBe(200);
    expect((await new TestClient().login("staff@garment.test")).status).toBe(200);
    expect(await auditTypes(staffId)).toEqual(expect.arrayContaining(["USER_DISABLED", "USER_ENABLED"]));
  });

  it("changes roles with an audit record", async () => {
    const { staffId } = await setup();
    const admin = await loggedInClient("admin@garment.test");
    expect((await admin.send("put", `/api/v1/users/${staffId}/role`, { roleKey: "MANAGER" })).status).toBe(200);
    const { rows } = await pool.query(
      "SELECT metadata FROM audit_events WHERE event_type = 'ROLE_CHANGED' AND target_user_id = $1",
      [staffId],
    );
    expect(rows[0].metadata).toEqual({ from: "STAFF", to: "MANAGER" });
  });

  it("revokes another user's sessions", async () => {
    const { staffId } = await setup();
    const staff = await loggedInClient("staff@garment.test");
    const owner = await loggedInClient("owner@garment.test");
    const res = await owner.send("post", `/api/v1/users/${staffId}/sessions/revoke`);
    expect(res.body.data.revokedSessions).toBe(1);
    expect((await staff.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("owners can edit lower role permissions, audited, but never the OWNER role", async () => {
    await setup();
    const owner = await loggedInClient("owner@garment.test");
    const before = await owner.get("/api/v1/roles");
    const staffRole = before.body.data.roles.find((role: { key: string }) => role.key === "STAFF");

    try {
      const res = await owner.send("put", "/api/v1/roles/STAFF/permissions", {
        permissions: ["dashboard.view", "orders.view"],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.role.permissions).toEqual(["dashboard.view", "orders.view"]);
      const audit = await pool.query("SELECT metadata FROM audit_events WHERE event_type = 'PERMISSION_CHANGED'");
      expect(audit.rows[0].metadata.role).toBe("STAFF");

      const unknown = await owner.send("put", "/api/v1/roles/STAFF/permissions", { permissions: ["root.everything"] });
      expect(unknown.status).toBe(400);
      expect((await owner.send("put", "/api/v1/roles/OWNER/permissions", { permissions: [] })).status).toBe(403);
    } finally {
      await owner.send("put", "/api/v1/roles/STAFF/permissions", { permissions: staffRole.permissions });
    }
  });
});
