'use client';

// The workflow editor: a canvas of nodes wired output → input, a node library,
// problems found by validation, versioned saving, and runs on a document with
// live status on every node. Built-in workflows open read-only, with "Copy to
// edit" to make a team copy.

import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ConnectionLineType,
  type Connection,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { canvasSelection } from '@/components/editor/workflows-pane-model';
import { AlertTriangle, BarChart3, ClipboardList, Copy, Loader2, Play, Plus, RefreshCw, Save, Workflow } from '@/components/icons';
import type { RunBrief } from '@/lib/workflow/contract';
import { CATEGORIES, NODE_SPECS, NODE_SPEC_INDEX } from '@/lib/workflow/registry';
import { portsCompatible, type GraphNode, type WorkflowGraph } from '@/lib/workflow/types';
import { formatDuration, runDuration, runOutcome } from '@/lib/workflow/run-stats';
import { createsCycle, resolveNodes, validateGraph, type Issue } from '@/lib/workflow/validate';
import { CanvasContext } from './canvas-context';
import { CATEGORY_STYLE, NodeCard, toneFor, type CardNode } from './node-card';
import { EMPTY_FILTER, RunLog, RunsOverview, useRunHistory, type LogFilter } from './run-history';
import { RoutedEdge, RoutesProvider, useEdgeRoutes } from './routed-edge';
import { RunInspector } from './run-inspector';
import type { CheckpointSubmit } from './checkpoint-panel';
import { WorkflowPicker } from './workflow-picker';
import { OutcomeBadge, summaryOf } from './run-parts';
import type { DocumentOption, RunResponse, WorkflowResponse, WorkflowRunView } from './types';

const POLL_MS = 2500;
/** A run waiting for a person changes slowly. */
const REVIEW_POLL_MS = 10_000;
const nodeTypes = { card: NodeCard };
const edgeTypes = { routed: RoutedEdge };

const toCards = (g: WorkflowGraph): CardNode[] => g.nodes.map((n) => ({ id: n.id, type: 'card', position: n.position, data: { node: n } }));
const toEdges = (g: WorkflowGraph): Edge[] => g.edges.map((e) => ({ ...e, type: 'routed' }));
const toGraph = (nodes: CardNode[], edges: Edge[]): WorkflowGraph => ({
  format: 'graph-v1',
  nodes: nodes.map((n) => ({ ...n.data.node, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? '', target: e.target, targetHandle: e.targetHandle ?? '' })),
});

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

