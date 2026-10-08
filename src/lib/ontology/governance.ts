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

/**
 * The token usage or error of an LLM call's result, in one line, so a local
 * run without a database can still see what each model call cost. Null for
 * any other result.
 */
export function usageLine(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.input_tokens === "number" && typeof r.output_tokens === "number") {
    const cached = Number(r.cache_read_input_tokens) || 0;
    return `${typeof r.model === "string" ? r.model : "model"} in=${r.input_tokens} out=${r.output_tokens}${cached ? ` cached=${cached}` : ""}`;
  }
  return typeof r.error === "string" ? `error: ${r.error.slice(0, 200)}` : null;
}

/** Console sink for local runs without a database. */
export const consoleAuditSink: AuditSink = {
  async write(e) {
    const usage = usageLine(e.result);
    console.log(`[audit] ${e.allowed ? "ALLOW" : "DENY "} ${e.agent} · ${e.action}${e.note ? " · " + e.note : ""}${usage ? " · " + usage : ""}`);
  },
};

/** Pick a sink by environment: Postgres when configured, else console. */
export function defaultAuditSink(): AuditSink {
  return process.env.POSTGRES_URL ? postgresAuditSink : consoleAuditSink;
}
