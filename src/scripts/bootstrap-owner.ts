// Creates the first OWNER account from environment variables. Refuses to run once
// any owner exists, so it cannot be used to mint privileged accounts later.
//
//   BOOTSTRAP_OWNER_EMAIL=... BOOTSTRAP_OWNER_NAME=... BOOTSTRAP_OWNER_PASSWORD=... npm run bootstrap:owner
//
// Remove BOOTSTRAP_OWNER_PASSWORD from the environment afterwards.
import { z } from "zod";

import { prisma, transaction } from "../db/prisma";
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

  const userId = await transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY}::bigint)`;
    if (await tx.user.findFirst({ where: { role: { key: OWNER_ROLE } }, select: { id: true } })) {
      throw new Error("An owner already exists. Bootstrap is disabled; invite users from the app.");
    }
    const role = await tx.role.findUnique({ where: { key: OWNER_ROLE }, select: { id: true } });
    if (!role) throw new Error("OWNER role missing. Run migrations first (npm run db:migrate).");

    const { id } = await tx.user.create({
      data: { email, name, passwordHash, status: "ACTIVE", roleId: role.id, passwordChangedAt: new Date() },
      select: { id: true },
    });
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
  await prisma.$disconnect();
}
