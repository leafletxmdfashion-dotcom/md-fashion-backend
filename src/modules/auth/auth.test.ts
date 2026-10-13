import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app";

import { env } from "../../config/env";
import { hashToken } from "../../lib/crypto";
import {
  auditTypes,
  createUser,
  loggedInClient,
  ORIGIN,
  PASSWORD,
  resetDatabase,
  sessionCookie,
  setCookies,
  sql,
  TestClient,
} from "../../test/helpers";
import { cookieNames, sessionCookieOptions } from "./auth.cookies";

const EMAIL = "ada@garment.test";
const GENERIC = { code: "AUTH_INVALID_CREDENTIALS", message: "Invalid email or password." };

beforeEach(resetDatabase);

describe("POST /auth/login", () => {
  it("creates a session, sets a hardened cookie and returns a sanitized user", async () => {
    const userId = await createUser({ email: EMAIL, role: "MANAGER" });
    const client = new TestClient();

    const res = await client.login("  ADA@Garment.TEST ");

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: userId, email: EMAIL, status: "ACTIVE", role: { key: "MANAGER" } });
    expect(res.body.data.user.permissions).toContain("users.view");
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password|hash/i);

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/);

    const token = /gm_session=([^;]+)/.exec(cookie!)![1]!;
    const { rows } = await sql("SELECT token_hash FROM sessions WHERE user_id = $1", [userId]);
    expect(rows).toHaveLength(1);
    // Only the SHA-256 of the token is stored.
    expect(Buffer.compare(rows[0].token_hash, hashToken(token))).toBe(0);
    expect(Buffer.from(rows[0].token_hash).toString("utf8")).not.toContain(token);
    expect(await auditTypes(userId)).toEqual(["LOGIN_SUCCESS"]);
  });

  it("rejects an incorrect password generically", async () => {
    const userId = await createUser({ email: EMAIL });
    const res = await new TestClient().login(EMAIL, "wrong password entirely");
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual(GENERIC);
    expect(sessionCookie(res)).toBeUndefined();
    expect(await auditTypes(userId)).toEqual(["LOGIN_FAILURE"]);
  });

  it("answers an unknown email exactly like a wrong password", async () => {
    await createUser({ email: EMAIL });
    const unknown = await new TestClient().login("nobody@garment.test", PASSWORD);
    const wrong = await new TestClient().login(EMAIL, "wrong password entirely");
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("rejects a disabled account generically, even with the right password", async () => {
    await createUser({ email: EMAIL, status: "DISABLED" });
    const res = await new TestClient().login(EMAIL);
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual(GENERIC);
  });

  it("validates a malformed email", async () => {
    const res = await new TestClient().login("not-an-email");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.email).toBeDefined();
  });

  it("validates a missing password", async () => {
    const client = new TestClient();
    const res = await client.send("post", "/api/v1/auth/login", { email: EMAIL });
    expect(res.status).toBe(400);
    expect(res.body.error.details.password).toBeDefined();
  });

  it("rejects passwords longer than the limit before hashing", async () => {
    const res = await new TestClient().login(EMAIL, "x".repeat(129));
    expect(res.status).toBe(400);
  });

  it("rate limits repeated failures per account, including unknown accounts", async () => {
    const client = new TestClient();
    for (let i = 0; i < 10; i++) {
      expect((await client.login("ghost@garment.test", `wrong-password-${i}`)).status).toBe(401);
    }
    const limited = await client.login("ghost@garment.test", "wrong-password-x");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it("temporarily locks an account after repeated failures, then recovers", async () => {
    const userId = await createUser({ email: EMAIL });
    const client = new TestClient();
    for (let i = 0; i < 5; i++) await client.login(EMAIL, `wrong-password-${i}`);

    const { rows } = await sql("SELECT status, locked_until FROM users WHERE id = $1", [userId]);
    expect(rows[0].status).toBe("LOCKED");
    expect(rows[0].locked_until.getTime()).toBeGreaterThan(Date.now());

    // Correct password is refused, indistinguishably, while locked.
    const whileLocked = await client.login(EMAIL);
    expect(whileLocked.status).toBe(401);
    expect(whileLocked.body.error).toEqual(GENERIC);

    await sql("UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1", [userId]);
    const after = await client.login(EMAIL);
    expect(after.status).toBe(200);
    const reset = await sql("SELECT status, failed_login_count FROM users WHERE id = $1", [userId]);
    expect(reset.rows[0]).toEqual({ status: "ACTIVE", failed_login_count: 0 });
  });

  it("rotates the session on re-login and retires the previous one", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const first = await sql("SELECT id FROM sessions");

    const res = await client.login(EMAIL);
    expect(res.status).toBe(200);
    const { rows } = await sql("SELECT id, revoked_reason FROM sessions ORDER BY created_at");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: first.rows[0].id, revoked_reason: "login_rotation" });
    expect(rows[1].revoked_reason).toBeNull();
  });

  it("never adopts a session token chosen before login (fixation)", async () => {
    await createUser({ email: EMAIL });
    const app = createApp();
    const planted = "A".repeat(43);
    const csrf = await request(app).get("/api/v1/auth/csrf");
    const nonceCookie = setCookies(csrf)[0]!.split(";")[0]!;

    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", csrf.body.data.csrfToken)
      .set("Cookie", `${nonceCookie}; gm_session=${planted}`)
      .send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toMatch(/^gm_session=[\w-]{43};/);
    expect(sessionCookie(res)).not.toContain(planted);
  });
});

