import "dotenv/config";

import { rebuildDatabase } from "./rebuild-database";

// Rebuilds the test database schema from migrations once per run.
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL");

  const db = await rebuildDatabase(url);
  await db.$disconnect();
}
