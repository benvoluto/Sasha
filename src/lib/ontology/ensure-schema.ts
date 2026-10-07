// Apply a feature's tables and columns on first use. Schema setup is otherwise
// a manual call to /api/ontology/setup, so a deploy that adds a table would
// fail every request until someone ran it. Each statement must be idempotent
// (IF NOT EXISTS); they run once per server process, in order.

import { sql } from "@vercel/postgres";

const applied = new Map<string, Promise<void>>();

export function ensureSchema(key: string, statements: string[]): Promise<void> {
  if (!process.env.POSTGRES_URL) return Promise.resolve();
  let p = applied.get(key);
  if (!p) {
    p = (async () => {
      for (const statement of statements) await sql.query(statement);
    })().catch((error) => {
      // Let the next request try again rather than caching the failure.
      applied.delete(key);
      throw error;
    });
    applied.set(key, p);
  }
  return p;
}