describe("GET /auth/me and session validity", () => {
  it("returns the current user for a valid session", async () => {
    await createUser({ email: EMAIL, name: "Ada" });
    const client = await loggedInClient(EMAIL);
    const res = await client.get("/api/v1/auth/me");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.user).sort()).toEqual([
      "email",
      "id",
      "name",
      "permissions",
      "role",
      "session",
      "status",
    ]);
    // The client schedules its own sign-out from these; the server stays the authority.
    const { expiresAt, idleTimeoutMinutes } = res.body.data.user.session;
    expect(idleTimeoutMinutes).toBe(env.SESSION_IDLE_TIMEOUT_MINUTES);
    const remainingMs = new Date(expiresAt).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(env.sessionAbsoluteTimeoutMs - 60_000);
    expect(remainingMs).toBeLessThanOrEqual(env.sessionAbsoluteTimeoutMs);
  });

  it("returns 401 AUTH_UNAUTHENTICATED without a session", async () => {
    const res = await new TestClient().get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_UNAUTHENTICATED");
  });

  it("rejects an absolutely expired session and clears the cookie", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    await sql("UPDATE sessions SET expires_at = now() - interval '1 second'");
    const res = await client.get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("rejects an idle-expired session", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    await sql("UPDATE sessions SET last_seen_at = now() - interval '3 hours'");
    expect((await client.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("rejects a revoked session", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    await sql("UPDATE sessions SET revoked_at = now()");
    expect((await client.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("rejects sessions of a user disabled after login", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    await sql("UPDATE users SET status = 'DISABLED'");
    expect((await client.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("lets the user update only their display name", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const ok = await client.send("patch", "/api/v1/auth/me", { name: "Ada Lovelace" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.name).toBe("Ada Lovelace");

    // Unknown keys are rejected outright (mass assignment).
    const smuggled = await client.send("patch", "/api/v1/auth/me", { name: "x", role: "OWNER", status: "ACTIVE" });
    expect(smuggled.status).toBe(400);
  });
});

describe("logout", () => {
  it("revokes the server session and clears the cookie", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const cookieBefore = client.agent.jar.getCookie("gm_session", {
      domain: "127.0.0.1",
      path: "/",
      secure: false,
      script: false,
    });

    expect(cookieBefore?.value).toMatch(/^[\w-]{43}$/);

    const res = await client.send("post", "/api/v1/auth/logout");
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toMatch(/gm_session=;.*Expires=Thu, 01 Jan 1970.*HttpOnly.*SameSite=Lax/);

    const { rows } = await sql("SELECT revoked_at, revoked_reason FROM sessions");
    expect(rows[0].revoked_reason).toBe("logout");

    // Replaying the old cookie value does not work: the server-side session is dead.
    const replay = new TestClient();
    const replayed = await replay.get("/api/v1/auth/me").set("Cookie", `gm_session=${cookieBefore!.value}`);
    expect(replayed.status).toBe(401);
  });

  it("logout-all revokes every session, including the current one", async () => {
    const userId = await createUser({ email: EMAIL });
    const laptop = await loggedInClient(EMAIL);
    const phone = await loggedInClient(EMAIL);

    const res = await laptop.send("post", "/api/v1/auth/logout-all");
    expect(res.status).toBe(200);
    expect(res.body.data.revokedSessions).toBe(2);
    expect((await phone.get("/api/v1/auth/me")).status).toBe(401);
    expect((await laptop.get("/api/v1/auth/me")).status).toBe(401);
    expect(await auditTypes(userId)).toContain("LOGOUT_ALL");
  });

  it("logout-all requires authentication", async () => {
    const res = await new TestClient().send("post", "/api/v1/auth/logout-all");
    expect(res.status).toBe(401);
  });

  it("lists own sessions and cannot revoke another user's session (IDOR)", async () => {
    await createUser({ email: EMAIL });
    await createUser({ email: "eve@garment.test" });
    const ada = await loggedInClient(EMAIL);
    await loggedInClient("eve@garment.test");

    const list = await ada.get("/api/v1/auth/sessions");
    expect(list.body.data.sessions).toHaveLength(1);
    expect(list.body.data.sessions[0].current).toBe(true);

    const { rows } = await sql(
      "SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'eve@garment.test'",
    );
    const res = await ada.send("delete", `/api/v1/auth/sessions/${rows[0].id}`);
    expect(res.status).toBe(404);
    const eve = await sql("SELECT revoked_at FROM sessions WHERE id = $1", [rows[0].id]);
    expect(eve.rows[0].revoked_at).toBeNull();
  });
});

describe("POST /auth/change-password", () => {
  it("changes the password, revokes all sessions and rotates the current one", async () => {
    const userId = await createUser({ email: EMAIL });
    const other = await loggedInClient(EMAIL);
    const client = await loggedInClient(EMAIL);
    const oldCookie = client.agent.jar.getCookie("gm_session", {
      domain: "127.0.0.1",
      path: "/",
      secure: false,
      script: false,
    });

    expect(oldCookie?.value).toMatch(/^[\w-]{43}$/);

    const res = await client.send("post", "/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: "a brand new long passphrase",
    });
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).not.toContain(oldCookie!.value);

    expect((await client.get("/api/v1/auth/me")).status).toBe(200);
    expect((await other.get("/api/v1/auth/me")).status).toBe(401);
    expect((await new TestClient().login(EMAIL)).status).toBe(401);
    expect((await new TestClient().login(EMAIL, "a brand new long passphrase")).status).toBe(200);
    expect(await auditTypes(userId)).toContain("PASSWORD_CHANGED");
  });

  it("rejects a wrong current password without signing the user out", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const res = await client.send("post", "/api/v1/auth/change-password", {
      currentPassword: "not my password at all",
      newPassword: "a brand new long passphrase",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("AUTH_CURRENT_PASSWORD_INCORRECT");
    expect((await client.get("/api/v1/auth/me")).status).toBe(200);
  });

  it("rejects reusing the current password and common passwords", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const reuse = await client.send("post", "/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(reuse.body.error.code).toBe("PASSWORD_REUSED");

    const weak = await client.send("post", "/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: "password1234",
    });
    expect(weak.body.error.code).toBe("PASSWORD_TOO_WEAK");

    const short = await client.send("post", "/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: "short",
    });
    expect(short.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts long passphrases (64+ characters)", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const passphrase = "this is a deliberately long passphrase that exceeds sixty-four characters easily";
    const res = await client.send("post", "/api/v1/auth/change-password", {
      currentPassword: PASSWORD,
      newPassword: passphrase,
    });
    expect(res.status).toBe(200);
    expect((await new TestClient().login(EMAIL, passphrase)).status).toBe(200);
  });
});

describe("CSRF protection", () => {
  it("rejects a state-changing request without a token", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const res = await client.agent.post("/api/v1/auth/logout").set("Origin", ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_INVALID");
  });

  it("rejects an invalid token", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const res = await client.agent.post("/api/v1/auth/logout").set("Origin", ORIGIN).set("X-CSRF-Token", "forged");
    expect(res.status).toBe(403);
  });

  it("accepts a valid token", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const res = await client.agent
      .post("/api/v1/auth/logout")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", client.csrfToken!);
    expect(res.status).toBe(200);
  });

  it("rejects a valid token sent from a foreign origin", async () => {
    await createUser({ email: EMAIL });
    const client = await loggedInClient(EMAIL);
    const res = await client.agent
      .post("/api/v1/auth/logout")
      .set("Origin", "https://evil.example")
      .set("X-CSRF-Token", client.csrfToken!);
    expect(res.status).toBe(403);
  });

  it("binds tokens to the session: the pre-login token is useless after login", async () => {
    await createUser({ email: EMAIL });
    const client = new TestClient();
    const anonymousToken = await client.csrf();
    await client.login(EMAIL);
    expect(client.csrfToken).not.toBe(anonymousToken);
    const res = await client.agent
      .post("/api/v1/auth/logout")
      .set("Origin", ORIGIN)
      .set("X-CSRF-Token", anonymousToken);
    expect(res.status).toBe(403);
  });

  it("requires a token for login (login CSRF)", async () => {
    await createUser({ email: EMAIL });
    const res = await new TestClient().agent
      .post("/api/v1/auth/login")
      .set("Origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe("cookie configuration", () => {
  it("uses __Host- prefixed, Secure, HttpOnly, SameSite=Lax cookies in production", () => {
    const prod = { isProduction: true, sessionAbsoluteTimeoutMs: 3_600_000 };
    expect(cookieNames(prod)).toEqual({ session: "__Host-gm_session", csrf: "__Host-gm_csrf" });
    expect(sessionCookieOptions(prod)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 3_600_000,
    });
  });
});
