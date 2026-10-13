// Test support for the frontend Playwright suite: rebuilds the database named by
// DATABASE_URL and seeds fixed accounts. Refuses to touch anything but an *_e2e database.
//   DATABASE_URL=.../garment_e2e npx tsx src/test/e2e-reset.ts
import { hashPassword } from "../modules/auth/password";
import { rebuildDatabase } from "./rebuild-database";

const url = process.env.DATABASE_URL ?? "";
if (!/\/\w+_e2e(\?|$)/.test(url)) {
  throw new Error("e2e-reset only runs against a database whose name ends in _e2e");
}

const E2E_PASSWORD = "correct horse battery staple";

const db = await rebuildDatabase(url);
try {
  const passwordHash = await hashPassword(E2E_PASSWORD);
  const roles = new Map((await db.role.findMany({ select: { id: true, key: true } })).map((r) => [r.key, r.id]));
  await db.user.createMany({
    data: [
      { email: "owner@garment.test", name: "Olivia Owner", role: "OWNER" },
      { email: "staff@garment.test", name: "Sam Staff", role: "STAFF" },
      { email: "reset@garment.test", name: "Riley Reset", role: "STAFF" },
    ].map(({ role, ...user }) => ({ ...user, passwordHash, status: "ACTIVE" as const, roleId: roles.get(role)! })),
  });
} finally {
  await db.$disconnect();
}
