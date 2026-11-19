import { createApp } from "./app";
import { env } from "./config/env";
import { prisma, warmUp } from "./db/prisma";
import { logger } from "./lib/logger";

const server = createApp().listen(env.PORT, () => {
  const db = new URL(env.DATABASE_URL);
  // Always visible which database is live: local dev must never write to production.
  logger.info({ port: env.PORT, env: env.NODE_ENV, db: `${db.hostname}${db.pathname}` }, "API listening");
  warmUp().catch((error: unknown) => logger.warn({ err: error }, "database warm-up failed"));
});

const shutdown = (signal: string) => {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
