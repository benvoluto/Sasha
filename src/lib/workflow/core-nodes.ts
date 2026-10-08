// Implementations of the engine's own nodes (node-specs/core.ts): the generic
// AI and text/logic nodes kept from the organizer, the human checkpoint, and
// the outcome node every workflow ends in. Server-only. The engine merges this
// map with ./nodes and ./generic.

import { z } from "zod";
import { getType } from "@/catalog";
import type { ModelChoice } from "@/lib/llm/model-choice";
import { NodeError, type NodeContext, type NodeHandler } from "./context";
import type { CheckpointDecision, CheckpointEdits, CheckpointSignature, ContinueRequest, RestructurePlan, WorkflowRunRecord } from "./contract";
import { callForJson, callForText, coerceJson, CALL_TIMEOUT_MS } from "./model-json";
import { CHECKPOINT_NODE_TYPE, OUTPUT_NODE_TYPE, type CheckpointConfig, type OutcomeReportConfig } from "./node-specs/core";
import { evaluateOutcome, OutcomeValueError, signOutcome } from "./outcome";
import { configFor, NODE_SPEC_INDEX } from "./registry";
import { renderTemplate, asText } from "./template";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const asModel = (c: Record<string, unknown>) => c as unknown as ModelChoice;
/** A model call never outlives the invocation: the per-call timeout, capped at the time left. */
const timeoutFor = (ctx: NodeContext) => Math.max(1_000, Math.min(CALL_TIMEOUT_MS, ctx.deadline - Date.now()));

/** Node display labels by id (the outcome lists failed steps by label). */
export function nodeLabels(run: Pick<WorkflowRunRecord, "graph">): Record<string, string> {
  return Object.fromEntries(run.graph.nodes.map((n) => [n.id, n.label || NODE_SPEC_INDEX[n.type]?.label || n.type]));
}

/** Keep the outcome node's output in step with run.outcome after a checkpoint stamps it. */
function syncOutcomeOutput(run: WorkflowRunRecord) {
  const id = run.graph.nodes.find((n) => n.type === OUTPUT_NODE_TYPE)?.id;
  if (id && run.outcome && run.outputs[id]) run.outputs[id] = { ...run.outputs[id], outcome: run.outcome };
}

export const CORE_HANDLERS: Record<string, NodeHandler> = {
  [CHECKPOINT_NODE_TYPE]: async (inputs, r, ctx) => {
    const decision = ctx.run.checkpoints[r.node.id];
    if (!decision) return "wait";
    const config = r.config as CheckpointConfig;
    const items = ((inputs.items as unknown[]) ?? []).filter((_, i) => !decision.excluded.includes(i));
    if (config.signsOutcome && ctx.run.outcome) {
      ctx.run.outcome = signOutcome(ctx.run.outcome, decision);
      syncOutcomeOutput(ctx.run);
    }
    const passed = decision.verdict === "approve" || decision.verdict === "edit";
    return { items, decision, ...(passed ? { approved: items } : { rejected: items }) };
  },

  [OUTPUT_NODE_TYPE]: async (inputs, r, ctx) => {
    try {
      const outcome = evaluateOutcome(r.config as OutcomeReportConfig, inputs, {
        workflowId: ctx.run.workflow_id,
        steps: ctx.run.steps,
        checkpoints: ctx.run.checkpoints,
        labels: nodeLabels(ctx.run),
      });
      ctx.run.outcome = outcome;
      return { outcome };
    } catch (e) {
      if (e instanceof OutcomeValueError) throw new NodeError(e.message);
      throw e;
    }
  },

  "ai.ask": async (inputs, r, ctx) => {
    const prompt = renderTemplate(String(r.config.prompt), inputs);
    return {
      response: await callForText(asModel(r.config), "You are a careful research and writing assistant. Answer only from the material provided.", prompt, r.node.label || "Ask AI", timeoutFor(ctx)),
    };
  },

  "ai.extract": async (inputs, r, ctx) => {
    const fields = r.config.fields as Array<{ name: string; description: string; list: boolean }>;
    const shape = Object.fromEntries(fields.map((f) => [f.name, f.list ? z.array(z.string()) : z.string()]));
    const schema = z.object(shape);
    const system = [
      "Extract information from the text. Return ONLY a JSON object with exactly these keys:",
      ...fields.map((f) => `- "${f.name}" (${f.list ? "array of strings" : "string"}): ${f.description}`),
      'Use "" or [] when the text does not contain it.',
      r.config.context ? `Context: ${r.config.context}` : "",
    ].join("\n");
    const out = await callForJson(
      asModel(r.config),
      system,
      asText(inputs.text),
      (t) => {
        try {
          const p = schema.safeParse(coerceJson(t));
          return p.success ? { ok: true as const, value: p.data } : { ok: false as const, error: z.prettifyError(p.error) };
        } catch (e) {
          return { ok: false as const, error: message(e) };
        }
      },
      r.node.label || "Extract data",
      timeoutFor(ctx),
    );
    if (!out.value) throw new NodeError(out.error ?? "invalid reply", out.text);
    return out.value;
  },

  "ai.categorize": async (inputs, r, ctx) => {
    const categories = r.config.categories as Array<{ name: string; description: string }>;
    const system = [
      'Choose the ONE category that best fits the text. Return ONLY JSON: {"category": <exact category name>, "justification": <one sentence>}.',
      "Categories:",
      ...categories.map((c) => `- ${c.name}: ${c.description}`),
    ].join("\n");
    const out = await callForJson(
      asModel(r.config),
      system,
      asText(inputs.text),
      (t) => {
        try {
          const v = z.object({ category: z.string(), justification: z.string().default("") }).parse(coerceJson(t));
          const match = categories.find((c) => c.name.toLowerCase() === v.category.trim().toLowerCase());
          return match ? { ok: true as const, value: { category: match.name, justification: v.justification } } : { ok: false as const, error: `"${v.category}" is not one of the categories` };
        } catch (e) {
          return { ok: false as const, error: message(e) };
        }
      },
      r.node.label || "Categorizer",
      timeoutFor(ctx),
    );
    if (!out.value) throw new NodeError(out.error ?? "invalid reply", out.text);
    return out.value;
  },

  "text.combine": async (inputs, r) => ({ text: renderTemplate(String(r.config.template), inputs) }),

  "logic.if": async (inputs, r) => {
    const test = asText(inputs.test ?? inputs.value);
    const value = String(r.config.value ?? "");
    const pass =
      r.config.operator === "contains"
        ? test.toLowerCase().includes(value.toLowerCase())
        : r.config.operator === "equals"
          ? test.trim().toLowerCase() === value.trim().toLowerCase()
          : r.config.operator === "not_empty"
            ? test.trim().length > 0
            : test.trim().length === 0;
    return pass ? { true: inputs.value } : { false: inputs.value };
  },

  "logic.router": async (inputs, r) => {
    const key = asText(inputs.key ?? inputs.value).trim().toLowerCase();
    const routes = r.config.routes as Array<{ name: string; match: string }>;
    const hit = routes.find((rt) => (r.config.mode === "contains" ? key.includes(rt.match.toLowerCase()) : key === rt.match.trim().toLowerCase()));
    return { [hit ? hit.name : "other"]: inputs.value };
  },
};

