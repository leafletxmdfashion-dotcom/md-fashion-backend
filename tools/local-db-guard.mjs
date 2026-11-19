// Refuses to run a migration against a remote database from a development machine.
// The live (production) database must only be migrated on purpose:
//   NODE_ENV=production npm run db:migrate      (deploy pipeline)
//   ALLOW_REMOTE_MIGRATE=1 npm run db:migrate   (deliberate one-off)
import "dotenv/config";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
let host = "";

try {
  host = new URL(url).hostname;
} catch {
  console.error("DATABASE_URL / DIRECT_URL is missing or not a valid URL.");
  process.exit(1);
}

const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);

if (!local && process.env.NODE_ENV !== "production" && process.env.ALLOW_REMOTE_MIGRATE !== "1") {
  console.error(
    `Refusing to migrate remote database "${host}" from a development machine.\n` +
      "Point DATABASE_URL/DIRECT_URL at the local dev database, or set ALLOW_REMOTE_MIGRATE=1 on purpose.",
  );
  process.exit(1);
}
