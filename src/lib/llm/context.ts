// Who a model call is for, carried through async work without threading it
// through every function (phase9-spec.md §3.2). A route sets it once from the
// caller; claude.ts, call.ts and the Gemini readers read it when they write
// their audit rows, and an explicit field on the call's input wins over it.
//
// Next's after() binds its callback to the context at the time after() is
// called, so background work (ingest, workflow runs) started after the route
// set the context keeps it. Inside library code prefer withModelContext.

import { AsyncLocalStorage } from "node:async_hooks";

export type ModelCallContext = {
  teamId: string;
  userId: string;
  /** Who asked, for the audit log's agent column (an email, or the user id). */
  agent?: string;
  documentId?: string | null;
  runId?: string | null;
};

const storage = new AsyncLocalStorage<ModelCallContext>();

/** Run `fn` with `ctx` as the model context (merged over any outer one). */
export function withModelContext<T>(ctx: Partial<ModelCallContext> & Pick<ModelCallContext, "teamId" | "userId">, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

/**
 * Set the model context for the rest of the current request. Call it
 * synchronously in the route body (not inside an awaited helper: a context
 * entered inside an async function ends when that function returns).
 */
export function enterModelContext(ctx: Partial<ModelCallContext> & Pick<ModelCallContext, "teamId" | "userId">): void {
  storage.enterWith({ ...storage.getStore(), ...ctx });
}

/** The current model context, or null outside any. */
export function currentModelContext(): ModelCallContext | null {
  return storage.getStore() ?? null;
}

/** The context for a requireTeam caller. */
export function contextFor(caller: { teamId: string; userId: string; agent: string }, extra: { documentId?: string | null; runId?: string | null } = {}): ModelCallContext {
  return { teamId: caller.teamId, userId: caller.userId, agent: caller.agent, ...extra };
}