// --- Checkpoint decisions (POST …/runs/[runId]/continue) -----------------------------

export type ContinueCheckpoint = NonNullable<z.output<typeof ContinueRequest>["checkpoint"]>;

/**
 * Check a person's decision at a waiting checkpoint and build what is stored:
 * the verdict must be allowed (edit needs `editable` other than none), an
 * edited outcome value must be one of the outcome's values, edited targets
 * must name the plan's rows and the target type's sections (or null), and
 * every required record field must be filled. Excluded positions out of range,
 * or given when the checkpoint doesn't allow leaving items out, are dropped.
 *
 * At a checkpoint with named signers the person signs as one signer not yet
 * signed (and as at most one). `complete` says whether the decision is final:
 * every signer has signed, or this one rejects. Until then the route keeps
 * `signatures` in the checkpoint's output and the run stays waiting.
 */
export async function checkpointDecisionFor(
  run: WorkflowRunRecord,
  cp: ContinueCheckpoint,
  by: string,
): Promise<{ ok: true; decision: CheckpointDecision; complete: boolean; signatures: CheckpointSignature[] } | { ok: false; error: string }> {
  const node = run.graph.nodes.find((n) => n.id === cp.nodeId);
  if (!node || node.type !== CHECKPOINT_NODE_TYPE || run.steps[cp.nodeId]?.status !== "waiting") return { ok: false, error: "Name the waiting checkpoint to continue." };
  const config = configFor(NODE_SPEC_INDEX[CHECKPOINT_NODE_TYPE], node.config) as CheckpointConfig;
  const edits = cp.edits;
  if (cp.verdict === "edit" && config.editable === "none") return { ok: false, error: "This checkpoint can't be edited; approve or reject it." };
  if (cp.verdict !== "edit" && (edits?.outcomeValue !== undefined || edits?.targets !== undefined)) return { ok: false, error: "Edits need the edit verdict." };

  if (edits?.outcomeValue !== undefined) {
    if (config.editable !== "outcome") return { ok: false, error: "This checkpoint doesn't change the outcome." };
    const out = run.graph.nodes.find((n) => n.type === OUTPUT_NODE_TYPE);
    const values = out ? (configFor(NODE_SPEC_INDEX[OUTPUT_NODE_TYPE], out.config) as OutcomeReportConfig).values : [];
    if (!values.some((v) => v.key === edits.outcomeValue)) return { ok: false, error: "That isn't one of the outcome's values." };
  }

  if (edits?.targets !== undefined) {
    if (config.editable !== "rows") return { ok: false, error: "This checkpoint doesn't change a mapping." };
    const plan = run.graph.nodes
      .filter((n) => n.type === "restructure.plan")
      .map((n) => run.outputs[n.id]?.plan as RestructurePlan | undefined)
      .find((p) => p && Array.isArray(p.rows));
    if (!plan) return { ok: false, error: "There is no mapping to change." };
    const rows = new Set(plan.rows.map((r) => r.id));
    const sections = new Set(((await getType(run.team_id, plan.targetType))?.definition.sections ?? []).map((s) => s.key));
    for (const [row, target] of Object.entries(edits.targets)) {
      if (!rows.has(row)) return { ok: false, error: `Unknown row ${row}.` };
      if (target !== null && !sections.has(target)) return { ok: false, error: `Unknown section ${target}.` };
    }
  }

  const record: Record<string, string> = {};
  for (const f of config.recordFields) {
    const v = (edits?.record?.[f.key] ?? "").trim();
    if (f.required && !v && cp.verdict !== "reject") return { ok: false, error: `Fill in “${f.label}”.` };
    if (v) record[f.key] = v;
  }

  const pending = ((run.outputs[cp.nodeId]?.pending_items as unknown[]) ?? []).length;
  const excluded = config.allowExclude ? [...new Set(cp.excluded.filter((i) => i < pending))] : [];
  const cleaned: CheckpointEdits | null =
    edits || Object.keys(record).length
      ? {
          ...(edits?.outcomeValue !== undefined ? { outcomeValue: edits.outcomeValue } : {}),
          ...(edits?.targets !== undefined ? { targets: edits.targets } : {}),
          ...(Object.keys(record).length ? { record } : {}),
        }
      : null;
  const decision: CheckpointDecision = { verdict: cp.verdict, note: cp.note, by, at: new Date().toISOString(), role: config.role, excluded, edits: cleaned };
  if (!config.signers.length) return { ok: true, decision, complete: true, signatures: [] };

  const prior = checkpointSignatures(run, cp.nodeId);
  const signer = config.signers.find((x) => x.key === cp.signer);
  if (!signer) return { ok: false, error: `Say who you are signing as: ${config.signers.map((x) => x.label).join(" or ")}.` };
  if (prior.some((x) => x.signer === signer.key)) return { ok: false, error: `${signer.label} has already signed.` };
  if (prior.some((x) => x.by === by)) return { ok: false, error: "You have already signed this checkpoint; another person signs as the other approver." };
  const signatures = [...prior, { signer: signer.key, label: signer.label, verdict: cp.verdict, note: cp.note, by, at: decision.at, edits: cleaned }];
  const complete = cp.verdict === "reject" || config.signers.every((x) => signatures.some((g) => g.signer === x.key));
  return { ok: true, decision: combineSignatures(config, signatures, excluded), complete, signatures };
}

