// Executes a workflow graph for one run. Nodes run as soon as everything they
// depend on has settled; independent nodes run in parallel. Each node's status
// and outputs are saved as they change, so the canvas can show progress.
//
// - A branch not taken (If/else, Router) leaves its output empty; nodes that
//   need it are skipped.
// - A failed node's dependents are skipped, except inputs that accept several
//   connections, which use whatever arrived.
// - A human checkpoint pauses the run until someone continues it.
// - The run pauses itself before the function time limit; continuing resumes it.

import { z } from "zod";
import type { ModelChoice } from "@/lib/llm/model-choice";
import { fetchGroupMetadata } from "@/lib/ontology/group-metadata";
import { toPassages, type SourceDocument } from "@/lib/sources/passages";
import { splitDocuments } from "@/lib/sources/split";
import { callForJson, callForText, coerceJson } from "./model-json";
import { CHECKPOINT_NODE_TYPE, OUTPUT_NODE_TYPE } from "./registry";
import { auditRun, saveRun, type StepState, type WorkflowRun } from "./store";
import { renderTemplate, asText } from "./template";
import { resolveNodes, topologicalOrder, validateGraph, type ResolvedNode } from "./validate";

/** Stop starting new nodes after this long; the function limit is 300 s. */
export const TIME_BUDGET_MS = 200_000;

type Ctx = { run: WorkflowRun; sources: () => Promise<SourceDocument[]> };
type Handler = (inputs: Record<string, unknown>, r: ResolvedNode, ctx: Ctx) => Promise<Record<string, unknown> | "wait">;

const now = () => new Date().toISOString();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class NodeError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
  }
}

/** The run subject's source documents: for now, the upload group's extracted text, split per document. */
export async function loadSourceDocuments(groupId: string): Promise<SourceDocument[]> {
  const meta = await fetchGroupMetadata(groupId);
  if (!meta) throw new NodeError("the uploaded sources were not found");
  const extracted = meta.geminiProcessing?.extractedContent ?? "";
  if (!extracted.trim()) throw new NodeError("the uploaded sources have no extracted text yet");
  return splitDocuments(groupId, extracted);
}

// --- Node implementations ------------------------------------------------------

const asModel = (c: Record<string, unknown>) => c as unknown as ModelChoice;

