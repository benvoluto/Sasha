// Executes a workflow graph for one run on one document. Nodes run as soon as
// everything they depend on has settled; independent nodes run in parallel.
// Each node's status and outputs are saved as they change, so the Workflows tab
// and the canvas can show progress.
//
// - A branch not taken (If/else, Router) leaves its output empty; nodes that
//   need it are skipped.
// - `after` connections only order and gate: the node is skipped unless each
//   delivered a value (a gate's `pass`, a checkpoint's `approved`).
// - A failed node's dependents are skipped, except inputs that accept several
//   connections, which use whatever arrived. The outcome node always runs once
//   everything upstream has settled, and reports a failure as "incomplete".
// - A human checkpoint stops the run (awaiting review) until someone decides.
// - The run pauses itself at the time budget or the invocation's deadline,
//   including mid-loop (finished items are kept); continuing resumes it.

import { typePolicy } from "@/catalog/workflows";
import { getType } from "@/catalog";
import { getDocument, type DocumentRecord } from "@/lib/documents/store";
import { NodeError, type NodeContext, type NodeHandler } from "./context";
import { FUNCTION_LIMIT_MS, MAX_PROGRESS_ITEMS, type StepProgressItem, type WorkflowRunRecord } from "./contract";
import { CORE_HANDLERS, nodeLabels } from "./core-nodes";
import { GENERIC_HANDLERS } from "./generic";
import { STEP_HANDLERS } from "./nodes";
import { OUTPUT_NODE_TYPE } from "./registry";
import { auditRun, saveRun } from "./store";
import { resolveNodes, topologicalOrder, validateGraph, type ResolvedNode } from "./validate";

/** Stop starting new nodes after this long; the function limit is 300 s. */
export const TIME_BUDGET_MS = 200_000;
/** The invocation's deadline sits this far inside the function limit. */
export const DEADLINE_MARGIN_MS = 25_000;

/** Every node implementation by type: the shared steps, the generic workflows' nodes, and the engine's own. */
export const HANDLERS: Record<string, NodeHandler> = { ...STEP_HANDLERS, ...GENERIC_HANDLERS, ...CORE_HANDLERS };

const now = () => new Date().toISOString();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A looping node's finished items, kept in run.outputs[id].__loop across pauses. */
type LoopState = { total: number; results: Array<Record<string, unknown> | null> };

/** The handler stopped mid-loop at the time budget; the step goes back to pending. */
const OUT_OF_TIME = Symbol("out-of-time");

/**
 * Looping: items in flight at once when the spec sets no maxConcurrency. Loop
 * lists can be long (extracted items, passages, sections) and most looping
 * nodes call a model per item, so a loop must not fan out all at once.
 */
export const LOOP_CONCURRENCY = 4;

/**
 * A looping node's item results with their findings renumbered per item
 * ("<nodeId>:<item>.<n>"): every iteration numbers its findings from 1, and
 * the outcome deduplicates findings by id, so without this only the first
 * item's findings would survive. Responses are keyed by these ids.
 */
export function numberLoopFindings(nodeId: string, results: Array<Record<string, unknown> | null>): Array<Record<string, unknown> | null> {
  if (results.length < 2) return results;
  return results.map((res, i) => {
    if (!res || !Array.isArray(res.findings)) return res;
    let n = 0;
    const findings = res.findings.map((f) => (f && typeof f === "object" && typeof (f as { id?: unknown }).id === "string" ? { ...(f as object), id: `${nodeId}:${i + 1}.${++n}` } : f));
    return { ...res, findings };
  });
}

/**
 * A loop item's label and section for the step's progress list: its heading
 * (sections, drafts), else a label, title or name, else "Item n".
 */
export function progressItem(item: unknown, i: number): Pick<StepProgressItem, "label" | "sectionId"> {
  const o = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
  const text = [o.heading, o.label, o.title, o.name].find((v): v is string => typeof v === "string" && !!v.trim());
  const label = (text ?? `Item ${i + 1}`).trim();
  return { label: label.length > 120 ? `${label.slice(0, 119)}…` : label, ...(typeof o.sectionId === "string" && o.sectionId ? { sectionId: o.sectionId } : {}) };
}

