import "dotenv/config";

import { defineConfig } from "prisma/config";

// The CLI (migrate, db pull, studio) connects with DIRECT_URL when set: Neon's pooled
// URL cannot hold the advisory lock Prisma Migrate takes. The app itself connects
// through the driver adapter in src/db/prisma.ts using DATABASE_URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || "",
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
});
