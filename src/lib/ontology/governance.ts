// Shared governance contracts: an Auth model, a Postgres-backed audit sink, and
// permission checks. Every read/compute/write in the app path goes through here.

import { sql } from "@vercel/postgres";

export type Auth = { agent: string; permissions: string[] };

export function can(auth: Auth, permission: string): boolean {
  return auth.permissions.includes(permission);
}

export type AuditEntry = {
  agent: string;
  action: string;
  args: unknown;
  result: unknown;
  allowed: boolean;
  note?: string;
  groupId?: string;
};

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

/** Postgres-backed audit sink — the defensibility record. Requires POSTGRES_URL. */
export const postgresAuditSink: AuditSink = {
  async write(e) {
    await sql`
      INSERT INTO audit_log (agent, action, args, result, allowed, note, group_id)
      VALUES (${e.agent}, ${e.action}, ${JSON.stringify(e.args)},
              ${JSON.stringify(e.result)}, ${e.allowed}, ${e.note ?? ""}, ${e.groupId ?? null})
    `;
  },
};

/** Console sink for local runs without a database. */
export const consoleAuditSink: AuditSink = {
  async write(e) {
    console.log(`[audit] ${e.allowed ? "ALLOW" : "DENY "} ${e.agent} · ${e.action}${e.note ? " · " + e.note : ""}`);
  },
};

/** Pick a sink by environment: Postgres when configured, else console. */
export function defaultAuditSink(): AuditSink {
  return process.env.POSTGRES_URL ? postgresAuditSink : consoleAuditSink;
}
