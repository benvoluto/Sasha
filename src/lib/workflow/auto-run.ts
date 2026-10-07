// Run the workflow chosen at upload once the uploaded source documents have been
// read. It runs in the upload's own background work, after extraction, so it gets
// only the function time extraction left: it stops starting steps at the
// deadline and pauses, and the upload's card links to the paused run to continue it.

import { createRun, getWorkflow, RUN_PERMISSION } from "./store";
import { can } from "@/lib/ontology/governance";
import { authFromClerk } from "@/lib/ontology/permissions";
import { executeGraph } from "./engine";

/** What the uploader chose, stored on the upload metadata as `autoWorkflow`. Null workflowId: run none. */
export type AutoWorkflowChoice = { workflowId: string | null; requestedBy: string };

/** Leave this long before the function limit: a step started just before the deadline still has to finish. */
const STEP_MARGIN_MS = 90_000;

/** `functionStart` and `maxDurationS` describe the invocation doing the work, so the run can pause in time. */
export async function runChosenWorkflow(groupId: string, choice: AutoWorkflowChoice | null | undefined, functionStart: number, maxDurationS: number): Promise<void> {
  if (!choice?.workflowId) return;
  try {
    const workflow = await getWorkflow(choice.workflowId);
    if (!workflow) {
      console.warn(`[AutoWorkflow] ${groupId}: workflow ${choice.workflowId} no longer exists; not running one`);
      return;
    }
    const run = await createRun(groupId, workflow, { agent: choice.requestedBy, permissions: [] });
    console.log(`[AutoWorkflow] ${groupId}: running ${workflow.name} v${workflow.version} (run ${run.id})`);
    await executeGraph(run, { deadline: functionStart + maxDurationS * 1000 - STEP_MARGIN_MS });
  } catch (error) {
    // The upload itself is processed either way; the workflow can be run from the editor.
    console.error(`[AutoWorkflow] ${groupId}: could not run the chosen workflow:`, error);
  }
}

/**
 * The upload's choice, checked: a workflow that exists, picked by someone
 * allowed to run workflows. "none", nothing, or a failed check: run none.
 */
export async function workflowChoiceFor(requested: unknown): Promise<AutoWorkflowChoice | null> {
  if (typeof requested !== "string" || !requested || requested === "none") return null;
  const caller = await authFromClerk();
  if (!caller || !can(caller, RUN_PERMISSION)) return null;
  if (!(await getWorkflow(requested))) return null;
  return { workflowId: requested, requestedBy: caller.agent };
}
