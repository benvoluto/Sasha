// Shared governance contracts: an Auth model, a Postgres-backed audit sink, and
// permission checks. Every read/compute/write in the app path goes through here.
//
// Without POSTGRES_URL the default sink logs to the console and keeps the last
// AUDIT_BUFFER_SIZE entries in process memory, so the usage dashboard
// (src/lib/usage) has this process's recent model calls to show.

import { sql } from "@vercel/postgres";
import { ensureSchema } from "@/lib/ontology/ensure-schema";
import { AUDIT_LOG_SCHEMA } from "@/lib/ontology/audit-schema";
import { processMemory } from "@/lib/process-memory";

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
  /**
   * Phase 9 model-usage columns (src/lib/ontology/audit-schema.ts). Model calls
   * fill them from their input or the current model context
   * (src/lib/llm/context.ts); other entries leave them out.
   */
  teamId?: string | null;
  userId?: string | null;
  documentId?: string | null;
  runId?: string | null;
  /** The task (tasks.ts), or `gemini.<kind>` / `workflow.node` for calls outside the task table. */
  task?: string | null;
  model?: string | null;
  latencyMs?: number | null;
};

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

/** Postgres-backed audit sink — the defensibility record. Requires POSTGRES_URL. */
export const postgresAuditSink: AuditSink = {
  async write(e) {
    // The Phase 9 columns, applied once per process (audit_log itself comes from setup).
    await ensureSchema("audit_log", AUDIT_LOG_SCHEMA);
    const latency = typeof e.latencyMs === "number" && Number.isFinite(e.latencyMs) ? Math.round(e.latencyMs) : null;
    await sql`
      INSERT INTO audit_log (agent, action, args, result, allowed, note, group_id,
                             team_id, user_id, document_id, run_id, task, model, latency_ms)
      VALUES (${e.agent}, ${e.action}, ${JSON.stringify(e.args)},
              ${JSON.stringify(e.result)}, ${e.allowed}, ${e.note ?? ""}, ${e.groupId ?? null},
              ${e.teamId ?? null}, ${e.userId ?? null}, ${e.documentId ?? null}, ${e.runId ?? null},
              ${e.task ?? null}, ${e.model ?? null}, ${latency})
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

/** Entries the in-memory buffer keeps; older ones drop off the front. */
export const AUDIT_BUFFER_SIZE = 5000;

/** An audit entry as the in-memory buffer keeps it: the entry plus when it was written (ISO). */
export type MemoryAuditEntry = AuditEntry & { ts: string };

const buffer = processMemory("audit.buffer", () => [] as MemoryAuditEntry[]);

/** Keeps the last AUDIT_BUFFER_SIZE entries in process memory (no database). */
export const memoryAuditSink: AuditSink = {
  async write(e) {
    buffer.push({ ...e, ts: new Date().toISOString() });
    if (buffer.length > AUDIT_BUFFER_SIZE) buffer.splice(0, buffer.length - AUDIT_BUFFER_SIZE);
  },
};

/** The in-memory buffer's entries, oldest first (a copy). Empty when a database is configured. */
export function readMemoryAudit(): MemoryAuditEntry[] {
  return buffer.slice();
}

/** Empties the in-memory buffer (tests). */
export function resetMemoryAudit(): void {
  buffer.length = 0;
}

const localSink: AuditSink = {
  async write(e) {
    await memoryAuditSink.write(e);
    await consoleAuditSink.write(e);
  },
};

/** Pick a sink by environment: Postgres when configured, else console plus the in-memory buffer. */
export function defaultAuditSink(): AuditSink {
  return process.env.POSTGRES_URL ? postgresAuditSink : localSink;
}
