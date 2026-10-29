import { beforeEach, describe, expect, it } from "vitest";

import { createUser, loggedInClient, resetDatabase, sql } from "../../test/helpers";
import { PERMISSIONS } from "./permission.types";

beforeEach(resetDatabase);

interface Role {
  key: string;
  name: string;
  permissions: string[];
  builtIn: boolean;
  userCount: number;
  assignable: boolean;
  editable: boolean;
}

async function setup() {
  await createUser({ email: "owner@garment.test", role: "OWNER" });
  await createUser({ email: "admin@garment.test", role: "ADMIN" });
  await createUser({ email: "staff@garment.test", role: "STAFF" });

  return { owner: await loggedInClient("owner@garment.test"), admin: await loggedInClient("admin@garment.test") };
}

describe("roles and permissions", () => {
  it("lists roles with the permission catalog; the owner holds every permission", async () => {
    const { owner } = await setup();
    const res = await owner.get("/api/v1/roles");

    expect(res.status).toBe(200);
    expect(res.body.data.catalog.map((group: { module: string }) => group.module)).toContain("Stitching");

    const roles = res.body.data.roles as Role[];

    expect(roles.find((role) => role.key === "OWNER")).toMatchObject({ editable: false, builtIn: true, userCount: 1 });
    expect(roles.find((role) => role.key === "OWNER")!.permissions).toHaveLength(PERMISSIONS.length);
    expect((await owner.get("/api/v1/auth/me")).body.data.user.permissions).toHaveLength(PERMISSIONS.length);
    // The client's job roles are there, each with rights for its own work only.
    expect(roles.map((role) => role.name)).toEqual(
      expect.arrayContaining([
        "Administrator",
        "Production Manager",
        "Cutting Master",
        "Stitching Supervisor",
        "Packing Staff",
        "Godown Staff",
        "Accountant",
        "Store Keeper",
        "Viewer",
      ]),
    );
    expect(roles.find((role) => role.key === "CUTTING_MASTER")!.permissions).not.toContain("cutting.finalize");
    expect(roles.find((role) => role.key === "ACCOUNTANT")!.permissions).toContain("costing.view");
    expect(roles.find((role) => role.key === "STORE_KEEPER")!.permissions).toEqual(
      expect.arrayContaining(["fabric.view", "fabric.inward"]),
    );
    // Dead modules are gone from every role.
    expect(JSON.stringify(roles)).not.toMatch(/orders\.|products\.|settings\.manage/);
  });

  it("lets an admin create a custom role, assign it, and the holder gets exactly those rights", async () => {
    const { admin } = await setup();

    const created = await admin.send("post", "/api/v1/roles", {
      name: "  Fabric   Clerk ",
      permissions: ["fabric.view", "fabric.inward", "fabric.view"],
    });

    expect(created.status).toBe(201);
    expect(created.body.data.role).toMatchObject({
      key: "FABRIC_CLERK",
      name: "Fabric Clerk",
      permissions: ["fabric.inward", "fabric.view"],
      builtIn: false,
      editable: true,
      assignable: true,
    });

    const duplicate = await admin.send("post", "/api/v1/roles", { name: "fabric clerk", permissions: [] });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details.name).toBeDefined();

    const invite = await admin.send("post", "/api/v1/users/invitations", {
      email: "clerk@garment.test",
      name: "Clara Clerk",
      roleKey: "FABRIC_CLERK",
    });

    expect(invite.status).toBe(201);
    await sql(
      "UPDATE users SET status = 'ACTIVE', password_hash = (SELECT password_hash FROM users WHERE email = 'staff@garment.test') WHERE email = 'clerk@garment.test'",
    );

    const clerk = await loggedInClient("clerk@garment.test");

    expect((await clerk.get("/api/v1/fabrics/inwards")).status).toBe(200);
    expect(
      (
        await clerk.send("post", "/api/v1/fabrics/inwards", {
          fabricName: "Rib",
          unit: "KG",
          inwardDate: "2026-01-01",
          quantity: 1,
          rate: 1,
        })
      ).status,
    ).toBe(201);
    expect((await clerk.get("/api/v1/production-lots")).status).toBe(403);
    expect((await clerk.get("/api/v1/stitching/issues")).status).toBe(403);

    // Editing the role changes what the signed-in holder may do on the next request.
    const edited = await admin.send("put", "/api/v1/roles/FABRIC_CLERK", {
      name: "Store Clerk",
      permissions: ["fabric.view", "stitching.view"],
    });

    expect(edited.status).toBe(200);
    expect(edited.body.data.role).toMatchObject({ name: "Store Clerk", userCount: 1 });
    expect((await clerk.get("/api/v1/stitching/issues")).status).toBe(200);
    expect((await clerk.send("post", "/api/v1/fabrics/inwards", {})).status).toBe(403);

    // A role somebody holds cannot be deleted.
    expect((await admin.send("delete", "/api/v1/roles/FABRIC_CLERK")).status).toBe(409);

    const audits = await sql(
      "SELECT event_type FROM audit_events WHERE event_type IN ('ROLE_CREATED', 'PERMISSION_CHANGED') ORDER BY created_at",
    );

    expect(audits.rows.map((row: { event_type: string }) => row.event_type)).toEqual([
      "ROLE_CREATED",
      "PERMISSION_CHANGED",
    ]);
  });

  it("deletes an unused custom role but never a built-in one", async () => {
    const { admin } = await setup();

    await admin.send("post", "/api/v1/roles", { name: "Temp", permissions: [] });
    expect((await admin.send("delete", "/api/v1/roles/TEMP")).status).toBe(200);
    expect((await admin.get("/api/v1/roles")).body.data.roles.some((role: Role) => role.key === "TEMP")).toBe(false);
    expect((await admin.send("delete", "/api/v1/roles/VIEWER")).status).toBe(409);
  });

  it("blocks privilege escalation: no editing own or higher roles, no granting rights one lacks", async () => {
    const { admin, owner } = await setup();

    // An admin cannot edit its own role, the owner role, or rename a built-in role.
    expect((await admin.send("put", "/api/v1/roles/ADMIN", { permissions: [] })).status).toBe(403);
    expect((await admin.send("put", "/api/v1/roles/OWNER", { permissions: [] })).status).toBe(403);
    expect(
      (await admin.send("put", "/api/v1/roles/STAFF", { name: "Workers", permissions: ["dashboard.view"] })).status,
    ).toBe(400);

    // Take a right away from the admin role; the admin can then neither grant nor remove it.
    const adminRole = ((await owner.get("/api/v1/roles")).body.data.roles as Role[]).find(
      (role) => role.key === "ADMIN",
    )!;

    await owner.send("put", "/api/v1/roles/ADMIN", {
      permissions: adminRole.permissions.filter((permission) => permission !== "costing.view"),
    });

    const grant = await admin.send("post", "/api/v1/roles", { name: "Accountant", permissions: ["costing.view"] });

    expect(grant.status).toBe(403);
    expect(grant.body.error.details.permissions[0]).toMatch(/costing\.view/);

    const staffRole = ((await owner.get("/api/v1/roles")).body.data.roles as Role[]).find(
      (role) => role.key === "STAFF",
    )!;

    // MANAGER holds costing.view; the admin may change MANAGER's other rights but not that one.
    const manager = ((await owner.get("/api/v1/roles")).body.data.roles as Role[]).find(
      (role) => role.key === "MANAGER",
    )!;

    expect(
      (
        await admin.send("put", "/api/v1/roles/MANAGER", {
          permissions: manager.permissions.filter((p) => p !== "costing.view"),
        })
      ).status,
    ).toBe(403);
    expect(
      (await admin.send("put", "/api/v1/roles/STAFF", { permissions: [...staffRole.permissions, "fabric.adjust"] }))
        .status,
    ).toBe(200);

    expect((await admin.send("put", "/api/v1/roles/STAFF", { permissions: ["root.everything"] })).status).toBe(400);

    // The owner role is never editable, even by an owner.
    expect((await owner.send("put", "/api/v1/roles/OWNER", { permissions: [] })).status).toBe(403);

    // Staff (no roles.manage) cannot touch roles at all.
    const staff = await loggedInClient("staff@garment.test");

    expect((await staff.send("post", "/api/v1/roles", { name: "Mine", permissions: [] })).status).toBe(403);
  });
});
