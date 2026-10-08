// Creates the first OWNER account from environment variables. Refuses to run once
// any owner exists, so it cannot be used to mint privileged accounts later.
//
//   BOOTSTRAP_OWNER_EMAIL=... BOOTSTRAP_OWNER_NAME=... BOOTSTRAP_OWNER_PASSWORD=... npm run bootstrap:owner
//
// Remove BOOTSTRAP_OWNER_PASSWORD from the environment afterwards.
import { z } from "zod";

import { pool, withTransaction } from "../db/pool";
import { logger } from "../lib/logger";
import { recordAudit } from "../modules/audit/audit.service";
import { emailSchema, nameSchema, newPasswordSchema } from "../modules/auth/auth.schema";
import { assertPasswordPolicy, hashPassword } from "../modules/auth/password";
import { OWNER_ROLE } from "../modules/permissions/permission.types";

const BOOTSTRAP_LOCK_KEY = 728_391_005;

const input = z
  .object({
    BOOTSTRAP_OWNER_EMAIL: emailSchema,
    BOOTSTRAP_OWNER_NAME: nameSchema,
    BOOTSTRAP_OWNER_PASSWORD: newPasswordSchema,
  })
  .safeParse(process.env);

async function main(): Promise<void> {
  if (!input.success) {
    throw new Error(
      `Invalid bootstrap input:\n${input.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n")}`,
    );
  }
  const { BOOTSTRAP_OWNER_EMAIL: email, BOOTSTRAP_OWNER_NAME: name, BOOTSTRAP_OWNER_PASSWORD: password } = input.data;
  assertPasswordPolicy(password, { email, name });
  const passwordHash = await hashPassword(password);

  const userId = await withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [BOOTSTRAP_LOCK_KEY]);
    const owners = await tx.query("SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = $1 LIMIT 1", [
      OWNER_ROLE,
    ]);
    if (owners.rowCount) throw new Error("An owner already exists. Bootstrap is disabled; invite users from the app.");

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash, status, role_id, password_changed_at)
       SELECT $1, $2, $3, 'ACTIVE', r.id, now() FROM roles r WHERE r.key = $4
       RETURNING id`,
      [email, name, passwordHash, OWNER_ROLE],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("OWNER role missing. Run migrations first.");
    await recordAudit(tx, { type: "OWNER_BOOTSTRAPPED", targetUserId: id, metadata: { source: "cli" } });
    return id;
  });

  logger.info({ userId }, "owner account created");
}

try {
  await main();
} catch (error) {
  logger.fatal({ err: error }, "bootstrap failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
