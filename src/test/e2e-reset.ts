// Test support for the frontend Playwright suite: rebuilds the database named by
// DATABASE_URL and seeds fixed accounts. Refuses to touch anything but an *_e2e database.
//   DATABASE_URL=.../garment_e2e npx tsx src/test/e2e-reset.ts
import pg from "pg";

import { migrate } from "../db/migrate";
import { hashPassword } from "../modules/auth/password";

const url = process.env.DATABASE_URL ?? "";
if (!/\/\w+_e2e(\?|$)/.test(url)) {
  throw new Error("e2e-reset only runs against a database whose name ends in _e2e");
}

const E2E_PASSWORD = "correct horse battery staple";

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool);
  const hash = await hashPassword(E2E_PASSWORD);
  await pool.query(
    `INSERT INTO users (email, name, password_hash, status, role_id)
     SELECT v.email, v.name, $1, v.status::user_status, r.id
     FROM (VALUES
       ('owner@garment.test', 'Olivia Owner', 'ACTIVE', 'OWNER'),
       ('staff@garment.test', 'Sam Staff', 'ACTIVE', 'STAFF'),
       ('reset@garment.test', 'Riley Reset', 'ACTIVE', 'STAFF')
     ) AS v (email, name, status, role_key)
     JOIN roles r ON r.key = v.role_key`,
    [hash],
  );
} finally {
  await pool.end();
}
