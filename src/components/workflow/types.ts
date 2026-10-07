// Client-side shapes for the workflow canvas. Types only: the server modules
// they come from are never bundled into the client.

import type { SavedWorkflow, StepState, StepStatus, VersionInfo, WorkflowInfo, WorkflowRun } from "@/lib/workflow/store";
import type { WorkflowGraph } from "@/lib/workflow/types";

export type { StepState, StepStatus, WorkflowGraph, WorkflowRun };

export type WorkflowResponse = SavedWorkflow & {
  workflows: WorkflowInfo[];
  /** This workflow's saved versions, newest first. */
  versions: VersionInfo[];
  defaultWorkflowId: string;
  defaults: WorkflowGraph;
  canEdit: boolean;
  canRun: boolean;
  providers: { anthropic: { configured: boolean; defaultModel: string }; gateway: { configured: boolean } };
  persisted: boolean;
};

/** An upload group whose source documents a run can read. */
export type SourceOption = { id: string; label: string; ready: boolean; failed?: boolean };
