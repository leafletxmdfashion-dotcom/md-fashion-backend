import { execSync } from "node:child_process";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client";

/**
 * Empties the database at `url` and applies every Prisma migration, exactly as a
 * deploy would. Returns a client for seeding; the caller disconnects it.
 */
export async function rebuildDatabase(url: string): Promise<PrismaClient> {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });
  await db.$executeRawUnsafe("DROP SCHEMA public CASCADE");
  await db.$executeRawUnsafe("CREATE SCHEMA public");
  // DIRECT_URL is set too: prisma.config.ts prefers it, and .env may point it elsewhere.
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    stdio: "pipe",
  });
  return db;
}