export const HANDLERS: Record<string, Handler> = {
  "source.documents": async (_i, r, ctx) => {
    const filter = String(r.config.nameContains ?? "").toLowerCase().trim();
    const docs = (await ctx.sources()).filter((d) => !filter || d.doc_type.toLowerCase().includes(filter));
    // Passage ids are numbered over the filtered set, so citations match what the model saw.
    const passages = toPassages(docs);
    const texts = docs.map((d) => passages.filter((p) => p.doc_id === d.doc_id).map((p) => `[${p.passage_id}] ${p.text}`).join("\n"));
    return {
      documents: texts,
      names: docs.map((d) => d.doc_type),
      combined: docs.map((d, i) => `=== ${d.doc_type} ===\n${texts[i]}`).join("\n\n"),
    };
  },

  [CHECKPOINT_NODE_TYPE]: async (inputs, r, ctx) => {
    const decision = ctx.run.checkpoints[r.node.id];
    if (!decision) return "wait";
    const items = ((inputs.items as unknown[]) ?? []).filter((_, i) => !decision.excluded.includes(i));
    return { items, note: decision.note };
  },

  [OUTPUT_NODE_TYPE]: async (inputs) => {
    const parts = ((inputs.text as unknown[]) ?? []).map(asText).filter((t) => t.trim());
    return { result: parts.join("\n\n") };
  },

  "ai.ask": async (inputs, r) => {
    const prompt = renderTemplate(String(r.config.prompt), inputs);
    return { response: await callForText(asModel(r.config), "You are a careful research and writing assistant. Answer only from the material provided.", prompt, r.node.label || "Ask AI") };
  },

  "ai.extract": async (inputs, r) => {
    const fields = r.config.fields as Array<{ name: string; description: string; list: boolean }>;
    const shape = Object.fromEntries(fields.map((f) => [f.name, f.list ? z.array(z.string()) : z.string()]));
    const schema = z.object(shape);
    const system = [
      "Extract information from the text. Return ONLY a JSON object with exactly these keys:",
      ...fields.map((f) => `- "${f.name}" (${f.list ? "array of strings" : "string"}): ${f.description}`),
      'Use "" or [] when the text does not contain it.',
      r.config.context ? `Context: ${r.config.context}` : "",
    ].join("\n");
    const out = await callForJson(asModel(r.config), system, asText(inputs.text), (t) => {
      try {
        const p = schema.safeParse(coerceJson(t));
        return p.success ? { ok: true as const, value: p.data } : { ok: false as const, error: z.prettifyError(p.error) };
      } catch (e) {
        return { ok: false as const, error: message(e) };
      }
    }, r.node.label || "Extract data");
    if (!out.value) throw new NodeError(out.error ?? "invalid reply", out.text);
    return out.value;
  },

  "ai.categorize": async (inputs, r) => {
    const categories = r.config.categories as Array<{ name: string; description: string }>;
    const system = [
      "Choose the ONE category that best fits the text. Return ONLY JSON: {\"category\": <exact category name>, \"justification\": <one sentence>}.",
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

// --- Execution -------------------------------------------------------------------

/** Run a node, looping over list inputs when loop mode is on. */
async function runNode(r: ResolvedNode, inputs: Record<string, unknown>, ctx: Ctx, listInputs: Set<string>): Promise<Record<string, unknown> | "wait"> {
  const handler = HANDLERS[r.spec.type];
  if (!handler) throw new NodeError(`no implementation for ${r.spec.type}`);
  if (!r.node.loop || !r.spec.loopable) return handler(inputs, r, ctx);

  const lists = [...listInputs].filter((k) => Array.isArray(inputs[k]));
  if (!lists.length) return handler(inputs, r, ctx);
  const length = (inputs[lists[0]] as unknown[]).length;
  if (lists.some((k) => (inputs[k] as unknown[]).length !== length)) throw new NodeError("loop mode needs list inputs of the same length");
  const results = await Promise.all(
    Array.from({ length }, (_, i) => handler({ ...inputs, ...Object.fromEntries(lists.map((k) => [k, (inputs[k] as unknown[])[i]])) }, r, ctx)),
  );
  const out: Record<string, unknown[]> = {};
  for (const res of results) {
    if (res === "wait") throw new NodeError("a looping node cannot wait");
    for (const [k, v] of Object.entries(res)) (out[k] ??= []).push(v);
  }
  return out;
}

/**
 * Run the graph until it finishes, waits at a checkpoint, or reaches its time
 * budget (then it pauses and can be continued). `deadline` (epoch ms) ends the
 * budget earlier: a caller that has already used part of its function's time,
 * like the upload route after extraction, passes when it must stop starting nodes.
 */
export async function executeGraph(run: WorkflowRun, opts: { deadline?: number } = {}): Promise<void> {
  const started = Date.now();
  const graph = run.workflow;
  const resolved = resolveNodes(graph);
  const errors = validateGraph(graph).filter((i) => i.severity === "error");
  const order = topologicalOrder(graph);
  if (errors.length || !order) {
    run.status = "failed";
    await saveRun(run, run.outputs);
    await auditRun(run, "workflow_run_failed", { error: errors[0]?.message ?? "invalid workflow" });
    return;
  }

  let sourcesPromise: Promise<SourceDocument[]> | null = null;
  const ctx: Ctx = { run, sources: () => (sourcesPromise ??= loadSourceDocuments(run.group_id)) };

  const incoming = new Map<string, typeof graph.edges>();
  for (const e of graph.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
  const settled = (id: string) => ["done", "failed", "skipped"].includes(run.steps[id]?.status ?? "pending");
  const save = () => saveRun(run, run.outputs);

  for (const id of order) run.steps[id] ??= { status: "pending" };

  while (true) {
    const ready = order.filter((id) => run.steps[id].status === "pending" && (incoming.get(id) ?? []).every((e) => settled(e.source)));
    if (!ready.length) break;
    if (Date.now() - started > TIME_BUDGET_MS || (opts.deadline !== undefined && Date.now() > opts.deadline)) {
      run.status = "paused";
      await save();
      return;
    }

    await Promise.all(
      ready.map(async (id) => {
        const r = resolved.get(id)!;
        const inputs: Record<string, unknown> = {};
        const listInputs = new Set<string>();
        let missing: string | null = null;
        let upstreamFailed = false;
        for (const port of r.inputs) {
          const edges = (incoming.get(id) ?? []).filter((e) => e.targetHandle === port.name);
          const values: unknown[] = [];
          for (const e of edges) {
            const state = run.steps[e.source].status;
            if (state === "failed") upstreamFailed = true;
            const v = state === "done" ? run.outputs[e.source]?.[e.sourceHandle] : undefined;
            if (v === undefined) continue;
            const src = resolved.get(e.source);
            // A looping node's outputs are lists too, one item per iteration.
            const isList = !!src?.outputs.find((p) => p.name === e.sourceHandle)?.list || !!(src?.node.loop && src.spec.loopable);
            if (isList) listInputs.add(port.name);
            if (port.multiple && Array.isArray(v) && isList) values.push(...v);
            else values.push(v);
          }
          if (port.multiple) {
            if (values.length) inputs[port.name] = values;
            else if (!port.optional) missing = port.label;
          } else if (values.length) {
            inputs[port.name] = values[0];
          } else if (!port.optional) {
            missing = port.label;
          }
        }
        if (missing) {
          run.steps[id] = { status: "skipped", finishedAt: now(), note: upstreamFailed ? `“${missing}” failed upstream` : `no “${missing}” (branch not taken)` };
          return;
        }

        run.steps[id] = { status: "running", startedAt: now() };
        await save();
        try {
          const out = await runNode(r, inputs, ctx, listInputs);
          if (out === "wait") {
            run.outputs[id] = { pending_items: inputs.items ?? [] };
            run.steps[id] = { ...run.steps[id], status: "waiting", note: "waiting for review" };
          } else {
            run.outputs[id] = out;
            run.steps[id] = { ...run.steps[id], status: "done", finishedAt: now(), note: noteFor(r, out) };
          }
        } catch (e) {
          if (e instanceof NodeError && e.raw) run.raw[id] = e.raw;
          run.steps[id] = { ...run.steps[id], status: "failed", finishedAt: now(), error: message(e) } as StepState;
        }
        await save();
      }),
    );
  }

  const waiting = order.filter((id) => run.steps[id].status === "waiting");
  const output = order.find((id) => resolved.get(id)?.spec.type === OUTPUT_NODE_TYPE);
  run.status = waiting.length ? "awaiting_review" : output && run.steps[output].status === "done" ? "draft" : "failed";
  await save();
  await auditRun(run, run.status === "draft" ? "workflow_run_finished" : run.status === "awaiting_review" ? "workflow_run_awaiting_review" : "workflow_run_failed", {
    nodes: Object.fromEntries(order.map((id) => [id, run.steps[id].status])),
  });
}

function noteFor(r: ResolvedNode, out: Record<string, unknown>): string | undefined {
  if (r.spec.type === "ai.categorize" && typeof out.category === "string") return out.category;
  if (r.node.loop) return `${Object.values(out)[0] instanceof Array ? (Object.values(out)[0] as unknown[]).length : 0} items`;
  return undefined;
}
