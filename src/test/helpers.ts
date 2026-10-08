import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import request from "supertest";
import type { App } from "supertest/types";

import { createApp } from "../app";
import { env } from "../config/env";
import { pool } from "../db/pool";
import { hashPassword } from "../modules/auth/password";
import type { UserStatus } from "../modules/sessions/session.types";

export const ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct horse battery staple";

export async function resetDatabase(): Promise<void> {
  await pool.query("TRUNCATE users, sessions, password_reset_tokens, invitations, audit_events CASCADE");
  await rm(env.MAIL_OUTBOX_DIR, { recursive: true, force: true });
}

let passwordHashCache: string | undefined;

export async function createUser(input: {
  email: string;
  role?: string;
  status?: UserStatus;
  name?: string;
  password?: string;
}): Promise<string> {
  const passwordHash =
    input.password && input.password !== PASSWORD
      ? await hashPassword(input.password)
      : (passwordHashCache ??= await hashPassword(PASSWORD));
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, status, role_id)
     SELECT $1, $2, $3, $4, id FROM roles WHERE key = $5 RETURNING id`,
    [input.email, input.name ?? "Test User", passwordHash, input.status ?? "ACTIVE", input.role ?? "STAFF"],
  );
  return rows[0]!.id;
}

/** A browser-like client: persistent cookie jar, Origin header and automatic CSRF token handling. */
export class TestClient {
  readonly agent: ReturnType<typeof request.agent>;
  csrfToken: string | undefined;

  constructor(readonly app: App = createApp()) {
    this.agent = request.agent(app);
  }

  async csrf(): Promise<string> {
    if (!this.csrfToken) {
      const res = await this.agent.get("/api/v1/auth/csrf");
      this.csrfToken = (res.body as { data: { csrfToken: string } }).data.csrfToken;
    }
    return this.csrfToken;
  }

  get(url: string) {
    return this.agent.get(url);
  }

  async send(method: "post" | "patch" | "put" | "delete", url: string, body?: object) {
    const token = await this.csrf();
    const res = await this.agent[method](url).set("Origin", ORIGIN).set("X-CSRF-Token", token).send(body);
    const rotated = res.headers["x-csrf-token"];
    if (typeof rotated === "string") this.csrfToken = rotated;
    return res;
  }

  login(email: string, password = PASSWORD) {
    return this.send("post", "/api/v1/auth/login", { email, password });
  }
}

export async function loggedInClient(email: string, password = PASSWORD, app?: App): Promise<TestClient> {
  const client = new TestClient(app);
  const res = await client.login(email, password);
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return client;
}

export function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const value = res.headers["set-cookie"];
  return Array.isArray(value) ? value.map(String) : [];
}

/** The last gm_session Set-Cookie wins, as in a browser (a stale cookie is cleared before a new one is set). */
export function sessionCookie(res: { headers: Record<string, unknown> }): string | undefined {
  return setCookies(res)
    .filter((cookie) => cookie.startsWith("gm_session="))
    .at(-1);
}

export async function readMails(to: string): Promise<{ to: string; subject: string; text: string }[]> {
  let files: string[];
  try {
    files = (await readdir(env.MAIL_OUTBOX_DIR)).sort();
  } catch {
    return [];
  }
  const mails = await Promise.all(
    files.map(
      async (file) =>
        JSON.parse(await readFile(path.join(env.MAIL_OUTBOX_DIR, file), "utf8")) as {
          to: string;
          subject: string;
          text: string;
        },
    ),
  );
  return mails.filter((mail) => mail.to === to);
}

export function tokenFromMail(text: string): string {
  const match = /#token=([A-Za-z0-9_-]{43})/.exec(text);
  if (!match?.[1]) throw new Error("no token in mail");
  return match[1];
}

export async function auditTypes(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM audit_events WHERE target_user_id = $1 ORDER BY created_at, event_type",
    [userId],
  );
  return rows.map((row) => row.event_type);
}
