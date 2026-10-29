import "dotenv/config";

import { rebuildDatabase } from "./rebuild-database";

// Rebuilds the test database schema from migrations once per run.
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for integration tests");
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL");

  const db = await rebuildDatabase(url);
  // The migrated role grants, so each test can start from them (tests edit roles).
  await db.$executeRawUnsafe("DROP SCHEMA IF EXISTS test_seed CASCADE");
  await db.$executeRawUnsafe("CREATE SCHEMA test_seed");
  await db.$executeRawUnsafe("CREATE TABLE test_seed.role_permissions AS SELECT * FROM public.role_permissions");
  await db.$executeRawUnsafe("CREATE TABLE test_seed.roles AS SELECT id FROM public.roles");
  await db.$disconnect();
}
