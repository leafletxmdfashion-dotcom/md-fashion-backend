import "dotenv/config";

import pg from "pg";

import { migrate } from "../db/migrate";

// Rebuilds the test database schema from migrations once per run.
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL");

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
