// Reserving from library code (the light family: classify, outline status,
// suggestions), where the reservation sits deep inside a run that may be
// shared or skipped. The lib reserves only when the model would actually run
// and throws ModelCallLimitedError when refused; the route turns that into
// the 429 (src/lib/limits/http.ts).

import { currentModelContext } from "@/lib/llm/context";
import type { LimitFamily, LimitRefusal, LimitSubject } from "./contract";
import { reserveModelCall } from "./limiter";

export class ModelCallLimitedError extends Error {
  constructor(readonly refusal: LimitRefusal, readonly userMessage?: string) {
    super(userMessage ?? `Model call limit reached (${refusal.scope} ${refusal.family ?? "key"}).`);
    this.name = "ModelCallLimitedError";
  }
}

/** The explicit subject, else the request's model context (set by the route), else null. */
export function limitSubject(explicit?: LimitSubject | null): LimitSubject | null {
  if (explicit) return explicit;
  const ctx = currentModelContext();
  return ctx ? { userId: ctx.userId, teamId: ctx.teamId } : null;
}

/**
 * Reserve one call of the family for the subject, or throw
 * ModelCallLimitedError. Without a subject (scripts, internal calls with no
 * request behind them) nothing is counted.
 */
export async function reserveOrThrow(subject: LimitSubject | null, family: LimitFamily, opts: { cost?: number; now?: number } = {}): Promise<void> {
  if (!subject) return;
  const decision = await reserveModelCall(subject, family, opts);
  if (!decision.ok) throw new ModelCallLimitedError(decision);
}
