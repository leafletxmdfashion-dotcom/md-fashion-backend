import { beforeEach, describe, expect, it } from "vitest";

import { auditTypes, createUser, loggedInClient, readMails, resetDatabase, sql, TestClient } from "../../test/helpers";

// Logins made with a staff / karigar record: email or phone, invited by link or given a
// password by the admin (which must be changed before anything else works).

const OWNER = "owner@garment.test";
const TEMP = "temporary handover phrase";
const CHOSEN = "my own long passphrase";

beforeEach(resetDatabase);

const person = (login?: object) => ({
  name: "Ram Tailor",
  phone: "9801234567",
  category: "TAILOR",
  payMode: "PER_PIECE",
  payRate: 25,
  notes: "Joined in Kartik",
  ...(login ? { login } : {}),
});

async function owner() {
  await createUser({ email: OWNER, role: "OWNER" });
  return loggedInClient(OWNER);
}

function signIn(identifier: string, password: string, client = new TestClient()) {
  return client.send("post", "/api/v1/auth/login", { identifier, password }).then((res) => ({ res, client }));
}

describe("adding a person with a login", () => {
  it("creates the person and an ACTIVE phone-only login whose password must be changed first", async () => {
    const admin = await owner();
    const res = await admin.send(
      "post",
      "/api/v1/karigars",
      person({ phone: "+977 980-123 4567", roleKey: "KARIGAR", mode: "PASSWORD", password: TEMP }),
    );
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.data.login).toMatchObject({ mode: "PASSWORD", invitation: null });

    const userId = res.body.data.login.userId as string;
    const { rows } = await sql(
      "SELECT u.email, u.phone, u.status::text, u.must_change_password, k.user_id FROM users u JOIN karigars k ON k.user_id = u.id WHERE u.id = $1",
      [userId],
    );
    expect(rows[0]).toMatchObject({
      email: null,
      phone: "+9779801234567",
      status: "ACTIVE",
      must_change_password: true,
    });
    expect(await auditTypes(userId)).toContain("USER_CREATED");

    // Phone in any common format signs in.
    const { res: login, client } = await signIn("+977 9801234567", TEMP);
    expect(login.status).toBe(200);
    expect(login.body.data.user).toMatchObject({ mustChangePassword: true, phone: "+9779801234567" });
    expect(login.body.data.user.karigarId).toBe(res.body.data.karigar.id);

    // The server refuses everything else until the password is changed.
    const blocked = await client.get("/api/v1/payments/me/ledger");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await client.get("/api/v1/auth/me")).status).toBe(200);

    const changed = await client.send("post", "/api/v1/auth/change-password", {
      currentPassword: TEMP,
      newPassword: CHOSEN,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.data.user.mustChangePassword).toBe(false);
    expect((await client.get("/api/v1/payments/me/ledger")).status).toBe(200);
  });

  it("invites by email: emails the link and returns it once for sharing", async () => {
    const admin = await owner();
    const res = await admin.send(
      "post",
      "/api/v1/karigars",
      person({ email: "Ram@Garment.test", roleKey: "KARIGAR", mode: "INVITE" }),
    );
    expect(res.status).toBe(201);
    const url = res.body.data.login.invitation.inviteUrl as string;
    expect(url).toMatch(/#token=[\w-]{43}$/);
    expect((await readMails("ram@garment.test"))[0]?.text).toContain(url);
  });

  it("invites a phone-only person: no mail, the link is returned for the admin to share", async () => {
    const admin = await owner();
    const res = await admin.send("post", "/api/v1/karigars", person({ phone: "9812345678", roleKey: "KARIGAR" }));
    expect(res.status).toBe(201);
    const token = (res.body.data.login.invitation.inviteUrl as string).split("#token=")[1]!;

    const inspect = await new TestClient().send("post", "/api/v1/auth/invitations/inspect", { token });
    expect(inspect.body.data.invitation).toMatchObject({ email: null, phone: "9812345678" });

    const accepted = await new TestClient().send("post", "/api/v1/auth/invitations/accept", {
      token,
      name: "Ram Tailor",
      newPassword: CHOSEN,
    });
    expect(accepted.status).toBeLessThan(300);
    const { res: login } = await signIn("98123 45678", CHOSEN);
    expect(login.status).toBe(200);
    expect(login.body.data.user.mustChangePassword).toBe(false);
  });

  it("needs an email or a phone, and a password when the admin sets it", async () => {
    const admin = await owner();
    const none = await admin.send("post", "/api/v1/karigars", person({ phone: "", roleKey: "KARIGAR" }));
    expect(none.status).toBe(400);
    expect(none.body.error.details["login.email"]).toBeDefined();

    const noPassword = await admin.send(
      "post",
      "/api/v1/karigars",
      person({ phone: "9800000001", roleKey: "KARIGAR", mode: "PASSWORD" }),
    );
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.error.details["login.password"]).toBeDefined();

    const weak = await admin.send(
      "post",
      "/api/v1/karigars",
      person({ phone: "9800000001", roleKey: "KARIGAR", mode: "PASSWORD", password: "9800000001" }),
    );
    expect(weak.status).toBe(400);
    expect(weak.body.error.details.password).toBeDefined();

    // Nothing half-made: no person and no login after the failures.
    expect((await sql("SELECT count(*)::int AS n FROM karigars")).rows[0].n).toBe(0);
    expect((await sql("SELECT count(*)::int AS n FROM users WHERE phone IS NOT NULL")).rows[0].n).toBe(0);
  });

  it("refuses a duplicate phone without creating the person", async () => {
    const admin = await owner();
    const first = await admin.send("post", "/api/v1/karigars", person({ phone: "9800000002", roleKey: "KARIGAR" }));
    expect(first.status).toBe(201);

    const again = await admin.send("post", "/api/v1/karigars", person({ phone: "980-000-0002", roleKey: "KARIGAR" }));
    expect(again.status).toBe(409);
    expect(again.body.error.details.phone).toBeDefined();
    expect((await sql("SELECT count(*)::int AS n FROM karigars")).rows[0].n).toBe(1);
  });

  it("adds a login to an existing person once", async () => {
    const admin = await owner();
    const created = await admin.send("post", "/api/v1/karigars", person());
    const id = created.body.data.karigar.id as string;

    const added = await admin.send(
      "put",
      `/api/v1/karigars/${id}`,
      person({ phone: "9800000003", roleKey: "KARIGAR", mode: "PASSWORD", password: TEMP }),
    );
    expect(added.status).toBe(200);
    expect(added.body.data.karigar.user).toMatchObject({ id: added.body.data.login.userId });

    const twice = await admin.send(
      "put",
      `/api/v1/karigars/${id}`,
      person({ phone: "9800000004", roleKey: "KARIGAR" }),
    );
    expect(twice.status).toBe(409);
  });

  it("does not let an admin hand out a role at or above their own, nor anyone without users.manage", async () => {
    await createUser({ email: "admin@garment.test", role: "ADMIN" });
    const admin = await loggedInClient("admin@garment.test");
    for (const roleKey of ["OWNER", "ADMIN"]) {
      const res = await admin.send("post", "/api/v1/karigars", person({ phone: "9800000005", roleKey }));
      expect(res.status).toBe(403);
    }

    await createUser({ email: "manager@garment.test", role: "MANAGER" });
    const manager = await loggedInClient("manager@garment.test");
    const res = await manager.send("post", "/api/v1/karigars", person({ phone: "9800000006", roleKey: "KARIGAR" }));
    expect(res.status).toBe(403);
    expect((await sql("SELECT count(*)::int AS n FROM users WHERE phone IS NOT NULL")).rows[0].n).toBe(0);
  });
});

