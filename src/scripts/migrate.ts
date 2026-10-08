import { migrate } from "../db/migrate";
import { pool } from "../db/pool";
import { logger } from "../lib/logger";

try {
  const applied = await migrate(pool);
  logger.info({ applied }, applied.length ? "migrations applied" : "database up to date");
} catch (error) {
  logger.fatal({ err: error }, "migration failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