/** The context a run's handlers share for one invocation. */
export function nodeContext(run: WorkflowRunRecord, deadline: number): NodeContext {
  const memo = new Map<string, Promise<unknown>>();
  const remember = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!memo.has(key)) memo.set(key, load());
    return memo.get(key) as Promise<T>;
  };
  const document = () =>
    remember<DocumentRecord>("document", async () => {
      const doc = await getDocument(run.team_id, run.document_id);
      if (!doc) throw new NodeError("the document was deleted");
      return doc;
    });
  const type = () => remember("type", async () => (await getType(run.team_id, (await document()).type_key))?.definition ?? null);
  return {
    run,
    teamId: run.team_id,
    documentId: run.document_id,
    agent: run.requested_by,
    deadline,
    memo: remember,
    document,
    type,
    policy: () => remember("policy", async () => typePolicy((await document()).type_key, (await type())?.family)),
  };
}

/** Flatten a multiple json input one more level: a looping node's list output is a list of lists. */
const flattenJson = (values: unknown[]) => values.flatMap((v) => (Array.isArray(v) ? v : [v]));

/**
 * Run the graph until it finishes, waits at a checkpoint, or reaches its time
 * budget (then it pauses with pause_reason "budget" and can be continued).
 * `deadline` (epoch ms) ends the budget earlier.
 */