describe("admin-set password", () => {
  it("sets a must-change password, signs the user out everywhere and audits it", async () => {
    const admin = await owner();
    const userId = await createUser({ email: "staff@garment.test", role: "STAFF" });
    const staff = await loggedInClient("staff@garment.test");

    const res = await admin.send("post", `/api/v1/users/${userId}/password`, { password: TEMP });
    expect(res.status).toBe(200);
    expect((await staff.get("/api/v1/auth/me")).status).toBe(401);
    expect(await auditTypes(userId)).toContain("PASSWORD_SET_BY_ADMIN");

    const { res: login } = await signIn("staff@garment.test", TEMP);
    expect(login.body.data.user.mustChangePassword).toBe(true);
  });

  it("is refused for yourself and for users at or above your rank", async () => {
    const admin = await owner();
    const self = (await sql("SELECT id FROM users WHERE email = $1", [OWNER])).rows[0].id as string;
    expect((await admin.send("post", `/api/v1/users/${self}/password`, { password: TEMP })).status).toBe(409);

    await createUser({ email: "admin@garment.test", role: "ADMIN" });
    const other = await loggedInClient("admin@garment.test");
    expect((await other.send("post", `/api/v1/users/${self}/password`, { password: TEMP })).status).toBe(403);
  });
});
