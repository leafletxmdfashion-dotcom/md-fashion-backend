import { createApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./db/prisma";
import { logger } from "./lib/logger";

const server = createApp().listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "API listening");
});

const shutdown = (signal: string) => {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