function Library({ onAdd, onClose }: { onAdd: (type: string) => void; onClose: () => void }) {
  return (
    <div className="absolute left-3 top-14 z-20 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Add a node</h2>
        <button className="text-xs text-zinc-500 dark:text-zinc-400 hover:underline" onClick={onClose}>
          Close
        </button>
      </div>
      {CATEGORIES.map((cat) => (
        <div key={cat} className="mb-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <span className={`h-2 w-2 rounded-full ${CATEGORY_STYLE[cat].chip}`} />
            {cat}
          </div>
          <div className="space-y-1">
            {NODE_SPECS.filter((s) => s.category === cat).map((s) => (
              <button key={s.type} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => onAdd(s.type)}>
                <div className="text-sm font-medium">{s.label}</div>
                <div className="line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{s.description}</div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Editor({
  info,
  reload,
  refresh,
  open,
}: {
  info: WorkflowResponse;
  /** After a save: show the newest version. */
  reload: () => Promise<void>;
  /** After a rename or a new default: the same version, refetched. */
  refresh: () => Promise<void>;
  open: (workflowId: string, version?: number) => void;
}) {
  const { resolvedTheme } = useTheme();
  const flow = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(toCards(info.graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toEdges(info.graph));
  const [saved, setSaved] = useState(() => JSON.stringify(info.graph));
  const [selected, setSelected] = useState<string | null>(null);
  const [library, setLibrary] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [note, setNote] = useState('');
  const [documents, setDocuments] = useState<DocumentOption[] | null>(null);
  // A link to a document's runs opens it here: /workflows?document=<id>.
  const [documentId, setDocumentIdState] = useState(() => (typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('document') ?? '')));
  const setDocumentId = useCallback((id: string) => {
    setDocumentIdState(id);
    // Keep the URL on the document shown, so it can be shared or reloaded.
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('document', id);
    else url.searchParams.delete('document');
    window.history.replaceState(null, '', url);
  }, []);
  /** Opening another workflow while this one has unsaved changes: confirmed in a dialog first. */
  const [pendingOpen, setPendingOpen] = useState<{ workflowId: string; version?: number } | null>(null);
  const [run, setRun] = useState<WorkflowRunView | null>(null);
  const [busy, setBusy] = useState<'save' | 'run' | 'copy' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const dirty = JSON.stringify(graph) !== saved;
  const issues = useMemo(() => validateGraph(graph), [graph]);
  const errorsCount = issues.filter((i) => i.severity === 'error').length;
  const issuesByNode = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of issues) if (i.nodeId) m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i]);
    return m;
  }, [issues]);
  // Built-ins are never saved over: copy one to change it.
  const readOnly = !info.canEdit || info.readOnly;

  const updateNode = useCallback(
    (id: string, patch: Partial<GraphNode>) =>
      setNodes((ns) => {
        const next = ns.map((n) => (n.id === id ? { ...n, data: { node: { ...n.data.node, ...patch } } } : n));
        // Ports can change with settings (renamed inputs, removed fields), so drop
        // connections whose ports no longer exist.
        if (patch.config) {
          const r = resolveNodes(toGraph(next, [])).get(id);
          if (r) setEdges((es) => es.filter((e) => (e.source !== id || r.outputs.some((p) => p.name === e.sourceHandle)) && (e.target !== id || r.inputs.some((p) => p.name === e.targetHandle))));
        }
        return next;
      }),
    [setNodes, setEdges],
  );
  const removeNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      setSelected((s) => (s === id ? null : s));
    },
    [setNodes, setEdges],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const s = resolveNodes(graph).get(c.source);
      const t = resolveNodes(graph).get(c.target);
      const out = s?.outputs.find((p) => p.name === c.sourceHandle);
      const inp = t?.inputs.find((p) => p.name === c.targetHandle);
      if (!out || !inp || !portsCompatible(out.type, inp.type)) return false;
      if (!inp.multiple && graph.edges.some((e) => e.target === c.target && e.targetHandle === c.targetHandle)) return false;
      return !createsCycle(graph, c.source, c.target);
    },
    [graph],
  );

  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge({ ...c, id: `${c.source}.${c.sourceHandle}->${c.target}.${c.targetHandle}`, type: 'routed' }, es)),
    [setEdges],
  );

  const addNode = (type: string) => {
    const spec = NODE_SPEC_INDEX[type];
    const base = type.split('.')[1];
    let i = 1;
    while (nodes.some((n) => n.id === `${base}-${i}`)) i++;
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const node: GraphNode = { id: `${base}-${i}`, type, position: { x: center.x - 150, y: center.y - 60 }, config: spec.defaults(), loop: false, expanded: true };
    setNodes((ns) => [...ns, { id: node.id, type: 'card', position: node.position, data: { node }, selected: true }]);
    setSelected(node.id);
    setLibrary(false);
  };

  // The team's documents for the run picker.
  useEffect(() => {
    fetch('/api/documents', { cache: 'no-store' })
      .then((r) => readJson<{ documents: DocumentOption[] }>(r))
      .then(({ documents: list }) => setDocuments(list))
      .catch(() => setDocuments([]));
  }, []);
  // A linked document that isn't in the list (archived, say) still needs an option, or the picker would show none.
  const documentOptions = useMemo(
    () => (documentId && documents && !documents.some((d) => d.id === documentId) ? [...documents, { id: documentId, title: `Document ${documentId.slice(0, 8)}`, type_key: null, updated_at: '' }] : (documents ?? [])),
    [documents, documentId],
  );

  // The one run the canvas follows. A poll whose fetch resolves after the canvas
  // moved on (another document, another run, unmount) is dropped and stops its
  // chain, so two chains never share the timer and an old run never comes back.
  const followed = useRef<string | null>(null);
  const stopFollowing = useCallback(() => {
    followed.current = null;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const poll = useCallback(async (runId: string) => {
    if (followed.current !== runId) return;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    try {
      const { run: fresh } = await readJson<RunResponse>(await fetch(`/api/workflow-runs/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' }));
      if (followed.current !== runId) return;
      setRun(fresh);
      const delay = fresh.status === 'running' ? POLL_MS : fresh.status === 'awaiting_review' ? REVIEW_POLL_MS : null;
      if (delay !== null) pollTimer.current = setTimeout(() => poll(runId), delay);
    } catch (e) {
      if (followed.current === runId) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** Follow `runId` from now on (dropping any other run's chain), polling it now or after `delay`. */
  const follow = useCallback(
    (runId: string, delay: number | null) => {
      stopFollowing();
      followed.current = runId;
      if (delay === null) void poll(runId);
      else pollTimer.current = setTimeout(() => poll(runId), delay);
    },
    [poll, stopFollowing],
  );

  // The document the canvas is on, for requests that resolve after it changed.
  const currentDocument = useRef(documentId);
  currentDocument.current = documentId;

  // The chosen document's latest run of this workflow (another workflow's run wouldn't match the canvas).
  useEffect(() => {
    stopFollowing();
    setRun(null);
    if (!documentId) return;
    let cancelled = false;
    fetch(`/api/workflow-runs/runs/history?documentId=${encodeURIComponent(documentId)}`, { cache: 'no-store' })
      .then((r) => readJson<{ runs: RunBrief[] }>(r))
      .then(({ runs }) => {
        const latest = runs.find((r) => r.workflow_id === info.workflow_id);
        if (!cancelled && latest) follow(latest.id, null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stopFollowing();
    };
  }, [documentId, info.workflow_id, follow, stopFollowing]);

  const act = async (kind: 'save' | 'run' | 'copy', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    act('save', async () => {
      await readJson(await fetch('/api/workflow-runs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: info.workflow_id, graph, note }) }));
      setSaved(JSON.stringify(graph));
      setNote('');
      await reload();
    });

  const start = () =>
    act('run', async () => {
      const on = documentId;
      const { run: started } = await readJson<RunResponse>(
        await fetch('/api/workflow-runs/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId, workflowId: info.workflow_id, version: info.version }) }),
      );
      if (currentDocument.current !== on) return;
      setRun(started);
      setSelected(null);
      follow(started.id, POLL_MS);
    });

  /** Continue a paused run, or record a checkpoint decision. Resolves to an error message, or null. */
  const continueRun = async (checkpoint?: CheckpointSubmit): Promise<string | null> => {
    if (!run) return null;
    const on = documentId;
    try {
      const { run: next } = await readJson<RunResponse>(
        await fetch(`/api/workflow-runs/runs/${encodeURIComponent(run.id)}/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checkpoint ? { checkpoint } : {}) }),
      );
      if (currentDocument.current !== on) return null;
      setRun(next);
      follow(next.id, POLL_MS);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  /** "Copy to edit": a team copy of this built-in (or workflow), opened in its place. */
  const copyToEdit = () =>
    act('copy', async () => {
      const { workflow } = await readJson<{ workflow: { id: string } }>(
        await fetch('/api/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${info.name} (copy)`.slice(0, 80), basedOn: info.workflow_id }) }),
      );
      open(workflow.id);
    });

  const selectedNode = graph.nodes.find((n) => n.id === selected) ?? null;
  const running = run?.status === 'running';
  const routes = useEdgeRoutes(edges);
  // The selected node's connections are drawn in the accent colour and on top, so its paths can be followed.
  const shownEdges = useMemo(
    () =>
      edges.map((e) => {
        const highlight = !!selected && (e.source === selected || e.target === selected);
        return { ...e, animated: running, zIndex: highlight ? 1 : 0, data: { ...e.data, highlight } };
      }),
    [edges, selected, running],
  );
  const ctx = useMemo(() => ({ info, run, readOnly, issuesByNode, updateNode, removeNode }), [info, run, readOnly, issuesByNode, updateNode, removeNode]);

  return (
    <CanvasContext.Provider value={ctx}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <WorkflowPicker
              info={info}
              onOpen={(workflowId, version) => {
                if (dirty) setPendingOpen({ workflowId, version });
                else open(workflowId, version);
              }}
              onChanged={refresh}
              onError={setError}
            />
            {dirty || !info.persisted ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {dirty ? 'Unsaved changes' : ''}
                {dirty && !info.persisted ? ' · ' : ''}
                {!info.persisted ? 'No database: changes and runs last until the server restarts' : ''}
              </p>
            ) : null}
          </div>
          {info.readOnly && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Built-in workflow: read only.</span>
              {info.canEdit && (
                <Button size="sm" onClick={copyToEdit} disabled={busy === 'copy'}>
                  {busy === 'copy' ? <Loader2 className="animate-spin" /> : <Copy />} Copy to edit
                </Button>
              )}
            </div>
          )}
          {info.canEdit && !info.readOnly && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setNodes(toCards(info.defaults));
                  setEdges(toEdges(info.defaults));
                }}
              >
                <RefreshCw /> Reset to default
              </Button>
              {dirty && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const g = JSON.parse(saved) as WorkflowGraph;
                    setNodes(toCards(g));
                    setEdges(toEdges(g));
                  }}
                >
                  Discard changes
                </Button>
              )}
              <Input className="h-8 w-52" placeholder="What changed? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button size="sm" onClick={save} disabled={!dirty || errorsCount > 0 || busy === 'save'} title={errorsCount ? 'Fix the problems first' : undefined}>
                {busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />} Save version
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
          <label className="flex min-w-0 items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            Run on document
            <select className="h-8 min-w-[200px] max-w-full rounded-md border bg-transparent px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:text-zinc-100" value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
              <option value="">{documents === null ? 'Loading documents…' : documents.length ? 'Choose a document…' : 'No documents yet'}</option>
              {documentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title.trim() || 'Untitled document'}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" onClick={start} disabled={!info.canRun || !documentId || dirty || running || busy === 'run'} title={dirty ? 'Save your changes first; runs use the saved version' : undefined}>
            {busy === 'run' || running ? <Loader2 className="animate-spin" /> : <Play />} {running ? 'Running…' : 'Run'}
          </Button>
          {run && (
            <button className="flex items-center gap-2 text-sm text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-400" onClick={() => setSelected(null)} title="Show the run result and log">
              Last run <OutcomeBadge outcome={runOutcome(summaryOf(run))} /> {new Date(run.created_at).toLocaleString()}
              {runDuration(run) !== null ? ` · ${formatDuration(runDuration(run))}` : ''}
            </button>
          )}
          <button
            className={`ml-auto flex items-center gap-1 text-sm ${errorsCount ? 'text-red-600 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400'}`}
            onClick={() => setShowIssues((v) => !v)}
          >
            <AlertTriangle className="h-4 w-4" /> {errorsCount} problem{errorsCount === 1 ? '' : 's'}
            {issues.length - errorsCount ? `, ${issues.length - errorsCount} warning${issues.length - errorsCount === 1 ? '' : 's'}` : ''}
          </button>
        </div>
        {showIssues && issues.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            {issues.map((i, k) => (
              <li key={k} className={i.severity === 'error' ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}>
                {i.nodeId ? (
                  <button className="hover:underline" onClick={() => setSelected(i.nodeId!)}>
                    {i.message}
                  </button>
                ) : (
                  i.message
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

        <div className={`grid gap-3 ${run ? 'lg:grid-cols-[minmax(0,1fr)_400px]' : ''}`}>
          <div className="relative h-[70vh] min-h-[480px] rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
            {!readOnly && (
              <Button size="sm" className="absolute left-3 top-3 z-10 rounded-full bg-pink-600 text-white hover:bg-pink-700" onClick={() => setLibrary((v) => !v)}>
                <Plus /> Add node
              </Button>
            )}
            {library && <Library onAdd={addNode} onClose={() => setLibrary(false)} />}
            <RoutesProvider value={routes}>
            <ReactFlow
              nodes={nodes}
              edges={shownEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              connectionLineType={ConnectionLineType.SmoothStep}
              onNodesChange={readOnly ? undefined : onNodesChange}
              onEdgesChange={readOnly ? undefined : onEdgesChange}
              onConnect={readOnly ? undefined : onConnect}
              isValidConnection={isValidConnection}
              onNodeClick={(_, n) => setSelected(n.id)}
              onPaneClick={() => setSelected(null)}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
              fitView
              fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
              minZoom={0.15}
              colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(n) => toneFor((n as CardNode).data.node.type).hex} nodeBorderRadius={6} className="!hidden md:!block" />
            </ReactFlow>
            </RoutesProvider>
          </div>
          {run && (
            <aside className="max-h-[70vh] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <RunInspector run={run} node={selectedNode} canRun={info.canRun} onContinue={continueRun} onSelectNode={setSelected} />
            </aside>
          )}
        </div>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Drag from an output (bottom of a node) to an input (top) to connect; the small “after” handle on a node&apos;s top-left only orders it after another step. Select a node or connection and press Delete to remove it.
        </p>
      </div>
      <AlertDialog open={pendingOpen !== null} onOpenChange={(o) => !o && setPendingOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>This workflow has unsaved changes. Opening another one discards them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const next = pendingOpen;
                setPendingOpen(null);
                if (next) open(next.workflowId, next.version);
              }}
            >
              Discard and open
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </CanvasContext.Provider>
  );
}

export function WorkflowCanvas() {
  const [info, setInfo] = useState<WorkflowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which workflow and version to show: from the URL (?workflow=…&version=…, or ?workflowId=…), else the default's newest.
  const [selection, setSelection] = useState<{ workflow?: string; version?: number }>(() => (typeof window === 'undefined' ? {} : canvasSelection(window.location.search)));
  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (selection.workflow) params.set('workflow', selection.workflow);
    if (selection.version !== undefined) params.set('version', String(selection.version));
    try {
      setInfo(await readJson<WorkflowResponse>(await fetch(`/api/workflow-runs?${params}`, { cache: 'no-store' })));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selection]);
  useEffect(() => {
    load();
  }, [load]);
  const open = useCallback((workflow: string, version?: number) => {
    setSelection({ workflow, version });
    const url = new URL(window.location.href);
    url.searchParams.set('workflow', workflow);
    if (version === undefined) url.searchParams.delete('version');
    else url.searchParams.set('version', String(version));
    window.history.replaceState(null, '', url);
  }, []);
  // After a save, show the workflow's new newest version rather than the one it was based on.
  const reloadLatest = useCallback(async () => {
    if (info && selection.version !== undefined) open(info.workflow_id);
    else await load();
  }, [info, selection.version, open, load]);
  const [tab, setTab] = useState<Tab>('editor');
  const [logFilter, setLogFilter] = useState<LogFilter>(EMPTY_FILTER);
  const history = useRunHistory(tab !== 'editor');
  const changeTab = (next: string) => {
    // Pick up runs made in the editor since the history was loaded.
    if (next !== 'editor' && tab === 'editor' && history.loadedAt) history.reload();
    setTab(next as Tab);
  };

  if (!info) return error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />;
  return (
    <Tabs value={tab} onValueChange={changeTab} className="gap-3">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Workflows</h1>
        <TabsList>
          <TabsTrigger value="editor">
            <Workflow /> Editor
          </TabsTrigger>
          <TabsTrigger value="log">
            <ClipboardList /> Run log
          </TabsTrigger>
          <TabsTrigger value="overview">
            <BarChart3 /> Overview
          </TabsTrigger>
        </TabsList>
      </div>
      {/* Kept mounted so unsaved edits and the chosen document survive a tab switch. */}
      <TabsContent value="editor" forceMount className="data-[state=inactive]:hidden">
        <ReactFlowProvider>
          {/* Keyed by version, so switching resets the canvas to what was opened. */}
          <Editor key={`${info.workflow_id}@${info.version}`} info={info} reload={reloadLatest} refresh={load} open={open} />
        </ReactFlowProvider>
      </TabsContent>
      <TabsContent value="log">
        <RunLog history={history} filter={logFilter} setFilter={setLogFilter} />
      </TabsContent>
      <TabsContent value="overview">
        <RunsOverview
          history={history}
          openLog={(f) => {
            setLogFilter({ ...EMPTY_FILTER, ...f });
            setTab('log');
          }}
        />
      </TabsContent>
    </Tabs>
  );
}

type Tab = 'editor' | 'log' | 'overview';
