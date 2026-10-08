// Client-side shapes for the workflow canvas. Types only: the server modules
// they come from are never bundled into the client. Runs are the contract's
// WorkflowRunView (src/lib/workflow/contract.ts), as the run routes return them.

import type { RunResponse, StepState, StepStatus, WorkflowRunView } from "@/lib/workflow/contract";
import type { SavedWorkflow, VersionInfo, WorkflowInfo } from "@/lib/workflow/store";
import type { WorkflowGraph } from "@/lib/workflow/types";

export type { RunResponse, SavedWorkflow, StepState, StepStatus, VersionInfo, WorkflowGraph, WorkflowInfo, WorkflowRunView };

/** GET /api/workflow-runs: one version of a workflow (built-ins read-only), plus what the editor needs alongside it. */
export type WorkflowResponse = SavedWorkflow & {
  /** The team's workflows and the built-ins. */
  workflows: WorkflowInfo[];
  /** The built-in workflows, for "Copy to edit" and the picker's group. */
  builtIns?: Array<{ id: string; title: string }>;
  /** This workflow's saved versions, newest first (none for a built-in). */
  versions: VersionInfo[];
  defaultWorkflowId: string | null;
  defaults: WorkflowGraph;
  canEdit: boolean;
  canRun: boolean;
  providers: { anthropic: { configured: boolean; defaultModel: string }; gateway: { configured: boolean } };
  persisted: boolean;
};

/** A document a run can read (GET /api/documents). */
export type DocumentOption = { id: string; title: string; type_key: string | null; updated_at: string };