export async function executeGraph(run: WorkflowRunRecord, opts: { deadline?: number } = {}): Promise<void> {
  const started = Date.now();
  const deadline = Math.min(opts.deadline ?? Infinity, started + FUNCTION_LIMIT_MS - DEADLINE_MARGIN_MS);
  const graph = run.graph;
  const resolved = resolveNodes(graph);
  const errors = validateGraph(graph).filter((i) => i.severity === "error");
  const order = topologicalOrder(graph);
  if (errors.length || !order) {
    run.status = "failed";
    await saveRun(run);
    await auditRun(run, "workflow_run_failed", { documentId: run.document_id, runId: run.id, value: null, error: errors[0]?.message ?? "invalid workflow" });
    return;
  }

  const ctx = nodeContext(run, deadline);
  const labels = nodeLabels(run);
  const incoming = new Map<string, typeof graph.edges>();
  for (const e of graph.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
  const settled = (id: string) => ["done", "failed", "skipped"].includes(run.steps[id]?.status ?? "pending");
  const timeLeft = () => Date.now() - started < TIME_BUDGET_MS && Date.now() < deadline;
  const roomFor = (r: ResolvedNode) => !r.spec.minTimeMs || deadline - Date.now() >= r.spec.minTimeMs;
  const save = () => saveRun(run);
  // A later start of the same workflow on the document superseded this run (saveRun reports it): stop quietly.
  const superseded = () => run.status === "superseded";

  for (const id of order) run.steps[id] ??= { status: "pending" };
  run.status = "running";
  run.pause_reason = null;

  /** Nodes left pending this invocation for lack of time. */
  const deferred = new Set<string>();

  /** Gather a node's inputs; null with a reason when it must be skipped. */
  function gather(id: string, r: ResolvedNode): { inputs: Record<string, unknown>; listInputs: Set<string> } | { skip: string } {
    const inputs: Record<string, unknown> = {};
    const listInputs = new Set<string>();
    const edges = incoming.get(id) ?? [];
    const isOutcome = r.spec.type === OUTPUT_NODE_TYPE;
    const valueOf = (e: (typeof edges)[number]) => (run.steps[e.source].status === "done" ? run.outputs[e.source]?.[e.sourceHandle] : undefined);

    // `after` gates (the outcome only waits on it: it must always run).
    const blockedBy = edges.filter((e) => e.targetHandle === "after" && valueOf(e) === undefined);
    if (blockedBy.length && !isOutcome) return { skip: `not reached: ${labels[blockedBy[0].source] ?? blockedBy[0].source}` };

    let missing: string | null = null;
    let upstreamFailed = false;
    for (const port of r.inputs) {
      if (port.name === "after") continue;
      const values: unknown[] = [];
      for (const e of edges.filter((x) => x.targetHandle === port.name)) {
        if (run.steps[e.source].status === "failed") upstreamFailed = true;
        const v = valueOf(e);
        if (v === undefined) continue;
        const src = resolved.get(e.source);
        // A looping node's outputs are lists too, one item per iteration.
        const isList = !!src?.outputs.find((p) => p.name === e.sourceHandle)?.list || !!(src?.node.loop && src.spec.loopable);
        if (isList) listInputs.add(port.name);
        if (port.multiple && Array.isArray(v) && (isList || port.type === "json")) values.push(...v);
        else values.push(v);
      }
      if (port.multiple) {
        const all = port.type === "json" ? flattenJson(values) : values;
        if (values.length) inputs[port.name] = all;
        else if (!port.optional) missing = port.label;
      } else if (values.length) {
        inputs[port.name] = values[0];
      } else if (!port.optional) {
        missing = port.label;
      }
    }
    if (missing && !isOutcome) return { skip: upstreamFailed ? `“${missing}” failed upstream` : `no “${missing}” (branch not taken)` };
    return { inputs, listInputs };
  }

  /** Run a node, looping over list inputs when loop mode is on (resumably, at most maxConcurrency at once). */
  async function runNode(id: string, r: ResolvedNode, inputs: Record<string, unknown>, listInputs: Set<string>): Promise<Record<string, unknown> | "wait" | typeof OUT_OF_TIME> {
    const handler = HANDLERS[r.spec.type];
    if (!handler) throw new NodeError(`no implementation for ${r.spec.type}`);
    if (!r.node.loop || !r.spec.loopable) return handler(inputs, r, ctx);

    const lists = [...listInputs].filter((k) => Array.isArray(inputs[k]));
    if (!lists.length) return handler(inputs, r, ctx);
    const length = (inputs[lists[0]] as unknown[]).length;
    if (lists.some((k) => (inputs[k] as unknown[]).length !== length)) throw new NodeError("loop mode needs list inputs of the same length");

    const kept = run.outputs[id]?.__loop as LoopState | undefined;
    const state: LoopState = kept && kept.total === length && kept.results.length === length ? kept : { total: length, results: Array(length).fill(null) };
    const todo = state.results.flatMap((res, i) => (res === null ? [i] : []));
    // Per-item states for the first MAX_PROGRESS_ITEMS items (finished ones from an earlier invocation are done).
    const labels = (inputs[lists[0]] as unknown[]).slice(0, MAX_PROGRESS_ITEMS).map(progressItem);
    const itemState = new Map<number, StepProgressItem["state"]>();
    const progress = () => ({
      done: state.results.filter((x) => x !== null).length,
      total: length,
      items: labels.map((l, i): StepProgressItem => ({ ...l, state: state.results[i] !== null ? "done" : (itemState.get(i) ?? "pending") })),
    });
    let outOfTime = false;
    let failure: unknown = null;
    let next = 0;

    const worker = async () => {
      while (next < todo.length && !failure) {
        if (!timeLeft() || !roomFor(r)) {
          outOfTime = true;
          return;
        }
        const i = todo[next++];
        itemState.set(i, "running");
        run.steps[id] = { ...run.steps[id], progress: progress() };
        const res = await handler({ ...inputs, ...Object.fromEntries(lists.map((k) => [k, (inputs[k] as unknown[])[i]])) }, r, ctx).catch((e) => {
          failure ??= e;
          return null;
        });
        if (res === null) {
          itemState.set(i, "failed");
          run.steps[id] = { ...run.steps[id], progress: progress() };
          return;
        }
        if (res === "wait") {
          failure ??= new NodeError("a looping node cannot wait");
          itemState.set(i, "failed");
          run.steps[id] = { ...run.steps[id], progress: progress() };
          return;
        }
        state.results[i] = res;
        run.outputs[id] = { __loop: state };
        run.steps[id] = { ...run.steps[id], progress: progress() };
        await save();
      }
    };
    run.outputs[id] = { __loop: state };
    run.steps[id] = { ...run.steps[id], progress: progress() };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(r.spec.maxConcurrency ?? LOOP_CONCURRENCY, todo.length)) }, worker));
    if (failure) throw failure;
    if (outOfTime && state.results.some((x) => x === null)) return OUT_OF_TIME;

    // Every item is done: one list per output port, in item order.
    const out: Record<string, unknown[]> = Object.fromEntries(r.outputs.map((p) => [p.name, []]));
    for (const res of numberLoopFindings(id, state.results)) for (const [k, v] of Object.entries(res ?? {})) (out[k] ??= []).push(v);
    return out;
  }

  async function step(id: string): Promise<void> {
    const r = resolved.get(id)!;
    const g = gather(id, r);
    if ("skip" in g) {
      run.steps[id] = { status: "skipped", finishedAt: now(), note: g.skip };
      return;
    }
    if (!roomFor(r)) {
      deferred.add(id);
      return;
    }
    run.steps[id] = { ...run.steps[id], status: "running", startedAt: run.steps[id].startedAt ?? now(), error: undefined };
    await save();
    try {
      const out = await runNode(id, r, g.inputs, g.listInputs);
      if (out === OUT_OF_TIME) {
        run.steps[id] = { ...run.steps[id], status: "pending", note: "paused: out of time" };
        deferred.add(id);
      } else if (out === "wait") {
        run.outputs[id] = { pending_items: g.inputs.items ?? [] };
        run.steps[id] = { ...run.steps[id], status: "waiting", note: "waiting for review" };
      } else {
        run.outputs[id] = out;
        run.steps[id] = { ...run.steps[id], status: "done", finishedAt: now(), note: noteFor(r, out) };
      }
    } catch (e) {
      if (e instanceof NodeError && e.raw) run.raw[id] = e.raw;
      run.steps[id] = { ...run.steps[id], status: "failed", finishedAt: now(), error: message(e) };
    }
    await save();
  }

  while (true) {
    if (superseded()) return;
    const ready = order.filter((id) => run.steps[id].status === "pending" && !deferred.has(id) && (incoming.get(id) ?? []).every((e) => settled(e.source)));
    if (!ready.length) break;
    if (!timeLeft()) {
      ready.forEach((id) => deferred.add(id));
      break;
    }
    await Promise.all(ready.map(step));
  }
  if (superseded()) return;

  const waiting = order.some((id) => run.steps[id].status === "waiting");
  const output = order.find((id) => resolved.get(id)?.spec.type === OUTPUT_NODE_TYPE);
  if (deferred.size) {
    run.status = "paused";
    run.pause_reason = "budget";
  } else {
    run.status = waiting ? "awaiting_review" : output && run.steps[output].status === "done" ? "complete" : "failed";
  }
  await save();
  if (superseded()) return;
  const action = { paused: "workflow_run_paused", awaiting_review: "workflow_run_awaiting_review", complete: "workflow_run_complete" }[run.status as string] ?? "workflow_run_failed";
  await auditRun(run, action, { documentId: run.document_id, runId: run.id, value: run.outcome?.value ?? null });
}

