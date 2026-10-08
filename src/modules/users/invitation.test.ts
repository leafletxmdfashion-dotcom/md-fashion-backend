import { beforeEach, describe, expect, it } from "vitest";

import { pool } from "../../db/pool";
import { auditTypes, createUser, loggedInClient, readMails, resetDatabase, TestClient } from "../../test/helpers";

const OWNER = "owner@garment.test";
const INVITEE = "new.hire@garment.test";
const PASSPHRASE = "my first proper passphrase";

beforeEach(resetDatabase);

async function invite(roleKey = "STAFF") {
  await createUser({ email: OWNER, role: "OWNER" });
  const owner = await loggedInClient(OWNER);
  const res = await owner.send("post", "/api/v1/users/invitations", { email: INVITEE, name: "New Hire", roleKey });
  expect(res.status).toBe(201);
  const url = res.body.data.invitation.inviteUrl as string;
  return { owner, res, userId: res.body.data.invitation.userId as string, token: url.split("#token=")[1]! };
}

function accept(token: string, client = new TestClient()) {
  return client.send("post", "/api/v1/auth/invitations/accept", { token, name: "New Hire", newPassword: PASSPHRASE });
}

describe("invitations", () => {
  it("creates an INVITED user, emails a single-use link and stores only its hash", async () => {
    const { res, userId, token } = await invite();
    expect(res.body.data.invitation.inviteUrl).toMatch(/^http:\/\/localhost:3000\/accept-invitation#token=[\w-]{43}$/);

    const { rows } = await pool.query("SELECT status FROM users WHERE id = $1", [userId]);
    expect(rows[0].status).toBe("INVITED");
    const stored = await pool.query("SELECT encode(token_hash, 'escape') AS raw FROM invitations");
    expect(stored.rows[0].raw).not.toContain(token);
    expect((await readMails(INVITEE))[0]?.text).toContain(token);
    expect(await auditTypes(userId)).toEqual(["INVITATION_CREATED"]);
  });

  it("shows invitation details for a valid token", async () => {
    const { token } = await invite();
    const res = await new TestClient().send("post", "/api/v1/auth/invitations/inspect", { token });
    expect(res.status).toBe(200);
    expect(res.body.data.invitation).toMatchObject({ email: INVITEE, roleName: "Staff" });
  });

  it("does not let an invited user sign in before accepting", async () => {
    await invite();
    const res = await new TestClient().login(INVITEE, PASSPHRASE);
    expect(res.status).toBe(401);
  });

  it("accepting sets the password and activates the account, without signing in", async () => {
    const { userId, token } = await invite();
    const res = await accept(token);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]?.toString() ?? "").not.toMatch(/gm_session=[\w-]{43}/);

    const { rows } = await pool.query("SELECT status FROM users WHERE id = $1", [userId]);
    expect(rows[0].status).toBe("ACTIVE");
    expect((await new TestClient().login(INVITEE, PASSPHRASE)).status).toBe(200);
    expect(await auditTypes(userId)).toContain("INVITATION_ACCEPTED");
  });

  it("rejects a second acceptance of the same token", async () => {
    const { token } = await invite();
    expect((await accept(token)).status).toBe(200);
    const again = await accept(token);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("TOKEN_INVALID");
  });

  it("lets exactly one of two concurrent acceptances win", async () => {
    const { token } = await invite();
    const [a, b] = [new TestClient(), new TestClient()];
    await Promise.all([a.csrf(), b.csrf()]);
    const results = await Promise.all([accept(token, a), accept(token, b)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
  });

  it("rejects an expired invitation", async () => {
    const { token } = await invite();
    await pool.query("UPDATE invitations SET expires_at = now() - interval '1 second'");
    expect((await accept(token)).body.error.code).toBe("TOKEN_INVALID");
  });

  it("rejects a revoked invitation", async () => {
    const { owner, userId, token } = await invite();
    expect((await owner.send("post", `/api/v1/users/${userId}/invitation/revoke`)).status).toBe(200);
    expect((await accept(token)).body.error.code).toBe("TOKEN_INVALID");
    expect(await auditTypes(userId)).toContain("INVITATION_REVOKED");
  });

  it("resending invalidates the previous link", async () => {
    const { owner, userId, token } = await invite();
    const res = await owner.send("post", `/api/v1/users/${userId}/invitation/resend`);
    expect(res.status).toBe(200);
    const fresh = (res.body.data.invitation.inviteUrl as string).split("#token=")[1]!;

    expect((await accept(token)).status).toBe(400);
    expect((await accept(fresh)).status).toBe(200);
  });

  it("rejects inviting an existing email", async () => {
    const { owner } = await invite();
    const res = await owner.send("post", "/api/v1/users/invitations", {
      email: INVITEE,
      name: "Dup",
      roleKey: "STAFF",
    });
    expect(res.status).toBe(409);
  });

  it("enforces the password policy on acceptance", async () => {
    const { token } = await invite();
    const res = await new TestClient().send("post", "/api/v1/auth/invitations/accept", {
      token,
      name: "New Hire",
      newPassword: "password1234",
    });
    expect(res.body.error.code).toBe("PASSWORD_TOO_WEAK");
    // The token survives a policy failure.
    expect((await accept(token)).status).toBe(200);
  });
});
