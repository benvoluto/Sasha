'use client';

import { createContext, useContext } from 'react';
import type { GraphNode } from '@/lib/workflow/types';
import type { Issue } from '@/lib/workflow/validate';
import type { WorkflowRun, WorkflowResponse } from './types';

export type CanvasContextValue = {
  info: WorkflowResponse;
  run: WorkflowRun | null;
  readOnly: boolean;
  issuesByNode: Map<string, Issue[]>;
  updateNode: (id: string, patch: Partial<GraphNode>) => void;
  removeNode: (id: string) => void;
  /** Ids of nodes the canvas currently holds, for naming new ones. */
};

export const CanvasContext = createContext<CanvasContextValue | null>(null);

export function useCanvas(): CanvasContextValue {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error('useCanvas outside CanvasContext');
  return ctx;
}