/**
 * Prepare a failed run to be continued: its failed steps and everything
 * downstream of them go back to pending (a looping step keeps its finished
 * items), and decisions at checkpoints downstream are cleared.
 */
export function resetFailedSteps(run: WorkflowRunRecord): void {
  const next = new Map<string, string[]>();
  for (const e of run.graph.edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const stack = Object.entries(run.steps).filter(([, s]) => s.status === "failed").map(([id]) => id);
  const reset = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (reset.has(id)) continue;
    reset.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  for (const id of reset) {
    const loop = run.outputs[id]?.__loop;
    run.steps[id] = { status: "pending", ...(run.steps[id]?.progress ? { progress: run.steps[id].progress } : {}) };
    if (loop) run.outputs[id] = { __loop: loop };
    else delete run.outputs[id];
    delete run.checkpoints[id];
    delete run.raw[id];
  }
  if ([...reset].some((id) => run.graph.nodes.find((n) => n.id === id)?.type === OUTPUT_NODE_TYPE)) run.outcome = null;
}

function noteFor(r: ResolvedNode, out: Record<string, unknown>): string | undefined {
  if (r.spec.type === "ai.categorize" && typeof out.category === "string") return out.category;
  if (r.spec.type === OUTPUT_NODE_TYPE) return (out.outcome as { valueLabel?: string } | undefined)?.valueLabel;
  if (r.node.loop) return `${Object.values(out)[0] instanceof Array ? (Object.values(out)[0] as unknown[]).length : 0} items`;
  return undefined;
}
