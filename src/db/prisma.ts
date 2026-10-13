import { PrismaPg } from "@prisma/adapter-pg";

import { env } from "../config/env";
import { Prisma, PrismaClient } from "../generated/prisma/client";

export { Prisma };

export const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.isTest ? 5 : 10,
    // Fail fast when the database is unreachable or stuck, so requests (and the
    // web app's session check) get a prompt error instead of hanging.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  }),
});

/** The client or an interactive-transaction client, so repositories can join a transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;

export function transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { maxWait: 10_000, timeout: 20_000 });
}

/** A unique constraint rejected the write (e.g. a duplicate email or fabric code). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
