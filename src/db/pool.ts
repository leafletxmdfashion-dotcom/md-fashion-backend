import pg from "pg";

import { env } from "../config/env";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.isTest ? 5 : 10,
});

// Accepts either the pool or a transaction client so repositories can join a transaction.
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export async function withTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