/** The signatures a checkpoint with named signers has collected so far (kept in its output while it waits). */
export function checkpointSignatures(run: Pick<WorkflowRunRecord, "outputs">, nodeId: string): CheckpointSignature[] {
  const list = run.outputs[nodeId]?.signatures;
  return Array.isArray(list) ? (list as CheckpointSignature[]).filter((x) => x && typeof x.signer === "string" && typeof x.by === "string") : [];
}

/**
 * Pure: the one decision the signatures make. Any rejection rejects; else any
 * edit makes it an edit, with the edits laid over each other in signing order.
 * Every signer is named in `by`; notes keep who wrote them.
 */
export function combineSignatures(config: Pick<CheckpointConfig, "role">, signatures: CheckpointSignature[], excluded: number[] = []): CheckpointDecision {
  const verdict = signatures.some((x) => x.verdict === "reject") ? "reject" : signatures.some((x) => x.verdict === "edit") ? "edit" : "approve";
  const edits: CheckpointEdits = {};
  for (const x of signatures) {
    if (x.edits?.outcomeValue !== undefined) edits.outcomeValue = x.edits.outcomeValue;
    if (x.edits?.targets) edits.targets = { ...(edits.targets ?? {}), ...x.edits.targets };
    if (x.edits?.record) edits.record = { ...(edits.record ?? {}), ...x.edits.record };
  }
  return {
    verdict,
    note: signatures.filter((x) => x.note.trim()).map((x) => `${x.label}: ${x.note.trim()}`).join("\n"),
    by: signatures.map((x) => x.by).join(", "),
    at: signatures.at(-1)?.at ?? new Date().toISOString(),
    role: config.role,
    excluded,
    edits: Object.keys(edits).length ? edits : null,
    signatures,
  };
}
