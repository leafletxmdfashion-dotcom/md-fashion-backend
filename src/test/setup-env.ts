import "dotenv/config";

import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

// Runs before each test file's imports resolve the env module.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.CLIENT_URL = "http://localhost:3000";
process.env.CSRF_SECRET = "test-csrf-secret-test-csrf-secret-0123456789";
process.env.TRUST_PROXY = "false";
process.env.MAIL_TRANSPORT = "outbox";
process.env.MAIL_OUTBOX_DIR = path.join(os.tmpdir(), `garment-test-outbox-${process.pid}`);

afterAll(async () => {
  const { pool } = await import("../db/pool");
  await pool.end();
});
