import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  auditTypes,
  createUser,
  loggedInClient,
  readMails,
  resetDatabase,
  sql,
  TestClient,
  tokenFromMail,
} from "../../test/helpers";

const EMAIL = "grace@garment.test";
const NEW_PASSWORD = "an entirely fresh passphrase";

beforeEach(resetDatabase);

async function requestResetToken(client = new TestClient()): Promise<string> {
  const before = (await readMails(EMAIL)).length;
  const res = await client.send("post", "/api/v1/auth/forgot-password", { email: EMAIL });
  expect(res.status).toBe(202);
  // The email is sent after the response, so wait for it to land.
  const mails = await vi.waitFor(async () => {
    const found = await readMails(EMAIL);
    if (found.length === before) throw new Error("mail not sent yet");
    return found;
  });
  return tokenFromMail(mails.at(-1)!.text);
}

describe("POST /auth/forgot-password", () => {
  it("responds identically for existing and unknown accounts", async () => {
    const userId = await createUser({ email: EMAIL });
    const client = new TestClient();

    const existing = await client.send("post", "/api/v1/auth/forgot-password", { email: EMAIL });
    const unknown = await client.send("post", "/api/v1/auth/forgot-password", { email: "nobody@garment.test" });

    expect(existing.status).toBe(202);
    expect(unknown.status).toBe(existing.status);
    expect(unknown.body).toEqual(existing.body);
    expect(existing.body.data.message).toBe(
      "If an account exists for this email, password reset instructions have been sent.",
    );

    await vi.waitFor(async () => expect(await readMails(EMAIL)).toHaveLength(1));
    expect(await readMails("nobody@garment.test")).toHaveLength(0);

    // A request never changes account state.
    const { rows } = await sql("SELECT status, password_changed_at FROM users WHERE id = $1", [userId]);
    expect(rows[0]).toEqual({ status: "ACTIVE", password_changed_at: null });
    expect(await auditTypes(userId)).toEqual(["PASSWORD_RESET_REQUESTED"]);
  });

  it("stores only a hash of the reset token", async () => {
    await createUser({ email: EMAIL });
    const token = await requestResetToken();
    const { rows } = await sql("SELECT encode(token_hash, 'escape') AS raw FROM password_reset_tokens");
    expect(rows).toHaveLength(1);
    expect(rows[0].raw).not.toContain(token);
  });

  it("is rate limited per account", async () => {
    const client = new TestClient();
    for (let i = 0; i < 3; i++) {
      expect((await client.send("post", "/api/v1/auth/forgot-password", { email: EMAIL })).status).toBe(202);
    }
    expect((await client.send("post", "/api/v1/auth/forgot-password", { email: EMAIL })).status).toBe(429);
  });
});

describe("POST /auth/reset-password", () => {
  it("resets the password, revokes sessions and invalidates the token", async () => {
    const userId = await createUser({ email: EMAIL });
    const existingSession = await loggedInClient(EMAIL);
    const token = await requestResetToken();

    const res = await new TestClient().send("post", "/api/v1/auth/reset-password", {
      token,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    // Not signed in automatically.
    expect(res.headers["set-cookie"]?.toString() ?? "").not.toMatch(/gm_session=[\w-]{43}/);

    expect((await existingSession.get("/api/v1/auth/me")).status).toBe(401);
    expect((await new TestClient().login(EMAIL, NEW_PASSWORD)).status).toBe(200);
    expect(await auditTypes(userId)).toContain("PASSWORD_RESET_COMPLETED");
  });

  it("rejects an already-used token", async () => {
    await createUser({ email: EMAIL });
    const token = await requestResetToken();
    const client = new TestClient();
    expect(
      (await client.send("post", "/api/v1/auth/reset-password", { token, newPassword: NEW_PASSWORD })).status,
    ).toBe(200);
    const again = await client.send("post", "/api/v1/auth/reset-password", {
      token,
      newPassword: "yet another passphrase",
    });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("TOKEN_INVALID");
  });

  it("rejects an expired token", async () => {
    await createUser({ email: EMAIL });
    const token = await requestResetToken();
    await sql("UPDATE password_reset_tokens SET expires_at = now() - interval '1 second'");
    const res = await new TestClient().send("post", "/api/v1/auth/reset-password", {
      token,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOKEN_INVALID");
  });

  it("rejects an unknown token", async () => {
    const res = await new TestClient().send("post", "/api/v1/auth/reset-password", {
      token: "B".repeat(43),
      newPassword: NEW_PASSWORD,
    });
    expect(res.body.error.code).toBe("TOKEN_INVALID");
  });

  it("lets exactly one of two concurrent requests consume the token", async () => {
    await createUser({ email: EMAIL });
    const token = await requestResetToken();
    const [a, b] = [new TestClient(), new TestClient()];
    await Promise.all([a.csrf(), b.csrf()]);

    const results = await Promise.all([
      a.send("post", "/api/v1/auth/reset-password", { token, newPassword: "first concurrent passphrase" }),
      b.send("post", "/api/v1/auth/reset-password", { token, newPassword: "second concurrent passphrase" }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
  });

  it("keeps the token usable when the new password fails policy", async () => {
    await createUser({ email: EMAIL });
    const token = await requestResetToken();
    const client = new TestClient();
    const weak = await client.send("post", "/api/v1/auth/reset-password", { token, newPassword: "password1234" });
    expect(weak.body.error.code).toBe("PASSWORD_TOO_WEAK");
    expect(
      (await client.send("post", "/api/v1/auth/reset-password", { token, newPassword: NEW_PASSWORD })).status,
    ).toBe(200);
  });

  it("only the newest reset link works", async () => {
    await createUser({ email: EMAIL });
    const first = await requestResetToken();
    await sql("UPDATE password_reset_tokens SET created_at = now() - interval '2 minutes'");
    const second = await requestResetToken();
    expect(second).not.toBe(first);

    const client = new TestClient();
    expect(
      (await client.send("post", "/api/v1/auth/reset-password", { token: first, newPassword: NEW_PASSWORD })).status,
    ).toBe(400);
    expect(
      (await client.send("post", "/api/v1/auth/reset-password", { token: second, newPassword: NEW_PASSWORD })).status,
    ).toBe(200);
  });
});
